const signin = document.querySelector("#signin");
const studio = document.querySelector("#studio");
const form = document.querySelector("#join-form");
const errorText = document.querySelector("#form-error");
const joinButton = document.querySelector("#join-button");
const passwordInput = document.querySelector("#password");
const rememberPassword = document.querySelector("#remember-password");
const rememberPasswordNote = document.querySelector("#remember-password-note");

function restorePassword() {
  try {
    const saved = localStorage.getItem("localcast-password");
    if (saved) {
      passwordInput.value = saved;
      rememberPassword.checked = true;
    }
  } catch {
    rememberPassword.checked = false;
    rememberPassword.disabled = true;
    rememberPasswordNote.textContent = "Password storage is unavailable in this browser.";
  }
}

function savePassword() {
  try {
    if (rememberPassword.checked) localStorage.setItem("localcast-password", passwordInput.value);
    else localStorage.removeItem("localcast-password");
  } catch {
    rememberPasswordNote.textContent = "Could not update the saved password. Check browser storage settings.";
  }
}

restorePassword();
rememberPassword.addEventListener("change", () => {
  if (!rememberPassword.checked) savePassword();
});
const title = document.querySelector("#studio-title");
const modeLabel = document.querySelector("#mode-label");
const statusText = document.querySelector("#connection-status");
const audio = document.querySelector("#audio");
const audioButton = document.querySelector("#audio-button");
const leaveButton = document.querySelector("#leave-button");
const recordLocal = document.querySelector("#record-local");
const recordServer = document.querySelector("#record-server");
const recordServerOption = document.querySelector("#record-server-option");
const recordingStatus = document.querySelector("#recording-status");
const visualizationMode = document.querySelector("#visualization-mode");
const visualization = document.querySelector("#visualization");
const visualizationStatus = document.querySelector("#visualization-status");
const voiceFilters = document.querySelector("#voice-filters");
let microphoneStream;
let voiceNodes = [];
let voiceProcessor;
let highPass;
let highPassSecond;

function updateVoiceFilters() {
  if (!voiceProcessor) return;
  const value = (id) => Number(document.querySelector(`#filter-${id}`).value);
  if ([...voiceFilters.querySelectorAll('input[type="number"]')].some((input) => !input.checkValidity())) return;
  const enabled = (id) => document.querySelector(`#${id}-enabled`).checked;
  highPass.type = highPassSecond.type = "highpass";
  highPass.frequency.setTargetAtTime(enabled("hpf") ? value("cutoff") : 0, audioContext.currentTime, 0.01);
  highPassSecond.frequency.setTargetAtTime(enabled("hpf") && value("slope") === 24 ? value("cutoff") : 0, audioContext.currentTime, 0.01);
  const fourthOrder = value("slope") === 24;
  highPass.Q.value = fourthOrder ? 0.5411961 : Math.SQRT1_2;
  highPassSecond.Q.value = 1.306563;
  voiceProcessor.port.postMessage({
    bypass: document.querySelector("#filter-bypass").checked,
    gate: enabled("gate"), compressor: enabled("compressor"), limiter: enabled("limiter"),
    gateThreshold: value("gate-threshold"), threshold: value("threshold"), ratio: value("ratio"),
    attack: value("attack"), release: value("release"), ceiling: value("ceiling"), trim: value("trim"),
  });
}
voiceFilters.addEventListener("input", updateVoiceFilters);

async function startVoiceProcessing(stream) {
  if (!audioContext?.audioWorklet) throw new Error("Voice filters require a browser with AudioWorklet support.");
  await audioContext.resume();
  await audioContext.audioWorklet.addModule("/voice-processor.js");
  const source = audioContext.createMediaStreamSource(stream);
  highPass = audioContext.createBiquadFilter();
  highPassSecond = audioContext.createBiquadFilter();
  voiceProcessor = new AudioWorkletNode(audioContext, "voice-processor", {
    numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
  });
  const destination = audioContext.createMediaStreamDestination();
  voiceNodes = [source, highPass, highPassSecond, voiceProcessor, destination];
  source.connect(highPass).connect(highPassSecond).connect(voiceProcessor, 0, 0);
  source.connect(voiceProcessor, 0, 1);
  voiceProcessor.connect(destination);
  voiceProcessor.onprocessorerror = () => leave("Voice processing stopped. Rejoin to restart the microphone.");
  updateVoiceFilters();
  return destination.stream;
}

