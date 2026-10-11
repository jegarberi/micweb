# LocalCast

A small password-protected audio broadcast app. One browser shares its microphone and every connected listener receives the live WebRTC stream. It has no application dependencies or third-party services.

## Run with Docker

Create a `.env` file:

```text
BROADCAST_PASSWORD=choose-a-long-password
```

Then start the app:

```sh
docker compose up --build
```

Open <http://localhost:8080>. Choose **Broadcast** on one browser and **Listen** on the others, then enter the same password.

Select **Remember password on this device** to fill it in on future visits. It is saved after successful sign-in in this browser's local storage, without encryption. Use only on a trusted device; uncheck the option to delete the saved password.

Both broadcasters and listeners can select **Waveform**, **Spectrum**, **Level meter**, or **Off** in the studio. Visualizations use the live microphone or received audio and do not change playback or recordings.

## Conference

Choose **Conference** on each participant's browser and enter the shared password. Everyone in Conference sends their microphone and hears all other conference participants at the same time. Use headphones to avoid feedback. Microphone access requires HTTPS or localhost.

Voice filters apply to your outgoing microphone. The visualization shows your microphone; **Save a recording on this device** records your voice and the other participants together. Server recording is available only for Broadcast. Conference is separate from Broadcast/Listen and Background service audio.

Conference uses direct WebRTC connections between every pair of participants, without STUN or TURN, and is intended for small groups on the same local network. Each additional participant increases the connections and audio upload needed on every device.

## Background audio

### Optional background service

Choose **Background service** at sign-in to control capture from the **server host's microphone**, instead of the browser microphone. Click **Start background broadcast**; listeners join with **Listen** as usual. Closing the control page or clicking **Leave** does not stop capture. Rejoin the controls and click **Stop background broadcast** to stop it. Anyone with the shared password can control this microphone.

Selecting **Background service** at sign-in reveals **Server input device**. Enter the password to load the server's inputs automatically, or click **Load server inputs**, then choose a microphone and join. You can also change the selection in the background controls before starting. Stop a running broadcast before changing inputs. Listing requires `pactl` for PulseAudio/PipeWire (included in the Docker image), or `arecord` for ALSA. If listing fails, the configured input remains available.

Docker Compose enables this mode on a Linux host running PulseAudio or PipeWire's PulseAudio compatibility service. The image includes FFmpeg and mounts the host's audio socket. Run Compose as the desktop user whose microphone you want to capture. If that user's UID is not 1000, add `AUDIO_UID=<output of id -u>` to `.env`; if `XDG_RUNTIME_DIR` is not exported, also add `XDG_RUNTIME_DIR=/run/user/<uid>`. Rebuild with `docker compose up --build`, then choose **Background service** and click **Start background broadcast**. Capture uses the default input; set `SERVICE_AUDIO_DEVICE` in `.env` to select another source, or set it empty to disable the controls. The host audio service must be running when Compose starts.

Existing recordings volumes created by the old image belong to UID 10001. If server recording is enabled, update that volume's ownership to `AUDIO_UID` before using the rebuilt image.

Compose also exposes `/dev/snd` and adds the container user to the host audio group. Set `AUDIO_GID` in `.env` to the numeric group owning the host's `/dev/snd` devices (default 18; check with `ls -ln /dev/snd`). For direct ALSA capture, set `SERVICE_AUDIO_FORMAT=alsa` and `SERVICE_AUDIO_DEVICE=hw:0,0` (or your input's ALSA name), then rebuild. The image includes `arecord` for the input selector. Direct ALSA capture may fail if PulseAudio or PipeWire already has the device open. Compose requires `/dev/snd` and the configured PulseAudio socket to exist on the host, even when selecting ALSA.

