const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map();
const stored = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', checked: false,
    addEventListener(name, callback) { this[name] = callback; } });
  return elements.get(id);
};
const sandbox = { document: { querySelector: element }, localStorage: {
  getItem: key => stored.get(key),
  setItem: (key, value) => stored.set(key, value),
  removeItem: key => stored.delete(key),
} };
vm.createContext(sandbox);
const code = fs.readFileSync('static/app.js', 'utf8');
vm.runInContext(code.slice(0, code.indexOf('const title =')), sandbox);
const run = code => vm.runInContext(code, sandbox);
const password = element('#password');
const remember = element('#remember-password');
assert.equal(remember.checked, false);
password.value = 'correct horse';
run('savePassword()');
assert.equal(stored.size, 0);
remember.checked = true;
run('savePassword()');
password.value = '';
run('restorePassword()');
assert.equal(password.value, 'correct horse');
assert.equal(remember.checked, true);
remember.checked = false;
remember.change();
assert.equal(stored.size, 0);
sandbox.localStorage.getItem = () => { throw new Error('blocked'); };
run('restorePassword()');
assert.equal(remember.disabled, true);
sandbox.localStorage.setItem = () => { throw new Error('full'); };
remember.checked = true;
run('savePassword()');
assert.match(element('#remember-password-note').textContent, /Could not update/);
assert.match(code, /const session = await request\("\/api\/session",[\s\S]*?\}\);\s+savePassword\(\);/);
console.log('Password checks passed');