function stopVoiceProcessing() {
  voiceNodes.forEach((node) => node.disconnect());
  voiceNodes = [];
  if (voiceProcessor) { voiceProcessor.onprocessorerror = null; voiceProcessor.port.close(); }
  voiceProcessor = undefined;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = undefined;
}

let audioContext;
let visualizationSource;
let serviceAudioSource;
let analyser;
let visualizationFrame;

function resumeVisualization() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume().then(() => {
      visualizationStatus.textContent = "";
    }).catch(() => { visualizationStatus.textContent = "Select a visualization to enable it."; });
  } catch {
    visualizationStatus.textContent = "Audio visualization is unavailable in this browser.";
  }
}

function startVisualization(stream) {
  stopVisualization();
  if (!audioContext) return;
  if (stream) {
    visualizationSource = audioContext.createMediaStreamSource(stream);
  } else {
    serviceAudioSource ||= audioContext.createMediaElementSource(audio);
    visualizationSource = serviceAudioSource;
    visualizationSource.connect(audioContext.destination);
  }
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  visualizationSource.connect(analyser);
  drawVisualization();
}

function stopVisualization() {
  cancelAnimationFrame(visualizationFrame);
  visualizationSource?.disconnect();
  analyser?.disconnect();
  visualizationSource = undefined;
  analyser = undefined;
  visualization.getContext("2d").clearRect(0, 0, visualization.width, visualization.height);
}

