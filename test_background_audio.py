import http.client
import array
import json
import math
import queue
import shutil
import subprocess
import sys
import threading
import unittest
from unittest.mock import Mock, patch

from background_audio import BackgroundAudio, VOICE_FILTERS
from server import AppServer


class BackgroundAudioTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is optional")
    def test_voice_filters_on_silence_noise_bass_and_loud_audio(self):
        def filtered(amplitude, frequency=1000):
            samples = array.array("f", (amplitude * math.sin(2 * math.pi * frequency * i / 48000)
                                        for i in range(48000)))
            if sys.byteorder != "little":
                samples.byteswap()
            result = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0",
                "-af", VOICE_FILTERS, "-f", "f32le", "pipe:1",
            ], input=samples.tobytes(), capture_output=True, check=True, timeout=10)
            output = array.array("f")
            output.frombytes(result.stdout)
            if sys.byteorder != "little":
                output.byteswap()
            self.assertTrue(output)
            self.assertTrue(all(math.isfinite(value) for value in output))
            rms = math.sqrt(sum(value * value for value in output[-24000:]) / 24000)
            return rms, max(abs(value) for value in output)

        self.assertEqual(filtered(0), (0, 0))
        quiet, _ = filtered(0.0001)
        speech, _ = filtered(0.01)
        bass, _ = filtered(0.01, 20)
        loud, peak = filtered(0.9)
        self.assertLess(quiet / 0.0001, speech / 0.01 / 5, "expander attenuates quiet noise")
        self.assertLess(bass, speech / 10, "high-pass attenuates bass")
        self.assertLess(loud, 0.3, "compressor reduces loud audio")
        self.assertLessEqual(peak, 10 ** (-7 / 20) + 1e-6, "limiter bounds pre-encoding peaks")

    def test_capture_logs_first_audio_progress_and_exit(self):
        service = BackgroundAudio("default", "pulse", lambda: None)
        process = Mock(returncode=0)
        process.stdout.read1.side_effect = [b"audio", b"more", b""]
        service.process = process
        with patch("background_audio.time.monotonic", side_effect=[0, 1, 11]), patch(
            "builtins.print"
        ) as output:
            service._read(process, threading.Event())
        messages = [call.args[0] for call in output.call_args_list]
        self.assertIn("[audio] Input opened; receiving encoded audio", messages)
        self.assertIn("[audio] Capture active: 9 encoded bytes received", messages)
        self.assertIn("[audio] Capture ended: exit=0, 9 encoded bytes received", messages)

    def test_disabled_and_missing_ffmpeg(self):
        service = BackgroundAudio("", "pulse", lambda: None)
        with self.assertRaisesRegex(ValueError, "disabled"):
            service.start()
        service.device = "default"
        with patch("background_audio.subprocess.Popen", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(ValueError, "Install"):
                service.start()
        self.assertFalse(service.status()["running"])

    def test_slow_listeners_are_ended_without_blocking(self):
        listener = queue.Queue(maxsize=1)
        listener.put(b"stale audio")
        BackgroundAudio._end(listener)
        self.assertIsNone(listener.get_nowait())
        self.assertTrue(listener.empty())

    def test_input_listing_and_selection(self):
        service = BackgroundAudio("default", "pulse", lambda: None)
        result = Mock(stdout=json.dumps([{"name": "usb_microphone", "description": "USB microphone"}]))
        with patch("background_audio.subprocess.run", return_value=result) as run:
            self.assertEqual(service.inputs()[1], {"id": "usb_microphone", "name": "USB microphone"})
            self.assertEqual(run.call_args.args[0], ["pactl", "--format=json", "list", "sources"])
            for device in (123, "", "missing", "x" * 1025):
                with self.subTest(device=device), self.assertRaises(ValueError):
                    service.start(device)
            with patch("background_audio.subprocess.Popen", side_effect=FileNotFoundError) as launch:
                with self.assertRaisesRegex(ValueError, "Install"):
                    service.start("usb_microphone")
                arguments = launch.call_args.args[0]
                self.assertEqual(arguments[arguments.index("-i") + 1], "usb_microphone")
            service.process = Mock()
            service.process.poll.return_value = None
            with self.assertRaisesRegex(ValueError, "Stop"):
                service.start("default")

    def test_input_listing_failure_and_disabled_selection(self):
        service = BackgroundAudio("default", "pulse", lambda: None)
        with patch("background_audio.subprocess.run", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(ValueError, "Could not list"):
                service.inputs()
        disabled = BackgroundAudio("", "pulse", lambda: None)
        self.assertEqual(disabled.inputs(), [])
        with self.assertRaisesRegex(ValueError, "disabled"):
            disabled.start("default")


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is optional")
class ServiceIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.server = AppServer(("127.0.0.1", 0), "correct horse",
                                service_device="sine=frequency=440", service_format="lavfi")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.service.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, path, body, cookie=""):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("POST", path, json.dumps(body),
                           {"Content-Type": "application/json", "Cookie": cookie})
        response = connection.getresponse()
        result = (response.status, json.loads(response.read()), response.getheader("Set-Cookie"))
        connection.close()
        return result

    def signin(self, role):
        status, body, cookie = self.request("/api/session", {"role": role, "password": "correct horse"})
        self.assertEqual(status, 201, body)
        return cookie.split(";", 1)[0]

    def test_capture_survives_logout_and_streams_to_authenticated_listeners(self):
        controller = self.signin("service")
        listener = self.signin("listen")
        self.assertEqual(self.request("/api/service/start", {}, listener)[0], 403)
        self.assertEqual(self.request("/api/service/start", {})[0], 403)
        status, body, _ = self.request("/api/service/start", {}, controller)
        self.assertEqual(status, 200, body)
        self.assertTrue(body["running"])
        # Leaving the UI removes its session but must not terminate host capture.
        self.assertEqual(self.request("/api/logout", {}, controller)[0], 200)
        self.assertTrue(self.server.service.status()["running"])
        status, _, _ = self.request("/api/session", {"role": "broadcast", "password": "correct horse"})
        self.assertEqual(status, 400)

        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("GET", "/api/service/audio", headers={"Cookie": listener})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "audio/mpeg")
        self.assertTrue(response.read(1024))
        connection.close()
        new_controller = self.signin("service")
        status, body, _ = self.request("/api/service/stop", {}, new_controller)
        self.assertEqual(status, 200)
        self.assertFalse(body["running"])

    def test_browser_broadcast_prevents_service_start(self):
        browser = self.server.hub.create_session("correct horse", "broadcast")
        self.server.hub.connect(browser)
        controller = self.signin("service")
        status, body, _ = self.request("/api/service/start", {}, controller)
        self.assertEqual(status, 400)
        self.assertIn("browser microphone", body["error"])
        self.assertFalse(self.server.service.status()["running"])

    def test_input_endpoint_requires_controller_and_start_uses_selection(self):
        for password, expected in (("wrong password", 403), (None, 403), ("correct horse", 200)):
            status, body, cookie = self.request("/api/service/inputs", {"password": password})
            self.assertEqual(status, expected, body)
            self.assertIsNone(cookie, "listing inputs must not create a session")
            if expected == 200:
                self.assertEqual(body["inputs"][0]["id"], "sine=frequency=440")
        controller = self.signin("service")
        for cookie, expected in (("", 403), (self.signin("listen"), 403), (controller, 200)):
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
            connection.request("GET", "/api/service/inputs", headers={"Cookie": cookie})
            response = connection.getresponse()
            self.assertEqual(response.status, expected)
            body = json.loads(response.read())
            if expected == 200:
                self.assertEqual(body["inputs"][0]["id"], "sine=frequency=440")
            connection.close()
        status, _, _ = self.request("/api/service/start", {"device": "missing"}, controller)
        self.assertEqual(status, 400)
        with patch.object(self.server.service, "inputs", return_value=[{"id": "sine=frequency=880"}]):
            status, body, _ = self.request("/api/service/start", {"device": "sine=frequency=880"}, controller)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["device"], "sine=frequency=880")

    def test_invalid_capture_device_returns_error(self):
        self.server.service.device = "not_a_real_filter"
        controller = self.signin("service")
        status, body, _ = self.request("/api/service/start", {}, controller)
        self.assertEqual(status, 400)
        self.assertIn("capture failed", body["error"])
        self.assertFalse(self.server.service.status()["running"])


if __name__ == "__main__":
    unittest.main()
