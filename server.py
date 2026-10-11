#!/usr/bin/env python3
import argparse
import hmac
import json
import mimetypes
import os
import queue
import secrets
import ssl
import subprocess
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from background_audio import BackgroundAudio


ROOT = Path(__file__).parent
STATIC = ROOT / "static"
MAX_BODY = 64 * 1024
MAX_RECORDING_CHUNK = 2 * 1024 * 1024
MAX_RECORDING_SIZE = 512 * 1024 * 1024
SESSION_TTL = 12 * 60 * 60


@dataclass
class Session:
    token: str
    peer_id: str
    role: str
    created_at: float = field(default_factory=time.time)
    connected: bool = False
    events: queue.Queue = field(default_factory=queue.Queue)


class Hub:
    def __init__(self, password: str):
        self.password = password
        self.sessions: dict[str, Session] = {}
        self.lock = threading.Lock()
        self.service = None

    def create_session(self, supplied_password: object, role: object) -> Session:
        if role not in {"broadcast", "listen", "service", "conference"}:
            raise ValueError("Choose broadcast, listen, conference, or service.")
        if not isinstance(supplied_password, str) or not hmac.compare_digest(
            supplied_password, self.password
        ):
            raise PermissionError("Incorrect password.")

        now = time.time()
        session = Session(secrets.token_urlsafe(32), secrets.token_urlsafe(9), role)
        with self.lock:
            self._prune(now)
            if role == "broadcast" and self.service and self.service.status()["running"]:
                raise ValueError("Stop the background broadcast before using the browser microphone.")
            self.sessions[session.token] = session
        return session

    def get(self, token: str | None) -> Session | None:
        if not token:
            return None
        with self.lock:
            session = self.sessions.get(token)
            if not session or time.time() - session.created_at > SESSION_TTL:
                self.sessions.pop(token, None)
                return None
            return session

    def connect(self, session: Session) -> None:
        with self.lock:
            if session.role == "broadcast" and self.service and self.service.status()["running"]:
                raise ValueError("Stop the background broadcast before using the browser microphone.")
            if session.role == "broadcast":
                for token, current in list(self.sessions.items()):
                    if current is not session and current.role == "broadcast" and current.connected:
                        current.events.put({"type": "replaced"})
                        del self.sessions[token]
            # shortcut: conference uses a peer mesh; use a media relay for large rooms.
            if session.role == "conference":
                for current in self.sessions.values():
                    if current is not session and current.role == "conference" and current.connected:
                        current.events.put({"type": "peer-joined", "peer": session.peer_id})
            session.connected = True
            if session.role == "listen":
                broadcaster = self._broadcaster()
                if broadcaster:
                    broadcaster.events.put({"type": "peer-joined", "peer": session.peer_id})
            elif session.role == "broadcast":
                for listener in self.sessions.values():
                    if listener.role == "listen" and listener.connected:
                        session.events.put({"type": "peer-joined", "peer": listener.peer_id})

    def service_status(self):
        with self.lock:
            event = {"type": "service-status", **self.service.status()}
            for session in self.sessions.values():
                if session.connected and session.role in {"listen", "service"}:
                    session.events.put(event)

    def disconnect(self, session: Session) -> None:
        with self.lock:
            if not session.connected:
                return
            session.connected = False
            if session.role == "conference":
                for current in self.sessions.values():
                    if current.role == "conference" and current.connected:
                        current.events.put({"type": "peer-left", "peer": session.peer_id})
            if session.role == "listen":
                broadcaster = self._broadcaster()
                if broadcaster:
                    broadcaster.events.put({"type": "peer-left", "peer": session.peer_id})

    def remove(self, session: Session) -> None:
        self.disconnect(session)
        with self.lock:
            self.sessions.pop(session.token, None)

    def relay(self, sender: Session, destination_id: object, data: object) -> None:
        if not isinstance(destination_id, str) or not isinstance(data, dict):
            raise ValueError("Invalid signal.")
        with self.lock:
            destination = next(
                (item for item in self.sessions.values() if item.peer_id == destination_id),
                None,
            )
            if (not destination or not destination.connected
                    or destination is sender
                    or not ({sender.role, destination.role} == {"broadcast", "listen"}
                            or sender.role == destination.role == "conference")):
                raise ValueError("Peer is unavailable.")
            destination.events.put(
                {"type": "signal", "peer": sender.peer_id, "data": data}
            )

    def _broadcaster(self) -> Session | None:
        return next(
            (
                item
                for item in self.sessions.values()
                if item.role == "broadcast" and item.connected
            ),
            None,
        )

    def _prune(self, now: float) -> None:
        for token, session in list(self.sessions.items()):
            if now - session.created_at > SESSION_TTL:
                del self.sessions[token]