function drawVisualization() {
  cancelAnimationFrame(visualizationFrame);
  visualization.hidden = visualizationMode.value === "off";
  visualization.setAttribute("aria-label", `Live audio ${visualizationMode.selectedOptions[0].textContent.toLowerCase()}`);
  if (!analyser || visualization.hidden) return;
  const samples = new Uint8Array(analyser.fftSize);
  const context = visualization.getContext("2d");
  const { width, height } = visualization;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let lastDraw = -Infinity;
  function draw(time) {
    visualizationFrame = requestAnimationFrame(draw);
    if (document.hidden || (reducedMotion.matches && time - lastDraw < 250)) return;
    lastDraw = time;
    context.clearRect(0, 0, width, height);
    context.fillStyle = context.strokeStyle = getComputedStyle(visualization).getPropertyValue("--accent");
    if (visualizationMode.value === "spectrum") {
      analyser.getByteFrequencyData(samples);
      const bars = 64;
      for (let i = 0; i < bars; i++) {
        const start = Math.floor(Math.pow(analyser.frequencyBinCount, i / bars)) - 1;
        const end = Math.floor(Math.pow(analyser.frequencyBinCount, (i + 1) / bars));
        let peak = 0;
        for (let bin = start; bin < end; bin++) peak = Math.max(peak, samples[bin]);
        const barHeight = peak / 255 * height;
        context.fillRect(i * width / bars, height - barHeight, width / bars - 3, barHeight);
      }
    } else {
      analyser.getByteTimeDomainData(samples);
      if (visualizationMode.value === "level") {
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
        context.fillRect(0, height / 3, Math.min(1, rms) * width, height / 3);
      } else {
        context.lineWidth = 2;
        context.beginPath();
        samples.forEach((value, i) => {
          const x = i / (samples.length - 1) * width;
          const y = value / 256 * height;
          if (i === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      }
    }
  }
  draw(0);
}

visualizationMode.addEventListener("change", () => {
  resumeVisualization();
  drawVisualization();
});

let role;
let localStream;
let conferenceOutput;
let conferenceRecording;
const conferenceSources = new Map();
let events;
let recorder;
let localRecording = false;
let serverRecording = false;
let serverRecordingId;
let recordingChunks = [];
let uploadQueue = Promise.resolve();
let leaving = false;
const peers = new Map();
const serviceStart = document.querySelector("#service-start");
const serviceStop = document.querySelector("#service-stop");
const serviceInputField = document.querySelector("#service-input-field");
const serviceInput = document.querySelector("#service-input");
const joinServiceInputField = document.querySelector("#join-service-input-field");
const joinServiceInput = document.querySelector("#join-service-input");
const loadServiceInputs = document.querySelector("#load-service-inputs");
let serviceListening = false;
let wakeLock;
let requestingWakeLock = false;
const backgroundStatus = document.querySelector("#background-status");

function setAudioSession(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch {
    // Audio session hints are optional and must not prevent joining.
  }
}

async function keepScreenAwake() {
  if (studio.hidden || leaving || role === "service" || document.hidden || wakeLock || requestingWakeLock) return;
  if (!navigator.wakeLock) {
    backgroundStatus.textContent = "Keep this page visible and your device awake for reliable audio.";
    return;
  }
  requestingWakeLock = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (studio.hidden || leaving || document.hidden) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    backgroundStatus.textContent = "Keeping the screen awake during this session.";
    lock.addEventListener("release", () => {
      if (wakeLock !== lock) return;
      wakeLock = undefined;
      backgroundStatus.textContent = "Screen wake lock released. Keep your device awake for reliable audio.";
    });
  } catch {
    backgroundStatus.textContent = "Could not keep the screen awake. Keep your device awake for reliable audio.";
  } finally {
    requestingWakeLock = false;
  }
}

function restoreAudio() {
  if (studio.hidden || leaving || document.hidden) return;
  keepScreenAwake();
  if (audioContext && audioContext.state !== "running" && audioContext.state !== "closed") {
    audioContext.resume().catch(() => {
      audioButton.hidden = false;
      setStatus("Audio paused by your browser. Select Enable sound to resume.");
    });
  }
  if ((audio.srcObject || serviceListening) && audio.paused) {
    audio.play().then(() => { audioButton.hidden = true; })
      .catch(() => { audioButton.hidden = false; });
  }
}

document.addEventListener("visibilitychange", restoreAudio);
window.addEventListener("focus", restoreAudio);

async function loadJoinServiceInputs() {
  loadServiceInputs.disabled = true;
  errorText.textContent = "";
  try {
    const { inputs } = await request("/api/service/inputs", {
      method: "POST", body: JSON.stringify({ password: passwordInput.value }),
    });
    const selected = joinServiceInput.value;
    joinServiceInput.replaceChildren(...inputs.map((input) => new Option(input.name, input.id)));
    joinServiceInput.value = selected;
    if (!joinServiceInput.value) joinServiceInput.selectedIndex = 0;
    if (!inputs.length) errorText.textContent = "Background service is disabled on the server.";
  } catch (error) {
    errorText.textContent = error.message;
  } finally {
    loadServiceInputs.disabled = false;
  }
}

loadServiceInputs.addEventListener("click", loadJoinServiceInputs);
passwordInput.addEventListener("change", () => {
  if (!joinServiceInputField.hidden && passwordInput.checkValidity()) loadJoinServiceInputs();
});

form.querySelectorAll('[name="role"]').forEach((input) => input.addEventListener("change", () => {
  const selectedRole = new FormData(form).get("role");
  joinServiceInputField.hidden = selectedRole !== "service";
  if (selectedRole === "service" && passwordInput.checkValidity()) loadJoinServiceInputs();
  recordServerOption.hidden = selectedRole !== "broadcast";
  if (recordServerOption.hidden) recordServer.checked = false;
  recordLocal.disabled = selectedRole === "service";
  if (recordLocal.disabled) recordLocal.checked = false;
}));

async function updateService(status) {
  if (role === "service") {
    serviceInputField.hidden = !status.enabled;
    serviceInput.disabled = status.running;
    if (status.running && status.device) serviceInput.value = status.device;
    serviceStart.hidden = !status.enabled || status.running;
    serviceStop.hidden = !status.running;
    title.textContent = status.running ? "The background microphone is live." : "Background broadcast controls";
    setStatus(status.error || (status.running ? "Broadcasting from the server microphone." :
      status.enabled ? "Ready to start the server microphone." : "Configure SERVICE_AUDIO_DEVICE on the server to enable this option."), status.running);
    backgroundStatus.textContent = "Closing or leaving this page does not stop the service. Use Stop background broadcast.";
    return;
  }
  if (role !== "listen") return;
  if (status.running && !serviceListening) {
    await stopRecording();
    if (leaving || studio.hidden) return;
    serviceListening = true;
    peers.forEach((connection) => connection.close());
    peers.clear();
    stopVisualization();
    audio.srcObject = null;
    audio.src = "/api/service/audio";
    startVisualization();
    title.textContent = "You are listening to the background broadcast.";
    setStatus("Receiving audio from the server.", true);
    if (localRecording) recordingStatus.textContent = "Device recording is unavailable for service audio.";
    if (localRecording) recordingStatus.hidden = false;
    audio.play().catch(() => { audioButton.hidden = false; });
  } else if (!status.running && serviceListening) {
    serviceListening = false;
    stopVisualization();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audioButton.hidden = true;
    recordingStatus.hidden = true;
    title.textContent = "Waiting for the broadcast.";
    setStatus(status.error || "The background broadcast stopped.");
  }
}

for (const [button, command] of [[serviceStart, "start"], [serviceStop, "stop"]]) {
  button.addEventListener("click", async () => {
    serviceStart.disabled = serviceStop.disabled = true;
    try {
      await updateService(await request(`/api/service/${command}`, { method: "POST",
        body: JSON.stringify(command === "start" ? { device: serviceInput.value } : {}) }));
    } catch (error) {
      setStatus(error.message);
    } finally {
      serviceStart.disabled = serviceStop.disabled = false;
    }
  });
}

function setStatus(message, live = false) {
  statusText.textContent = message;
  studio.classList.toggle("live", live);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Something went wrong.");
  return body;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorText.textContent = "";
  joinButton.disabled = true;
  joinButton.textContent = "Joining...";
  role = new FormData(form).get("role");

  try {
    setAudioSession(["broadcast", "conference"].includes(role) ? "play-and-record" : "playback");
    if (role !== "service") resumeVisualization();
    const session = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ role, password: form.password.value }),
    });
    savePassword();
    localRecording = role !== "service" && recordLocal.checked;
    serverRecording = role === "broadcast" && recordServer.checked;
    if (serverRecording && !session.serverRecording) {
      throw new Error("Server recording is not enabled by the administrator.");
    }
    if ((localRecording || serverRecording) && !window.MediaRecorder) {
      throw new Error("This browser does not support audio recording.");
    }
    if (role === "listen" && session.service.running && localRecording) {
      throw new Error("Device recording is unavailable for service audio. Uncheck recording to listen.");
    }
    if (["broadcast", "conference"].includes(role)) {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires HTTPS or localhost.");
      }
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
      });
      localStream = await startVoiceProcessing(microphoneStream);
      startVisualization(localStream);
      if (role === "conference") {
        conferenceOutput = audioContext.createMediaStreamDestination();
        conferenceRecording = audioContext.createMediaStreamDestination();
        const source = audioContext.createMediaStreamSource(localStream);
        source.connect(conferenceRecording);
        voiceNodes.push(source);
        audio.srcObject = conferenceOutput.stream;
        audio.play().catch(() => { audioButton.hidden = false; });
      }
      if (localRecording || serverRecording) await startRecording(role === "conference" ? conferenceRecording.stream : localStream);
    }
    voiceFilters.hidden = !["broadcast", "conference"].includes(role);
    signin.hidden = true;
    studio.hidden = false;
    keepScreenAwake();
    modeLabel.textContent = role === "service" ? "Background service" : role === "broadcast" ? "Broadcasting" : "Listening";
    title.textContent = role === "broadcast" ? "Your microphone is live." : "Waiting for the broadcast.";
    setStatus(role === "broadcast" ? "No listeners connected yet." : "Connected. Waiting for audio.", role === "broadcast");
    if (role === "conference") {
      modeLabel.textContent = "Conference";
      title.textContent = "Your microphone is live in the conference.";
      setStatus("Waiting for other conference participants.", true);
    }
    showRecordingStatus();
    await updateService(session.service);
    if (role === "service" && session.service.enabled) {
      serviceInput.replaceChildren(new Option("Configured input", session.service.device));
      try {
        const { inputs } = await request("/api/service/inputs");
        serviceInput.replaceChildren(...inputs.map((input) => new Option(input.name, input.id)));
        serviceInput.value = session.service.running ? session.service.device :
          (joinServiceInput.value || session.service.device);
        if (!serviceInput.value) serviceInput.selectedIndex = 0;
      } catch (error) {
        setStatus(error.message);
      }
    }
    connectEvents();
  } catch (error) {
    setAudioSession("auto");
    stopVisualization();
    stopVoiceProcessing();
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = undefined;
    recorder = undefined;
    serverRecordingId = undefined;
    errorText.textContent = error.message;
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
  } finally {
    form.password.value = "";
    joinButton.disabled = false;
    joinButton.textContent = "Join audio";
  }
});