When running without Docker, this mode is disabled by default. On a Linux host with FFmpeg installed and access to PulseAudio (or PipeWire's PulseAudio compatibility service), run:

```sh
BROADCAST_PASSWORD='choose-a-long-password' SERVICE_AUDIO_DEVICE=default python server.py
```

List available input devices without starting the server or supplying a password:

```sh
python server.py --list-inputs
```

For PulseAudio or PipeWire, use the source name in the second column as `SERVICE_AUDIO_DEVICE`. This command requires `pactl` on the microphone host. For ALSA, run `SERVICE_AUDIO_FORMAT=alsa python server.py --list-inputs` (requires `arecord`) and use an unindented device name with `SERVICE_AUDIO_FORMAT=alsa`. Compose uses PulseAudio by default and also supports ALSA through `/dev/snd`.

Start capture immediately from the command line while serving the web page:

```sh
BROADCAST_PASSWORD='choose-a-long-password' SERVICE_AUDIO_DEVICE=default python server.py --start-service
```

Server logs show the input being opened, the first encoded audio received, and a byte count every 10 seconds while capture continues. FFmpeg also reports input details and `silence_start` / `silence_end` when the signal stays below -50 dB for two seconds or returns above it. Encoded bytes confirm capture is flowing even when the microphone is silent.

Replace `default` with the input name from `--list-inputs` to select a specific microphone.

Open <http://localhost:8080> or `http://<server-ip>:8080` on another device and choose **Listen**. Set `HOST` and `PORT` to change the default bind address (`0.0.0.0:8080`). The page's **Background service** controls can stop or restart capture. Ctrl+C stops the server and capture; failed capture startup exits with an error.

To keep the server running independently of a terminal, install the supplied user service (adjust its working directory and executable if this checkout is not `~/micweb`):

```sh
mkdir -p ~/.config/systemd/user
cp deploy/localcast.service ~/.config/systemd/user/localcast.service
```

Create `~/.config/localcast.env` with:

```text
BROADCAST_PASSWORD=choose-a-long-password
SERVICE_AUDIO_DEVICE=default
```

Then run:

```sh
chmod 600 ~/.config/localcast.env
systemctl --user daemon-reload
systemctl --user enable --now localcast.service
```

The host must stay powered on with its audio service available. This captures its microphone, not a microphone on a remote phone. Capture starts after the Start command or at launch with `--start-service`. Service audio is streamed through the authenticated server as MP3 and supports listener visualizations, including a flat waveform during silence. Browser voice filters and recording options apply only to browser broadcasts. Stop a service broadcast before starting a browser broadcast, and leave a browser broadcast before starting the service.

### Browser background behavior

Audio transmission, playback, and recording continue independently of the visualizer when you switch tabs. Where supported, LocalCast declares a playback or microphone audio session and requests a screen wake lock while joined. It releases the lock on Leave and reacquires it when the page becomes visible, also resuming interrupted audio. If playback is blocked, use **Enable sound**.

Screen wake locks require HTTPS or localhost and only keep visible pages awake. Browsers and mobile operating systems can still suspend hidden pages, microphone capture, or audio when the screen is locked. For reliable broadcasting, keep the page visible and the device awake; the studio shows whether a wake lock was granted.

## Broadcaster voice filters

The broadcaster studio processes microphone audio in this order: high-pass filter → 2:1 downward expander → compressor → peak limiter. Listeners, visualizations, and recordings receive that output. Each stage can be disabled, and settings can be changed live.

Defaults: 90 Hz / 12 dB per octave HPF; −50 dB expander threshold; compressor at −20 dB, 3:1, 3 ms attack and 60 ms release; limiter ceiling −7 dB. Select 24 dB per octave for a steeper HPF. Browser automatic gain control is disabled; echo cancellation and noise suppression remain enabled.

The Python server microphone applies the same default stages before MP3 encoding using FFmpeg: 90 Hz / 12 dB per octave high-pass, 2:1 downward expander at −50 dB (2 ms attack, 100 ms release), compressor at −20 dB (3:1, 3 ms attack, 60 ms release), and limiter at −7 dB with automatic makeup gain disabled. Server settings are fixed; the browser controls only change browser broadcasts. FFmpeg's dynamics algorithms differ from the browser processor, and MP3 encoding can produce decoded peaks above the pre-encoding limiter ceiling.

Use **Bypass all processing** and **Processed output trim** to compare at similar perceived loudness through a listener wearing headphones. Adjust trim manually; it is not automatic loudness normalization. Check in the full mix and lower the HPF cutoff if the voice loses body. Bypass affects the broadcast and recordings and also bypasses the limiter. Voice processing requires AudioWorklet support over HTTPS or localhost.

## Record audio

Select **Save a recording on this device** before joining to download that browser's audio when you click **Leave**. This works for broadcasters and listeners and keeps the recording in the browser until it is downloaded.

To also offer **Save a recording on the server** to broadcasters, set this in `.env`:

```text
RECORDINGS_DIR=/recordings
```

Docker stores these files in the `recordings` volume. Copy them to the current directory with:

```sh
docker compose cp localcast:/recordings/. ./recordings
```

Without Docker, set `RECORDINGS_DIR` to any writable local directory. Server recordings are written as they arrive and each recording is limited to 512 MiB.

## Run without Docker

Python 3.11 or newer is enough:

```sh
BROADCAST_PASSWORD='choose-a-long-password' python server.py
```

Run the checks with:

```sh
python -m unittest -v
node tests/visualization.cjs
node tests/voice-processing.cjs
node tests/background.cjs
node tests/password.cjs
node tests/conference.cjs
```

## Network notes

- The app deliberately uses no STUN, TURN, CDN, database, or package dependency. Live audio travels directly between browsers, so it is intended for the same local network. When server recording is selected, the broadcaster also uploads an encoded copy to the configured recording directory.
- Optional service broadcasts use FFmpeg on the host and stream audio through the server instead of WebRTC.
- Browsers allow microphone capture on `localhost`. For a broadcaster opening the app from another device or a LAN hostname, serve it over HTTPS. The server supports TLS when both `TLS_CERT` and `TLS_KEY` point to mounted PEM files. A reverse proxy on the same network also works.
- Sessions live in memory and expire after 12 hours. Restarting the container signs everyone out.
- One broadcaster is active at a time. A new broadcaster replaces the previous one.
