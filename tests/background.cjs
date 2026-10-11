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

(async () => {
  sandbox.selectedRole = 'service';
  roleChoice.change();
  assert.equal(element('#join-service-input-field').hidden, false);
  element('#password').value = 'correct horse';
  sandbox.fetch = async (path, options) => {
    assert.equal(path, '/api/service/inputs');
    assert.equal(JSON.parse(options.body).password, 'correct horse');
    return { ok: true, json: async () => ({ inputs: [{ id: 'usb', name: 'USB microphone' }] }) };
  };
  await element('#load-service-inputs').click();
  assert.equal(element('#join-service-input').options[0].value, 'usb');
  sandbox.selectedRole = 'listen';
  roleChoice.change();
  assert.equal(element('#join-service-input-field').hidden, true);
  let requested = 0;
  let released = 0;
  let onRelease;
  sandbox.navigator.wakeLock = { request: async (type) => {
    assert.equal(type, 'screen');
    requested++;
    return { release: async () => { released++; },
      addEventListener: (name, callback) => { assert.equal(name, 'release'); onRelease = callback; } };
  } };
  await run('keepScreenAwake()');
  assert.equal(requested, 0, 'no wake lock outside a session');
  element('#studio').hidden = false;
  await Promise.all([run('keepScreenAwake()'), run('keepScreenAwake()')]);
  assert.equal(requested, 1, 'concurrent requests are deduplicated');
  sandbox.document.hidden = true;
  onRelease();
  listeners.visibilitychange();
  assert.equal(requested, 1, 'hidden pages do not request locks');
  sandbox.document.hidden = false;
  let resumed = 0;
  let played = 0;
  sandbox.context = { state: 'interrupted', resume: async () => { resumed++; }, close: async () => {} };
  run('audioContext = context');
  Object.assign(element('#audio'), { srcObject: {}, paused: true,
    play: async () => { played++; } });
  listeners.visibilitychange();
  await new Promise(setImmediate);
  assert.equal(requested, 2);
  assert.equal(resumed, 1);
  assert.equal(played, 1);
  run('setAudioSession("play-and-record")');
  assert.equal(sandbox.navigator.audioSession.type, 'play-and-record');
  await run('leave()');
  assert.equal(released, 1);
  assert.equal(sandbox.navigator.audioSession.type, 'auto');
  element('#studio').hidden = false;
  let grantLock;
  sandbox.navigator.wakeLock.request = () => new Promise((resolve) => { grantLock = resolve; });
  const pendingLock = run('keepScreenAwake()');
  await run('leave()');
  grantLock({ release: async () => { released++; } });
  await pendingLock;
  assert.equal(released, 2, 'a lock granted after leaving is released');
  element('#studio').hidden = false;
  sandbox.navigator.wakeLock.request = async () => { throw Error('Denied'); };
  await run('keepScreenAwake()');
  assert.match(element('#background-status').textContent, /Could not/);
  delete sandbox.navigator.wakeLock;
  await run('keepScreenAwake()');
  assert.match(element('#background-status').textContent, /Keep this page visible/);
  run('role = "service"');
  await run('updateService({ enabled: true, running: false })');
  assert.equal(element('#service-start').hidden, false);
  assert.equal(element('#service-stop').hidden, true);
  assert.equal(element('#service-input-field').hidden, false);
  assert.equal(element('#service-input').disabled, false);
  element('#service-input').value = 'usb_microphone';
  sandbox.fetch = async (path, options) => {
    assert.equal(path, '/api/service/start');
    assert.equal(JSON.parse(options.body).device, 'usb_microphone');
    return { ok: true, json: async () => ({ enabled: true, running: true, device: 'usb_microphone' }) };
  };
  await element('#service-start').click();
  assert.equal(element('#service-input').disabled, true);
  await run('updateService({ enabled: true, running: true })');
  assert.equal(element('#service-start').hidden, true);
  assert.equal(element('#service-stop').hidden, false);
  const requests = [];
  sandbox.fetch = async (path) => { requests.push(path); return {}; };
  await run('leave()');
  assert.deepEqual(requests, ['/api/logout'], 'leaving controls does not stop host capture');
  assert.equal(element('#service-input-field').hidden, true);
  element('#studio').hidden = false;
  run('role = "listen"');
  Object.assign(element('#audio'), {
    pause() {}, removeAttribute(name) { delete this[name]; }, load() {},
  });
  await run('updateService({ enabled: true, running: true })');
  assert.equal(element('#audio').src, '/api/service/audio');
  assert.equal(run('serviceListening'), true);
  await run('updateService({ enabled: true, running: false })');
  assert.equal(element('#audio').src, undefined);
  assert.equal(run('serviceListening'), false);
  console.log('Background audio recovery and wake lock lifecycle passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