function connectEvents() {
  events = new EventSource("/api/events");
  events.onmessage = async ({ data }) => {
    const event = JSON.parse(data);
    try {
      if (event.type === "peer-joined" && ["broadcast", "conference"].includes(role)) await offerTo(event.peer);
      if (event.type === "peer-left") closePeer(event.peer);
      if (event.type === "signal") await receiveSignal(event.peer, event.data);
      if (event.type === "replaced") leave("Another broadcaster took over.");
      if (event.type === "service-status") await updateService(event);
    } catch (error) {
      setStatus(error.message);
    }
  };
  events.onerror = () => setStatus("Reconnecting...");
}

function createPeer(peerId) {
  closePeer(peerId);
  const connection = new RTCPeerConnection({ iceServers: [] });
  connection.pendingCandidates = [];
  connection.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(peerId, { candidate });
  };
  connection.onconnectionstatechange = () => {
    const active = [...peers.values()].filter((peer) => peer.connectionState === "connected").length;
    if (role === "conference") {
      setStatus(active ? `${active} conference participant${active === 1 ? "" : "s"} connected.` : "Waiting for other conference participants.", true);
    } else if (role === "broadcast") {
      setStatus(active ? `${active} listener${active === 1 ? "" : "s"} connected.` : "No listeners connected yet.", true);
    } else if (connection.connectionState === "connected") {
      title.textContent = "You are listening live.";
      setStatus("Audio connected.", true);
    } else if (["failed", "disconnected"].includes(connection.connectionState)) {
      title.textContent = "Waiting for the broadcast.";
      setStatus("The audio connection was lost.");
    }
  };
  connection.ontrack = async ({ streams }) => {
    if (role === "conference") {
      conferenceSources.get(peerId)?.disconnect();
      const source = audioContext.createMediaStreamSource(streams[0]);
      source.connect(conferenceOutput);
      source.connect(conferenceRecording);
      conferenceSources.set(peerId, source);
      audio.play().catch(() => { audioButton.hidden = false; });
      return;
    }
    audio.srcObject = streams[0];
    startVisualization(streams[0]);
    audio.play().catch(() => { audioButton.hidden = false; });
    if (localRecording && !recorder) {
      try {
        await startRecording(streams[0]);
        showRecordingStatus();
      } catch (error) {
        setStatus(error.message);
      }
    }
  };
  if (role === "conference") localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));
  peers.set(peerId, connection);
  return connection;
}

