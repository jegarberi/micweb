"""Optional host microphone capture, independent of browser sessions."""
import json
import queue
import subprocess
import threading
import time


# Browser voice-filter defaults; FFmpeg uses its own envelope algorithms.
VOICE_FILTERS = (
    "aformat=sample_rates=48000:channel_layouts=mono,"
    "highpass=f=90:p=2:t=q:w=0.7071067811865476,"
    "agate=threshold=0.0031622776601683794:ratio=2:attack=2:release=100:"
    "range=0:knee=1:detection=peak,"
    "acompressor=threshold=0.1:ratio=3:attack=3:release=60:knee=1:detection=peak,"
    "alimiter=limit=0.44668359215096315:attack=0.1:release=100:level=false,"
    "silencedetect=noise=-50dB:d=2"
)


class BackgroundAudio:
    def __init__(self, device, input_format, notify):
        if input_format not in {"pulse", "alsa", "lavfi"}:
            raise ValueError("SERVICE_AUDIO_FORMAT must be pulse, alsa, or lavfi")
        self.device = device
        self.default_device = device
        self.input_format = input_format
        self.notify = notify
        self.process = None
        self.error = ""
        self.lock = threading.Lock()
        self.commands = threading.Lock()
        self.listeners = set()

    def status(self):
        with self.lock:
            return {"enabled": bool(self.device),
                    "running": self.process is not None and self.process.poll() is None,
                    "error": self.error, "device": self.device}

    def inputs(self):
        devices = [{"id": self.default_device, "name": "Configured input (" + self.default_device + ")"}] if self.default_device else []
        if not devices or self.input_format == "lavfi":
            return devices
        try:
            command = (["pactl", "--format=json", "list", "sources"] if self.input_format == "pulse"
                       else ["arecord", "-L"])
            result = subprocess.run(command, capture_output=True, text=True, check=True, timeout=5)
            if self.input_format == "pulse":
                devices.extend({"id": source["name"], "name": source.get("description", source["name"])}
                               for source in json.loads(result.stdout) if source["name"] != self.default_device)
            else:
                devices.extend({"id": name, "name": name} for name in result.stdout.splitlines()
                               if name and not name[0].isspace() and name != self.default_device)
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
            raise ValueError("Could not list server inputs. Check the audio service and install pactl (PulseAudio) or arecord (ALSA).") from error
        return devices

    def start(self, device=None):
        with self.commands:
            if not self.device:
                raise ValueError("Background service is disabled. Configure SERVICE_AUDIO_DEVICE on the server.")
            if device is not None:
                if not isinstance(device, str) or not device or len(device) > 1024:
                    raise ValueError("Invalid input device.")
                if device != self.default_device and device not in {entry["id"] for entry in self.inputs()}:
                    raise ValueError("Input device is unavailable. Choose a listed server input.")
            if self.status()["running"]:
                if device is not None and device != self.device:
                    raise ValueError("Stop the background broadcast before changing inputs.")
                return
            if device is not None:
                self.device = device
            ready = threading.Event()
            print(f"[audio] Opening {self.input_format} input {self.device!r}", flush=True)
            try:
                process = subprocess.Popen([
                    "ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
                    *(["-re"] if self.input_format == "lavfi" else []),
                    "-f", self.input_format, "-i", self.device,
                    "-vn", "-af", VOICE_FILTERS,
                    "-ac", "1", "-ar", "48000", "-c:a", "libmp3lame",
                    "-b:a", "128k", "-f", "mp3", "-write_xing", "0",
                    "-id3v2_version", "0", "-flush_packets", "1", "pipe:1",
                ], stdout=subprocess.PIPE, stderr=None)
            except OSError as error:
                raise ValueError("Could not launch ffmpeg. Install it on the server host.") from error
            with self.lock:
                self.process = process
                self.error = ""
            threading.Thread(target=self._read, args=(process, ready), daemon=True).start()
            if not ready.wait(5) or not self.status()["running"]:
                self._stop()
                raise ValueError("Microphone capture failed. Check the configured device and server logs.")

    def _read(self, process, ready):
        total_bytes = 0
        last_log = time.monotonic()
        try:
            while data := process.stdout.read1(1024):
                now = time.monotonic()
                if not total_bytes:
                    print("[audio] Input opened; receiving encoded audio", flush=True)
                total_bytes += len(data)
                if now - last_log >= 10:
                    print(f"[audio] Capture active: {total_bytes} encoded bytes received", flush=True)
                    last_log = now
                ready.set()
                with self.lock:
                    if self.process is not process:
                        break
                    for listener in list(self.listeners):
                        try:
                            listener.put_nowait(data)
                        except queue.Full:
                            self._end(listener)
                            self.listeners.discard(listener)
        finally:
            process.stdout.close()
            process.wait()
            print(f"[audio] Capture ended: exit={process.returncode}, {total_bytes} encoded bytes received", flush=True)
            with self.lock:
                if self.process is process:
                    self.process = None
                    self.error = "Microphone capture stopped. Check the device and server logs."
                    for listener in self.listeners:
                        self._end(listener)
                    self.listeners.clear()
            ready.set()
            self.notify()

    @staticmethod
    def _end(listener):
        while True:
            try:
                listener.get_nowait()
            except queue.Empty:
                break
        listener.put_nowait(None)

    def subscribe(self):
        with self.lock:
            if self.process is None or self.process.poll() is not None:
                raise ValueError("The background broadcast is not running.")
            listener = queue.Queue(maxsize=64)
            self.listeners.add(listener)
            return listener

    def unsubscribe(self, listener):
        with self.lock:
            self.listeners.discard(listener)

    def _stop(self):
        with self.lock:
            process = self.process
            self.process = None
            self.error = ""
            for listener in self.listeners:
                self._end(listener)
            self.listeners.clear()
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def stop(self):
        with self.commands:
            self._stop()
        self.notify()
