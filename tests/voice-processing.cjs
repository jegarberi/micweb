const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let Processor;
vm.runInNewContext(fs.readFileSync('static/voice-processor.js', 'utf8'), {
  sampleRate: 48000,
  AudioWorkletProcessor: class { constructor() { this.port = {}; } },
  registerProcessor: (name, implementation) => { Processor = implementation; },
});
function run(processor, amplitude, blocks = 500, dryAmplitude = amplitude) {
  const input = new Float32Array(128).fill(amplitude);
  const dry = new Float32Array(128).fill(dryAmplitude);
  const output = new Float32Array(128);
  for (let i = 0; i < blocks; i++) {
    assert.equal(processor.process([[input], [dry]], [[output]]), true);
    assert(output.every(Number.isFinite));
    if (processor.settings.limiter && !processor.settings.bypass) {
      assert(output.every(value => Math.abs(value) <= 10 ** (processor.settings.ceiling / 20) + 1e-6));
    }
  }
  return output[127];
}
const limiter = new Processor();
limiter.settings.compressor = limiter.settings.gate = false;
limiter.settings.trim = 18;
for (const ceiling of [-9, -7, -5]) {
  limiter.settings.ceiling = ceiling;
  for (const peak of [0, 0.01, 0.5, 1, -1]) run(limiter, peak);
}
const compressor = new Processor();
compressor.settings.gate = compressor.settings.limiter = false;
const compressed = run(compressor, 0.5);
assert(Math.abs(20 * Math.log10(compressed) - (-20 + (20 * Math.log10(0.5) + 20) / 3)) < 0.01);
const gate = new Processor();
gate.settings.compressor = gate.settings.limiter = false;
assert(run(gate, 0.001) < 0.0004);
assert(Math.abs(run(gate, 0.1) - 0.1) < 0.001);
gate.settings.bypass = true;
assert(Math.abs(run(gate, 0.001, 500, 0.2) - 0.2) < 0.00001);
gate.process([[], []], [[new Float32Array(128)]]);

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { addEventListener() {}, querySelectorAll: () => [], checked: true, value: '90' });
  return elements.get(id);
}
const connections = [];
let stops = 0;
function node(name) {
  return { name, connect(target, ...ports) { connections.push([name, target.name, ...ports]); return target; },
    disconnect() {}, frequency: { setTargetAtTime() {} }, Q: {}, port: { postMessage(s) { this.settings = s; }, close() {} } };
}
const sandbox = { document: { querySelector: element, addEventListener() {} }, window: { addEventListener() {} },
  AudioWorkletNode: class { constructor() { return node('processor'); } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('static/app.js', 'utf8'), sandbox);
Object.assign(sandbox, { context: { resume: async () => {}, audioWorklet: { addModule: async path => assert.equal(path, '/voice-processor.js') },
  createMediaStreamSource: () => node('mic'), createBiquadFilter: () => node('hpf'),
  createMediaStreamDestination: () => ({ ...node('output'), stream: { processed: true } }) },
  mic: { getTracks: () => [{ stop() { stops++; } }] } });
(async () => {
  const stream = await vm.runInContext('audioContext = context; microphoneStream = mic; startVoiceProcessing(mic)', sandbox);
  assert(stream.processed);
  assert.deepEqual(connections, [['mic', 'hpf'], ['hpf', 'hpf'], ['hpf', 'processor', 0, 0], ['mic', 'processor', 0, 1], ['processor', 'output']]);
  vm.runInContext('stopVoiceProcessing()', sandbox);
  assert.equal(stops, 1);
  console.log('Voice chain, dynamics, limiter ceiling, bypass and microphone cleanup passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