async function offerTo(peerId) {
  const connection = createPeer(peerId);
  if (role !== "conference") localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));
  await connection.setLocalDescription(await connection.createOffer());
  await sendSignal(peerId, { description: connection.localDescription });
}

async function receiveSignal(peerId, data) {
  let connection = peers.get(peerId);
  if (!connection) connection = createPeer(peerId);

  if (data.description) {
    await connection.setRemoteDescription(data.description);
    for (const candidate of connection.pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate);
    }
    if (data.description.type === "offer") {
      await connection.setLocalDescription(await connection.createAnswer());
      await sendSignal(peerId, { description: connection.localDescription });
    }
  } else if (data.candidate) {
    if (connection.remoteDescription) await connection.addIceCandidate(data.candidate);
    else connection.pendingCandidates.push(data.candidate);
  }
}

async function sendSignal(peerId, data) {
  await request("/api/signal", {
    method: "POST",
    body: JSON.stringify({ to: peerId, data }),
  });
}

function recordingType() {
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
    .find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording(stream) {
  const type = recordingType();
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : {});
  recordingChunks = [];
  uploadQueue = Promise.resolve();

  if (serverRecording) {
    const recording = await request("/api/recording/start", {
      method: "POST",
      body: JSON.stringify({ type: recorder.mimeType }),
    });
    serverRecordingId = recording.id;
  }

  recorder.addEventListener("dataavailable", ({ data }) => {
    if (!data.size) return;
    if (localRecording) recordingChunks.push(data);
    if (serverRecordingId) {
      const recordingId = serverRecordingId;
      uploadQueue = uploadQueue
        .then(() => uploadRecordingChunk(recordingId, data))
        .catch((error) => {
          serverRecordingId = undefined;
          setStatus(`Server recording stopped: ${error.message}`);
          showRecordingStatus();
        });
    }
  });
  try {
    recorder.start(1000);
  } catch (error) {
    if (serverRecordingId) {
      await request("/api/recording/stop", {
        method: "POST",
        body: JSON.stringify({ id: serverRecordingId }),
      }).catch(() => {});
    }
    recorder = undefined;
    serverRecordingId = undefined;
    throw error;
  }
}