class RecordingStore:
    EXTENSIONS = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a"}

    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.directory = directory
        self.recordings: dict[str, tuple[str, Path, int]] = {}
        self.lock = threading.Lock()

    def start(self, session: Session, content_type: str) -> str:
        extension = self.EXTENSIONS.get(content_type.split(";", 1)[0].lower())
        if not extension:
            raise ValueError("Unsupported recording format.")
        recording_id = secrets.token_urlsafe(18)
        timestamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        path = self.directory / f"{timestamp}-{recording_id}{extension}"
        path.touch(mode=0o600, exist_ok=False)
        with self.lock:
            self.recordings[recording_id] = (session.token, path, 0)
        return recording_id

    def append(self, session: Session, recording_id: str, data: bytes) -> None:
        with self.lock:
            recording = self.recordings.get(recording_id)
            if not recording or recording[0] != session.token:
                raise ValueError("Recording is unavailable.")
            size = recording[2] + len(data)
            if size > MAX_RECORDING_SIZE:
                del self.recordings[recording_id]
                raise ValueError("Recording is too large.")
            with recording[1].open("ab") as output:
                output.write(data)
            self.recordings[recording_id] = (session.token, recording[1], size)

    def finish(self, session: Session, recording_id: str) -> None:
        with self.lock:
            recording = self.recordings.get(recording_id)
            if not recording or recording[0] != session.token:
                raise ValueError("Recording is unavailable.")
            del self.recordings[recording_id]

    def finish_session(self, session: Session) -> None:
        with self.lock:
            for recording_id, recording in list(self.recordings.items()):
                if recording[0] == session.token:
                    del self.recordings[recording_id]


class AppHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LocalCast"

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/events":
            self._events()
        elif path == "/api/service/audio":
            self._service_audio()
        elif path == "/api/service/inputs":
            self._service_inputs()
        elif path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
        elif path in {"/", "/app.js", "/style.css", "/voice-processor.js"}:
            self._static("/index.html" if path == "/" else path)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/session":
            self._create_session()
        elif path == "/api/service/inputs":
            self._service_inputs()
        elif path in {"/api/service/start", "/api/service/stop"}:
            self._service_command(path.rsplit("/", 1)[1])
        elif path == "/api/signal":
            self._signal()
        elif path == "/api/recording/start":
            self._start_recording()
        elif path == "/api/recording/chunk":
            self._recording_chunk()
        elif path == "/api/recording/stop":
            self._stop_recording()
        elif path == "/api/logout":
            self._logout()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def _create_session(self) -> None:
        try:
            body = self._read_json()
            session = self.server.hub.create_session(body.get("password"), body.get("role"))
        except PermissionError as error:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": str(error)})
            return
        except (ValueError, AttributeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        secure = os.getenv("COOKIE_SECURE") == "1" or self.headers.get(
            "X-Forwarded-Proto"
        ) == "https"
        cookie = (
            f"session={session.token}; HttpOnly; SameSite=Strict; Path=/; "
            f"Max-Age={SESSION_TTL}"
        )
        if secure:
            cookie += "; Secure"
        self._json(
            HTTPStatus.CREATED,
            {
                "id": session.peer_id,
                "role": session.role,
                "serverRecording": bool(self.server.recordings),
                "service": self.server.service.status(),
            },
            {"Set-Cookie": cookie},
        )

    def _signal(self) -> None:
        session = self._session()
        if not session:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Sign in again."})
            return
        try:
            body = self._read_json()
            self.server.hub.relay(session, body.get("to"), body.get("data"))
        except (ValueError, AttributeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._json(HTTPStatus.ACCEPTED, {"ok": True})

    def _service_inputs(self):
        if self.command == "POST":
            try:
                password = self._read_json().get("password")
            except ValueError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            if not isinstance(password, str) or not hmac.compare_digest(password, self.server.hub.password):
                self._json(HTTPStatus.FORBIDDEN, {"error": "Incorrect password."})
                return
        session = self._session()
        if self.command != "POST" and (not session or session.role != "service"):
            self._json(HTTPStatus.FORBIDDEN, {"error": "Background service control access required."})
            return
        try:
            self._json(HTTPStatus.OK, {"inputs": self.server.service.inputs()})
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def _service_command(self, command):
        session = self._session()
        if not session or session.role != "service":
            self._json(HTTPStatus.FORBIDDEN, {"error": "Background service control access required."})
            return
        try:
            body = self._read_json()
            if command == "start":
                with self.server.hub.lock:
                    if self.server.hub._broadcaster():
                        raise ValueError("A browser microphone is broadcasting. Leave that broadcast first.")
                    self.server.service.start(body.get("device"))
                self.server.hub.service_status()
            else:
                self.server.service.stop()
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._json(HTTPStatus.OK, self.server.service.status())

    def _service_audio(self):
        session = self._session()
        if not session or session.role != "listen":
            self._json(HTTPStatus.FORBIDDEN, {"error": "Listener access required."})
            return
        try:
            listener = self.server.service.subscribe()
        except ValueError as error:
            self._json(HTTPStatus.CONFLICT, {"error": str(error)})
            return
        self.close_connection = True
        self.connection.settimeout(10)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._security_headers()
        self.end_headers()
        try:
            while self.server.hub.get(session.token) is session:
                try:
                    data = listener.get(timeout=5)
                except queue.Empty:
                    continue
                if data is None:
                    break
                self.wfile.write(data)
                self.wfile.flush()
        except (OSError, TimeoutError):
            pass
        finally:
            self.server.service.unsubscribe(listener)

    def _recording_session(self) -> Session | None:
        session = self._session()
        if not session or session.role != "broadcast":
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Broadcaster access required."})
            return None
        if not self.server.recordings:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Server recording is disabled."})
            return None
        return session

    def _start_recording(self) -> None:
        session = self._recording_session()
        if not session:
            return
        try:
            body = self._read_json()
            recording_id = self.server.recordings.start(session, body.get("type", ""))
        except (ValueError, AttributeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._json(HTTPStatus.CREATED, {"id": recording_id})

    def _recording_chunk(self) -> None:
        session = self._recording_session()
        if not session:
            return
        try:
            recording_id = self.headers.get("X-Recording-ID", "")
            self.server.recordings.append(
                session, recording_id, self._read_body(MAX_RECORDING_CHUNK)
            )
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._json(HTTPStatus.ACCEPTED, {"ok": True})

    def _stop_recording(self) -> None:
        session = self._recording_session()
        if not session:
            return
        try:
            body = self._read_json()
            self.server.recordings.finish(session, body.get("id", ""))
        except (ValueError, AttributeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._json(HTTPStatus.OK, {"ok": True})

    def _logout(self) -> None:
        self.close_connection = True
        session = self._session()
        if session:
            if self.server.recordings:
                self.server.recordings.finish_session(session)
            self.server.hub.remove(session)
        self._json(
            HTTPStatus.OK,
            {"ok": True},
            {"Set-Cookie": "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"},
        )

    def _events(self) -> None:
        session = self._session()
        if not session:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Sign in again."})
            return
        try:
            self.server.hub.connect(session)
        except ValueError as error:
            self._json(HTTPStatus.CONFLICT, {"error": str(error)})
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self._security_headers()
        self.end_headers()
        if session.role in {"listen", "service"}:
            session.events.put({"type": "service-status", **self.server.service.status()})
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                event = None
                try:
                    event = session.events.get(timeout=15)
                    payload = f"data: {json.dumps(event, separators=(',', ':'))}\n\n"
                except queue.Empty:
                    if self.server.hub.get(session.token) is not session:
                        break
                    payload = ": keepalive\n\n"
                self.wfile.write(payload.encode())
                self.wfile.flush()
                if event and event.get("type") == "replaced":
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.server.hub.disconnect(session)

    def _static(self, path: str) -> None:
        file_path = STATIC / path.removeprefix("/")
        try:
            data = file_path.read_bytes()
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        data = self._read_body(MAX_BODY)
        try:
            body = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("Invalid JSON.") from error
        if not isinstance(body, dict):
            raise ValueError("Invalid JSON.")
        return body

    def _read_body(self, maximum: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid request size.") from error
        if not 0 < length <= maximum:
            raise ValueError("Invalid request size.")
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError("Incomplete request body.")
        return data

    def _session(self) -> Session | None:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        token = cookie.get("session")
        return self.server.hub.get(token.value if token else None)

    def _json(self, status: HTTPStatus, value: dict, headers: dict | None = None) -> None:
        data = json.dumps(value).encode()
        if status >= HTTPStatus.BAD_REQUEST:
            self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        for name, content in (headers or {}).items():
            self.send_header(name, content)
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; connect-src 'self'; media-src 'self' blob:; "
            "style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        )

    def log_message(self, message: str, *args: object) -> None:
        print(f"{self.address_string()} - {message % args}")


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self, address: tuple[str, int], password: str, recordings_dir: Path | None = None,
        service_device: str = "", service_format: str = "pulse"
    ):
        super().__init__(address, AppHandler)
        self.hub = Hub(password)
        self.service = BackgroundAudio(service_device, service_format, self.hub.service_status)
        self.hub.service = self.service
        self.recordings = RecordingStore(recordings_dir) if recordings_dir else None


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Serve the LocalCast web page and audio broadcast.")
    parser.add_argument("--start-service", action="store_true",
                        help="Start host microphone capture immediately (requires SERVICE_AUDIO_DEVICE).")
    parser.add_argument("--list-inputs", action="store_true",
                        help="List audio inputs for SERVICE_AUDIO_FORMAT (pulse by default) and exit.")
    args = parser.parse_args(argv)
    if args.list_inputs:
        input_format = os.getenv("SERVICE_AUDIO_FORMAT", "pulse")
        if input_format == "pulse":
            command = ["pactl", "list", "short", "sources"]
            print("Use the source name in column 2 as SERVICE_AUDIO_DEVICE.", flush=True)
        elif input_format == "alsa":
            command = ["arecord", "-L"]
            print("Use an unindented device name as SERVICE_AUDIO_DEVICE (SERVICE_AUDIO_FORMAT=alsa).", flush=True)
        else:
            parser.error("--list-inputs requires SERVICE_AUDIO_FORMAT=pulse or alsa")
        try:
            subprocess.run(command, check=True)
        except OSError as error:
            raise SystemExit(f"Could not run {command[0]}: {error}") from error
        except subprocess.CalledProcessError as error:
            raise SystemExit(f"{command[0]} could not list audio inputs; check the host audio service and permissions.") from error
        return
    password = os.getenv("BROADCAST_PASSWORD", "")
    if len(password) < 8:
        raise SystemExit("BROADCAST_PASSWORD must contain at least 8 characters")
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8080"))
    recordings_dir = os.getenv("RECORDINGS_DIR")
    server = AppServer(
        (host, port), password, Path(recordings_dir).expanduser() if recordings_dir else None,
        os.getenv("SERVICE_AUDIO_DEVICE", ""), os.getenv("SERVICE_AUDIO_FORMAT", "pulse")
    )
    cert, key = os.getenv("TLS_CERT"), os.getenv("TLS_KEY")
    if cert and key:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    try:
        if args.start_service:
            try:
                server.service.start()
            except ValueError as error:
                raise SystemExit(str(error)) from error
        scheme = "https" if cert and key else "http"
        print(f"LocalCast listening on {scheme}://{host}:{server.server_port}", flush=True)
        server.serve_forever()
    finally:
        server.service.stop()
        server.server_close()


if __name__ == "__main__":
    main()
