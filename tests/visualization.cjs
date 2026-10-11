const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const drawn = [];
const points = [];
const canvas = {
  clearRect: () => drawn.push('clear'),
  fillRect: (...args) => { assert(args.every(Number.isFinite)); drawn.push('bar'); },
  beginPath: () => { points.length = 0; },
  moveTo: (x, y) => points.push([x, y]), lineTo: (x, y) => points.push([x, y]),
  stroke: () => drawn.push('wave'),
};
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) elements.set(selector, {
    value: 'wave', width: 800, height: 180,
    selectedOptions: [{ textContent: 'Waveform' }],
    addEventListener() {}, querySelectorAll: () => [],
    setAttribute() {}, getContext: () => canvas,
  });
  return elements.get(selector);
}
let cancelled = 0;
const sandbox = {
  document: { querySelector: element, hidden: false, addEventListener() {} },
  window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => cancelled++,
  getComputedStyle: () => ({ getPropertyValue: () => '#287a4b' }),
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('static/app.js', 'utf8'), sandbox);
vm.runInContext(`
  audioContext = {
    destination: {},
    createMediaElementSource: () => {
      mediaSources++;
      return { connect() { mediaConnections++; }, disconnect() { disconnected++; } };
    },
    createMediaStreamSource: () => ({ connect() {}, disconnect() { disconnected++; } }),
    createAnalyser: () => ({
      fftSize: 2048, frequencyBinCount: 1024, disconnect() { disconnected++; },
      getByteTimeDomainData: (data) => data.fill(sampleValue),
      getByteFrequencyData: (data) => data.fill(128),
    }),
  };
`, Object.assign(sandbox, { disconnected: 0, mediaSources: 0, mediaConnections: 0, sampleValue: 160 }));
vm.runInContext('startVisualization({})', sandbox);
assert(drawn.includes('wave'));
for (const mode of ['spectrum', 'level']) {
  drawn.length = 0;
  element('#visualization-mode').value = mode;
  vm.runInContext('drawVisualization()', sandbox);
  assert.equal(drawn.filter((item) => item === 'bar').length, mode === 'spectrum' ? 64 : 1);
}
element('#visualization-mode').value = 'off';
drawn.length = 0;
vm.runInContext('drawVisualization()', sandbox);
assert.equal(element('#visualization').hidden, true);
assert.equal(drawn.length, 0);
vm.runInContext('stopVisualization()', sandbox);
assert.equal(sandbox.disconnected, 2);
assert(cancelled > 0);
assert.equal(drawn.at(-1), 'clear');
sandbox.sampleValue = 128;
element('#visualization-mode').value = 'wave';
vm.runInContext('startVisualization()', sandbox);
assert.equal(sandbox.mediaSources, 1);
assert.equal(sandbox.mediaConnections, 2, 'service audio connects to playback and analyser');
assert.equal(points.length, 2048);
assert(points.every(([, y]) => y === 90), 'silence is a straight line at the canvas center');
assert.equal(points[0][0], 0);
assert.equal(points.at(-1)[0], 800);
vm.runInContext('stopVisualization(); startVisualization()', sandbox);
assert.equal(sandbox.mediaSources, 1, 'reuse the media element source on service restart');
console.log('Visualization modes and cleanup passed.');