async function uploadRecordingChunk(recordingId, data) {
  const response = await fetch("/api/recording/chunk", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Recording-ID": recordingId },
    body: data,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Upload failed.");
}

function showRecordingStatus() {
  const destinations = [];
  if (localRecording && recorder) destinations.push("this device");
  if (serverRecordingId) destinations.push("the server");
  recordingStatus.textContent = destinations.length ? `Recording to ${destinations.join(" and ")}.` : "";
  recordingStatus.hidden = !destinations.length;
}

async function stopRecording() {
  if (!recorder || recorder.state === "inactive") return;
  const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
  recorder.stop();
  await stopped;
  await uploadQueue;

  if (serverRecordingId) {
    await request("/api/recording/stop", {
      method: "POST",
      body: JSON.stringify({ id: serverRecordingId }),
    }).catch(() => {});
  }
  if (localRecording && recordingChunks.length) {
    const blob = new Blob(recordingChunks, { type: recorder.mimeType });
    const link = document.createElement("a");
    const extension = recorder.mimeType.startsWith("audio/mp4") ? "m4a" : recorder.mimeType.split("/", 2)[1]?.split(";", 1)[0] || "webm";
    link.href = URL.createObjectURL(blob);
    link.download = `localcast-${new Date().toISOString().replaceAll(":", "-")}.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  recorder = undefined;
  serverRecordingId = undefined;
  recordingChunks = [];
  showRecordingStatus();
}

function closePeer(peerId) {
  conferenceSources.get(peerId)?.disconnect();
  conferenceSources.delete(peerId);
  if (role === "listen" && peers.has(peerId)) {
    stopVisualization();
    audio.srcObject = null;
  }
  peers.get(peerId)?.close();
  peers.delete(peerId);
}

audioButton.addEventListener("click", async () => {
  resumeVisualization();
  try {
    if (audioContext) await audioContext.resume();
    if (serviceListening && audio.error) audio.load();
    if (audio.srcObject || serviceListening) await audio.play();
    audioButton.hidden = true;
  } catch {
    setStatus("Your browser blocked audio playback. Try again.");
  }
});

leaveButton.addEventListener("click", () => leave());
window.addEventListener("pagehide", () => navigator.sendBeacon("/api/logout"));
window.addEventListener("beforeunload", (event) => {
  if (localRecording && recorder?.state === "recording") {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function leave(message = "") {
  if (leaving) return;
  leaving = true;
  const lock = wakeLock;
  wakeLock = undefined;
  lock?.release().catch(() => {});
  events?.close();
  stopVisualization();
  const closingContext = audioContext;
  await stopRecording();
  stopVoiceProcessing();
  // A media element can only be attached to one source node, so reuse its context.
  if (!serviceAudioSource) {
    audioContext = undefined;
    closingContext?.close().catch(() => {});
  }
  peers.forEach((connection) => connection.close());
  peers.clear();
  conferenceSources.forEach((source) => source.disconnect());
  conferenceSources.clear();
  conferenceOutput = conferenceRecording = undefined;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = undefined;
  audio.srcObject = null;
  if (serviceListening) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    serviceListening = false;
  }
  serviceStart.hidden = serviceStop.hidden = true;
  serviceInputField.hidden = true;
  setAudioSession("auto");
  fetch("/api/logout", { method: "POST" }).catch(() => {});
  studio.hidden = true;
  studio.classList.remove("live");
  signin.hidden = false;
  restorePassword();
  errorText.textContent = message;
  localRecording = false;
  serverRecording = false;
  recordLocal.checked = false;
  recordServer.checked = false;
  leaving = false;
}
