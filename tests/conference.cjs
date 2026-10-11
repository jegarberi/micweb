const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map();
const listeners = {};
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    hidden: true, addEventListener(name, callback) { this[name] = callback; }, querySelectorAll: () => [],
    classList: { remove() {}, toggle() {} }, getContext: () => ({ clearRect() {} }),
  });
  return elements.get(id);
}
const sandbox = {
  document: { hidden: false, querySelector: element,
    addEventListener: (name, callback) => { listeners[name] = callback; } },
  window: { addEventListener() {} }, navigator: { audioSession: {} },
  cancelAnimationFrame() {}, fetch: async () => ({}),
  FormData: class { get() { return sandbox.selectedRole; } },
  Option: class { constructor(name, id) { this.text = name; this.value = id; } },
};
const roleChoice = { addEventListener(name, callback) { this[name] = callback; } };
element('#join-form').querySelectorAll = () => [roleChoice];
element('#password').checkValidity = () => false;
element('#join-service-input').replaceChildren = function (...options) { this.options = options; };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('static/app.js', 'utf8'), sandbox);
const run = (code) => vm.runInContext(code, sandbox);

const connections = [];
sandbox.RTCPeerConnection = class {
  constructor() { this.tracks = []; connections.push(this); }
  addTrack(track, stream) { this.tracks.push([track, stream]); }
  async createOffer() { return { type: 'offer' }; }
  async createAnswer() { return { type: 'answer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate() {}
  close() { this.closed = true; }
};
const sources = [];
sandbox.context = { createMediaStreamSource(stream) {
  const source = { stream, targets: [], connect(target) { this.targets.push(target); },
    disconnect() { this.disconnected = true; } };
  sources.push(source);
  return source;
} };
sandbox.stream = { getTracks: () => ['microphone'] };
sandbox.fetch = async () => ({ ok: true, json: async () => ({}) });
element('#audio').play = async () => {};
(async () => {
  run('role = "conference"; localStream = stream; audioContext = context; conferenceOutput = {}; conferenceRecording = {};');
  await run('offerTo("first")');
  assert.equal(connections[0].tracks.length, 1, 'offer sends microphone once');
  await run('receiveSignal("second", {description: {type: "offer"}})');
  assert.equal(connections[1].tracks.length, 1, 'answer sends microphone too');
  assert.equal(connections[1].localDescription.type, 'answer');
  await connections[0].ontrack({ streams: ['first-voice'] });
  await connections[1].ontrack({ streams: ['second-voice'] });
  assert.equal(sources.length, 2);
  for (const source of sources) assert.equal(source.targets.length, 2, 'remote voice goes to playback and recording');
  assert.equal(run('conferenceSources.size'), 2, 'multiple speakers stay audible');
  run('closePeer("first")');
  assert.equal(sources[0].disconnected, true);
  assert.equal(sources[1].disconnected, undefined);
  assert.equal(connections[0].closed, true);
  assert.equal(run('conferenceSources.size'), 1);
  console.log('Conference duplex tracks, mixing and peer cleanup passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
