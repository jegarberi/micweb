import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from server import Hub, RecordingStore, main


class CommandLineTests(unittest.TestCase):
    def test_list_inputs_without_password_or_server(self):
        for input_format, command in (("pulse", ["pactl", "list", "short", "sources"]),
                                      ("alsa", ["arecord", "-L"])):
            with self.subTest(input_format=input_format), patch.dict(
                "os.environ", {"SERVICE_AUDIO_FORMAT": input_format}, clear=True
            ), patch("server.subprocess.run") as run, patch("server.AppServer") as server:
                main(["--list-inputs"])
                run.assert_called_once_with(command, check=True)
                server.assert_not_called()

    @patch.dict("os.environ", {}, clear=True)
    def test_list_inputs_reports_command_failure(self):
        for error in (FileNotFoundError("pactl missing"),
                      subprocess.CalledProcessError(1, "pactl")):
            with self.subTest(error=error), patch("server.subprocess.run", side_effect=error):
                with self.assertRaisesRegex(SystemExit, "pactl"):
                    main(["--list-inputs"])

    @patch.dict("os.environ", {"SERVICE_AUDIO_FORMAT": "lavfi"}, clear=True)
    def test_list_inputs_rejects_formats_without_devices(self):
        with patch("server.subprocess.run") as run:
            with self.assertRaises(SystemExit) as error:
                main(["--list-inputs"])
            self.assertEqual(error.exception.code, 2)
            run.assert_not_called()

    @patch.dict("os.environ", {"BROADCAST_PASSWORD": "correct horse"}, clear=True)
    def test_start_service_and_default_startup(self):
        for arguments in ([], ["--start-service"]):
            with self.subTest(arguments=arguments), patch("server.AppServer") as server_class:
                server = server_class.return_value
                main(arguments)
                self.assertEqual(server.service.start.call_count, bool(arguments))
                server.serve_forever.assert_called_once()
                server.service.stop.assert_called_once()
                server.server_close.assert_called_once()

    @patch.dict("os.environ", {"BROADCAST_PASSWORD": "correct horse"}, clear=True)
    def test_failed_capture_closes_server(self):
        with patch("server.AppServer") as server_class:
            server = server_class.return_value
            server.service.start.side_effect = ValueError("capture failed")
            with self.assertRaisesRegex(SystemExit, "capture failed"):
                main(["--start-service"])
            server.serve_forever.assert_not_called()
            server.service.stop.assert_called_once()
            server.server_close.assert_called_once()


class HubTests(unittest.TestCase):
    def setUp(self):
        self.hub = Hub("correct horse")

    def test_rejects_bad_credentials_and_role(self):
        with self.assertRaises(PermissionError):
            self.hub.create_session("wrong", "listen")
        with self.assertRaises(ValueError):
            self.hub.create_session("correct horse", "admin")

    def test_relay_only_connects_opposite_roles(self):
        broadcaster = self.hub.create_session("correct horse", "broadcast")
        listener = self.hub.create_session("correct horse", "listen")
        other_listener = self.hub.create_session("correct horse", "listen")
        self.hub.connect(broadcaster)
        self.hub.connect(listener)
        self.hub.connect(other_listener)
        broadcaster.events.queue.clear()

        self.hub.relay(listener, broadcaster.peer_id, {"candidate": "local"})
        self.assertEqual(broadcaster.events.get_nowait()["peer"], listener.peer_id)
        with self.assertRaises(ValueError):
            self.hub.relay(listener, other_listener.peer_id, {"candidate": "no"})

    def test_new_broadcaster_replaces_old_session(self):
        old = self.hub.create_session("correct horse", "broadcast")
        self.hub.connect(old)
        new = self.hub.create_session("correct horse", "broadcast")
        self.assertIs(self.hub.get(old.token), old)
        self.hub.connect(new)
        self.assertIsNone(self.hub.get(old.token))
        self.assertIs(self.hub.get(new.token), new)
        self.assertEqual(old.events.get_nowait()["type"], "replaced")


class RecordingStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = RecordingStore(Path(self.temporary_directory.name))
        self.session = Hub("correct horse").create_session(
            "correct horse", "broadcast"
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_writes_recording_and_rejects_other_session(self):
        recording_id = self.store.start(self.session, "audio/webm;codecs=opus")
        self.store.append(self.session, recording_id, b"first")

        other = Hub("correct horse").create_session("correct horse", "broadcast")
        with self.assertRaises(ValueError):
            self.store.append(other, recording_id, b"stolen")

        self.store.append(self.session, recording_id, b"second")
        self.store.finish(self.session, recording_id)
        files = list(Path(self.temporary_directory.name).iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].suffix, ".webm")
        self.assertEqual(files[0].read_bytes(), b"firstsecond")

        active_id = self.store.start(self.session, "audio/mp4")
        self.store.finish_session(self.session)
        with self.assertRaises(ValueError):
            self.store.append(self.session, active_id, b"late")

    def test_rejects_unsupported_format_and_oversized_recording(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            self.store.start(self.session, "audio/wav")

        recording_id = self.store.start(self.session, "audio/ogg")
        with patch("server.MAX_RECORDING_SIZE", 3):
            with self.assertRaisesRegex(ValueError, "too large"):
                self.store.append(self.session, recording_id, b"four")


if __name__ == "__main__":
    unittest.main()
