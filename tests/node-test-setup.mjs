import { createRequire } from 'node:module';
import { after, afterEach, before, beforeEach, describe, test as nodeTest } from 'node:test';
import { format, inspect } from 'node:util';
import FakeTimers from '@sinonjs/fake-timers';
import { chai, GLOBAL_EXPECT, JestAsymmetricMatchers, JestChaiExpect, setState } from '@vitest/expect';
import { clearAllMocks, fn, resetAllMocks, restoreAllMocks, spyOn } from '@vitest/spy';

// Bridge the Jest APIs used by the existing suites. Node runs this preload in
// each test file's process, so its mocks and browser globals are isolated.
const require = createRequire(import.meta.url);
const clockApis = ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'];

chai.use(JestChaiExpect);
chai.use(JestAsymmetricMatchers);
globalThis.expect = chai.expect;
globalThis[GLOBAL_EXPECT] = chai.expect;
setState({ assertionCalls: 0 }, chai.expect);

function formatCaseName(name, row, args, index) {
  let argIndex = 0;
  return name.replace(/%%|%[#$psdifojO]|\$[A-Za-z_][\w.]*/g, (token) => {
    if (token === '%%') return '%';
    if (token === '%#') return String(index);
    if (token === '%$') return String(index + 1);
    if (token.startsWith('$')) {
      const value = token
        .slice(1)
        .split('.')
        .reduce((object, key) => object?.[key], row);
      return typeof value === 'string' ? value : inspect(value);
    }
    const value = args[argIndex++];
    return token === '%p' ? inspect(value) : format(token, value);
  });
}

function createTestRegistration(skip = false) {
  function register(name, callback, timeout = 5000, args = []) {
    const options = { skip, timeout };
    if (callback.length > args.length) {
      return nodeTest(name, options, (_context, done) => callback(...args, done));
    }
    return nodeTest(name, options, () => callback(...args));
  }

  register.each = (rows) => (name, callback, timeout) => {
    // An array is a positional row only when the whole input is a table.
    const isTable = rows.every(Array.isArray);
    rows.forEach((row, index) => {
      const args = isTable ? row : [row];
      register(formatCaseName(name, row, args, index), callback, timeout, args);
    });
  };
  return register;
}

const test = createTestRegistration();
test.skip = createTestRegistration(true);

let clock;
globalThis.jest = {
  fn,
  spyOn,
  clearAllMocks,
  resetAllMocks,
  restoreAllMocks,
  useFakeTimers({ doNotFake = [] } = {}) {
    clock?.uninstall();
    // The runner and stream fixtures use real microtasks and immediates.
    clock = FakeTimers.install({ now: Date.now(), toFake: clockApis.filter((api) => !doNotFake.includes(api)) });
  },
  useRealTimers() {
    clock?.uninstall();
    clock = undefined;
  },
  advanceTimersByTime(ms) {
    return clock.tick(ms);
  },
  advanceTimersByTimeAsync(ms) {
    return clock.tickAsync(ms);
  },
  runOnlyPendingTimers() {
    return clock.runToLast();
  },
  getTimerCount() {
    return clock.countTimers();
  },
};

Object.assign(globalThis, { test, describe, beforeAll: before, afterAll: after, beforeEach, afterEach });
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: undefined });
require('./setup.js');
