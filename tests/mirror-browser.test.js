'use strict';
// Real-browser regression for the pop-out mirror: the viewer tab's remote
// control surface, the host's command execution, session adoption after a
// DevTools reopen, and the pop-out minimize handshake. Chrome APIs are
// stubbed via Page.addScriptToEvaluateOnNewDocument so panel.js sees them
// at load, and a scripted peer drives the real page over the port wiring.
// Previously this coverage lived only in ephemeral session scratchpads.
const {
  findBrowserExecutable,
  launchPanelPage,
  evaluate,
  delay,
} = require('./helpers/browser-harness');

const TEST_TIMEOUT_MS = 90000;
const browserExecutable = findBrowserExecutable();
const runningInCi =
  process.env.GITHUB_ACTIONS === 'true' || Boolean(process.env.CI && process.env.CI.toLowerCase() !== 'false');
if (!browserExecutable && runningInCi) {
  throw new Error(
    'Real-browser regression tests require an executable Chrome or Edge in CI. ' +
      'Set EDGE_BIN or CHROME_BIN to an executable browser path.',
  );
}
const browserTest = browserExecutable ? test : test.skip;

const MINI_HAR = JSON.stringify({
  log: {
    version: '1.2',
    creator: { name: 'mirror-browser-test', version: '1' },
    entries: [
      {
        startedDateTime: '2026-08-22T10:00:00.000Z',
        time: 42,
        request: {
          method: 'GET',
          url: 'https://imported.example.test/one',
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'Content-Type', value: 'text/plain' }],
          content: { size: 2, mimeType: 'text/plain', text: 'ok' },
          headersSize: -1,
          bodySize: 2,
        },
        cache: {},
        timings: { send: 1, wait: 40, receive: 1 },
      },
    ],
  },
});

const wireRow = (id) => ({
  id,
  startedDateTime: new Date(1755750000000 + id * 1000).toISOString(),
  time: 120,
  initiator: { text: 'JS: app.js:1', url: 'https://example.test/app.js', lineNumber: 1, typeLabel: 'JS' },
  request: { method: 'GET', url: 'https://api.example.test/v1/items/' + id, headers: [], postData: null },
  response: {
    status: 200,
    statusText: 'OK',
    httpVersion: 'HTTP/2.0',
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    bodySize: 100,
    content: { mimeType: 'application/json', size: 100 },
  },
  timings: { wait: 90, receive: 10 },
});

const syncControl = (over) =>
  Object.assign(
    {
      paused: false,
      retention: { requestLimit: 20000, unlimited: false },
      undoAvailable: false,
      streamCapture: { supported: true, enabled: false },
    },
    over,
  );

// The viewer stub: storage plus a runtime whose onConnect handlers the test
// invokes with a scripted host port. Reinstalled on every navigation.
const VIEWER_STUB = `
  window.__sentToHost = [];
  window.__onConnectHandlers = [];
  globalThis.chrome = {
    storage: { local: { get: (keys, cb) => setTimeout(() => cb({}), 0), set: (data, cb) => cb && cb() } },
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '0.0.0' }),
      onConnect: { addListener: (fn) => window.__onConnectHandlers.push(fn) },
    },
  };
`;

// The host stub: devtools APIs plus a singleton fake port whose message
// listener the test drives as the scripted viewer.
const HOST_STUB = `
  window.__fromHost = [];
  window.__evals = [];
  window.__requestListeners = [];
  window.__openedUrls = [];
  window.__minimizeCalls = 0;
  window.__minimizeAnswer = { minimized: true };
  const fakePort = {
    name: 'networkplus-mirror:42',
    onMessage: { addListener: (fn) => (window.__hostPortListener = fn) },
    onDisconnect: { addListener: (fn) => (window.__hostPortDisconnect = fn) },
    postMessage: (msg) => window.__fromHost.push(msg),
    disconnect: () => {},
  };
  globalThis.chrome = {
    storage: { local: { get: (keys, cb) => setTimeout(() => cb({}), 0), set: (data, cb) => cb && cb() } },
    runtime: {
      lastError: null,
      connect: () => fakePort,
      sendMessage: (message, cb) => {
        window.__minimizeCalls += 1;
        if (cb) cb(window.__minimizeAnswer);
      },
    },
    devtools: {
      inspectedWindow: {
        tabId: 42,
        eval: (source, cb) => {
          window.__evals.push(String(source));
          if (cb) cb(undefined, undefined);
        },
      },
      network: {
        onRequestFinished: { addListener: (fn) => window.__requestListeners.push(fn) },
        onNavigated: { addListener: () => {} },
      },
      panels: { openResource: () => {} },
    },
  };
  window.open = (url) => {
    window.__openedUrls.push(String(url));
    return { closed: false, focus: () => {} };
  };
`;

const attachScriptedHostPort = (cdp) =>
  evaluate(
    cdp,
    `(() => {
      window.__hostListeners = { message: [], disconnect: [] };
      const port = {
        name: 'networkplus-mirror:7',
        onMessage: { addListener: (fn) => window.__hostListeners.message.push(fn) },
        onDisconnect: { addListener: (fn) => window.__hostListeners.disconnect.push(fn) },
        postMessage: (msg) => window.__sentToHost.push(msg),
        disconnect: () => {},
      };
      window.__send = (msg) => window.__hostListeners.message.forEach((fn) => fn(msg));
      window.__onConnectHandlers.forEach((fn) => fn(port));
      return true;
    })()`,
  );

const sendSnapshot = (cdp, rows, control) =>
  evaluate(
    cdp,
    `(() => {
      const rows = ${JSON.stringify(rows)};
      window.__send({ type: 'snapshot-start', generation: 1, total: rows.length, protocolVersion: 2 });
      window.__send({ type: 'snapshot-rows', generation: 1, rows });
      window.__send({ type: 'snapshot-end', generation: 1 });
      window.__send({ type: 'sync', count: rows.length, maxId: rows.length, paused: false, control: ${JSON.stringify(
        control,
      )} });
      return true;
    })()`,
  );

const waitForImportResult = async (cdp, condition) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await evaluate(cdp, condition);
    if (result) return result;
    await delay(25);
  }
  return null;
};

const lastViewerCommand = (cdp) =>
  evaluate(cdp, "window.__sentToHost.filter((m) => m.type === 'command').at(-1) || null");

const answerCommand = (cdp, commandId, control) =>
  evaluate(
    cdp,
    `(() => {
      window.__send({ type: 'command-result', commandId: ${commandId}, ok: true, error: '' });
      window.__send({ type: 'sync', count: 3, maxId: 3, paused: ${control.paused === true}, control: ${JSON.stringify(
        control,
      )} });
      return true;
    })()`,
  );

browserTest(
  'full pop-out HAR keeps one stream revision when an older export reply arrives after a live update',
  async () => {
    const host = await launchPanelPage({
      executable: browserExecutable,
      initScript: HOST_STUB + `
        window.__wsEvents = [];
        const originalEval = chrome.devtools.inspectedWindow.eval;
        chrome.devtools.inspectedWindow.eval = (source, callback) => {
          if (source.includes('function pageDrainStream') && source.includes('__networkPlusWS__')) {
            callback(JSON.stringify(window.__wsEvents.splice(0)));
          } else if (source.includes('function pageDrainStream') && source.includes('__networkPlusSSE__')) {
            callback('[]');
          } else originalEval(source, callback);
        };
        const push = window.__fromHost.push.bind(window.__fromHost);
        window.__fromHost.push = (message) => push(JSON.parse(JSON.stringify(message)));
      `,
    });
    let viewer;
    try {
      viewer = await launchPanelPage({
        executable: browserExecutable, query: '?view=window&src=7', initScript: VIEWER_STUB,
      });
      await attachScriptedHostPort(viewer.cdp);
      let holdExport = false;
      const heldResults = [];
      const deferredFrameRequests = [];
      const deliveredRows = [];
      const forward = (messages) => evaluate(viewer.cdp, `${JSON.stringify(messages)}.forEach(window.__send); true`);
      const relay = async () => {
        const requests = await evaluate(viewer.cdp, 'window.__sentToHost.splice(0)');
        const readyRequests = [];
        for (const request of requests) {
          // The old protocol fetched body and frame metadata separately.
          // Hold its frame request until after the next captured revision.
          if (holdExport && request.type === 'ws-export-request') deferredFrameRequests.push(request);
          else readyRequests.push(request);
        }
        if (readyRequests.length) await evaluate(host.cdp, `${JSON.stringify(readyRequests)}.forEach(window.__hostPortListener); true`);
        const replies = await evaluate(host.cdp, 'window.__fromHost.splice(0)');
        const readyReplies = [];
        for (const reply of replies) {
          // The atomic protocol samples a complete stream entry at the host.
          // Hold that real snapshot too, so it must survive a newer row push.
          if (holdExport && ['body-result', 'stream-har-result'].includes(reply.type)) heldResults.push(reply);
          else {
            if (reply.type === 'row') deliveredRows.push(reply.row);
            readyReplies.push(reply);
          }
        }
        if (readyReplies.length) await forward(readyReplies);
      };
      const wait = async (predicate, description) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          await relay();
          const value = await predicate();
          if (value) return value;
          await delay(25);
        }
        throw new Error('Atomic stream HAR fixture did not reach: ' + description);
      };
      await relay();
      await evaluate(host.cdp, `(() => {
        window.__wsEvents.push(
          { socketId: 6, kind: 'ws-open-attempt', at: 1700000000000, url: 'wss://synthetic.invalid/atomic' },
          { socketId: 6, kind: 'ws-open', at: 1700000000001 },
          { socketId: 6, kind: 'ws-sent', at: 1700000000002, preview: 'old-send' },
          { socketId: 6, kind: 'ws-received', at: 1700000000003, preview: 'old-private' },
        );
        document.querySelector('#wsCaptureBtn').click();
        return true;
      })()`);
      await wait(() => evaluate(viewer.cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length === 1"), 'initial mirrored stream');
      const original = deliveredRows.at(-1);
      expect(original.response.bodySize).toBe(11);
      holdExport = true;
      await evaluate(viewer.cdp, `(() => {
        window.__exports = [];
        URL.createObjectURL = (blob) => { window.__exports.push(blob); return 'blob:synthetic-atomic-har'; };
        HTMLAnchorElement.prototype.click = () => {};
        document.querySelector('#exportHarBtn').click();
        document.querySelector('#dataSafetyFullBtn').click();
        document.querySelector('#dataSafetyConfirmBtn').click();
        return true;
      })()`);
      await wait(() => heldResults.length > 0, 'an actual export response held before the update');
      expect(JSON.stringify(heldResults)).toContain('old-private');
      expect(JSON.stringify(heldResults)).not.toContain('new-private');
      await evaluate(host.cdp, `window.__wsEvents.push(
        { socketId: 6, kind: 'ws-sent', at: 1700000000004, preview: 'new-send' },
        { socketId: 6, kind: 'ws-received', at: 1700000000005, preview: 'new-private' }
      ); true`);
      const updated = await wait(() => deliveredRows.find((row) => row.id === original.id && row.streamRevision > original.streamRevision), 'newer revision delivered while the export response is withheld');
      expect(updated.response.bodySize).toBe(22);
      expect(updated.request.postData.text).toContain('new-send');
      expect(await evaluate(viewer.cdp, 'window.__exports.length')).toBe(0);

      holdExport = false;
      await forward(heldResults);
      if (deferredFrameRequests.length) await evaluate(host.cdp, `${JSON.stringify(deferredFrameRequests)}.forEach(window.__hostPortListener); true`);
      await wait(() => evaluate(viewer.cdp, "window.__exports.length === 1 && !document.querySelector('#exportHarBtn').disabled"), 'completed full export');
      const entry = await evaluate(viewer.cdp, 'window.__exports[0].text().then((text) => JSON.parse(text).log.entries[0])', true);
      expect(entry.response.content.text).toContain('old-private');
      const includesNewRevision = entry.response.content.text.includes('new-private');
      const expectedFrames = [
        { type: 'send', time: 1700000000.002, opcode: 1, data: 'old-send' },
        { type: 'receive', time: 1700000000.003, opcode: 1, data: 'old-private' },
      ];
      if (includesNewRevision) expectedFrames.push(
        { type: 'send', time: 1700000000.004, opcode: 1, data: 'new-send' },
        { type: 'receive', time: 1700000000.005, opcode: 1, data: 'new-private' },
      );
      expect({
        frames: entry._webSocketMessages,
        bodySize: entry.response.bodySize,
        contentSize: entry.response.content.size,
        requestIncludesNewRevision: entry.request.postData.text.includes('new-send'),
      }).toEqual({
        frames: expectedFrames,
        bodySize: includesNewRevision ? 22 : 11,
        contentSize: includesNewRevision ? 22 : 11,
        requestIncludesNewRevision: includesNewRevision,
      });
      expect(entry.request.bodySize).toBe(entry.request.postData.text.length);
      expect(entry.response.content.text.match(/old-private/g)).toHaveLength(1);
    } finally {
      if (viewer) await viewer.close();
      await host.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'combined stream updates keep pop-out bodies and structured HAR exports current',
  async () => {
    const host = await launchPanelPage({
      executable: browserExecutable,
      initScript: HOST_STUB + `
        class SyntheticSocket {
          constructor(url) {
            this.url = url; this.readyState = 0; this.listeners = {}; }
          addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
          send(data) {
            if (this.readyState !== 1) throw new DOMException('Synthetic socket is connecting', 'InvalidStateError');
            return 'accepted';
          }
          emit(type, event = {}) {
            if (type === 'open') this.readyState = 1;
            if (type === 'close') this.readyState = 3;
            for (const listener of this.listeners[type] || []) listener(event);
          }
        }
        window.WebSocket = SyntheticSocket;
        const originalEval = chrome.devtools.inspectedWindow.eval;
        chrome.devtools.inspectedWindow.eval = (source, callback) => {
          if (source.includes('function pageDrainStream') && source.includes('__networkPlusWS__')) {
            callback(window.eval(source));
          } else if (source.includes('function pageDrainStream') && source.includes('__networkPlusSSE__')) {
            callback('[]');
          } else originalEval(source, callback);
        };
        const push = window.__fromHost.push.bind(window.__fromHost);
        window.__fromHost.push = (message) => push(JSON.parse(JSON.stringify(message)));
      `,
    });
    let viewer;
    const traffic = [];
    try {
      viewer = await launchPanelPage({
        executable: browserExecutable, query: '?view=window&src=7', initScript: VIEWER_STUB,
      });
      await attachScriptedHostPort(viewer.cdp);
      const relay = async () => {
        const requests = await evaluate(viewer.cdp, 'window.__sentToHost.splice(0)');
        if (requests.length) {
          traffic.push(...requests);
          await evaluate(host.cdp, `${JSON.stringify(requests)}.forEach(window.__hostPortListener); true`);
        }
        const replies = await evaluate(host.cdp, 'window.__fromHost.splice(0)');
        if (replies.length) {
          traffic.push(...replies);
          await evaluate(viewer.cdp, `${JSON.stringify(replies)}.forEach(window.__send); true`);
        }
      };
      const wait = async (page, expression) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          await relay();
          const value = await evaluate(page.cdp, expression);
          if (value) return value;
          await delay(25);
        }
        throw new Error('Combined stream/export fixture did not reach: ' + expression);
      };
      await relay();
      await evaluate(host.cdp, "document.querySelector('#wsCaptureBtn').click(); true");
      const wrapper = await evaluate(host.cdp, "window.__evals.find((source) => source.startsWith('(function pageWebSocketWrapper('))");
      expect(typeof wrapper).toBe('string');
      // Execute the production page wrapper against a wholly synthetic socket.
      expect(await evaluate(host.cdp, wrapper)).toBe('installed');
      expect(await evaluate(host.cdp, `(() => {
        window.__socket = new WebSocket('wss://synthetic.invalid/combined');
        try { window.__socket.send('rejected-private'); } catch (error) { return error.name; }
        return 'unexpected success';
      })()`)).toBe('InvalidStateError');
      const rowState = `(() => {
        const rows = document.querySelectorAll('#tbody tr[data-row-id]');
        return rows.length === 1 ? { id: rows[0].dataset.rowId,
          status: rows[0].querySelector('[data-col-id="status"]').textContent } : null;
      })()`;
      const initial = await wait(viewer, `(() => { const row = ${rowState}; return row?.status === 'Connecting' && row; })()`);
      expect(await evaluate(host.cdp, `(() => {
        window.__socket.emit('open');
        const result = window.__socket.send('accepted-private');
        window.__socket.emit('message', { data: 'first-private' });
        return result;
      })()`)).toBe('accepted');
      const opened = await wait(viewer, `(() => { const row = ${rowState}; return row?.status === 'Open' && row; })()`);
      expect(opened.id).toBe(initial.id);
      await evaluate(viewer.cdp, `
        document.querySelector('#tbody tr').click();
        document.querySelector('#ws-tab-details').click();
        document.querySelector('#res-tab-raw').click(); true`);
      await wait(viewer, "document.querySelector('#res-raw').textContent.includes('first-private')");
      await evaluate(host.cdp, "window.__socket.emit('message', { data: 'later-private' }); true");
      await wait(viewer, "document.querySelector('#res-raw').textContent.includes('later-private')");
      await evaluate(host.cdp, "window.__socket.emit('close', { code: 1000, reason: 'finished' }); true");
      const closed = await wait(viewer, `(() => { const row = ${rowState}; return row?.status === 'Closed' && row; })()`);
      expect(closed.id).toBe(initial.id);

      for (const page of [host, viewer]) {
        await evaluate(page.cdp, `(() => {
          window.__exports = [];
          URL.createObjectURL = (blob) => { window.__exports.push(blob); return 'blob:synthetic-combination-har'; };
          HTMLAnchorElement.prototype.click = () => {};
          return true;
        })()`);
      }
      const exportHar = async (page, mode) => {
        const index = await evaluate(page.cdp, `(() => {
          const index = window.__exports.length;
          document.querySelector('#exportHarBtn').click();
          document.querySelector(${JSON.stringify(mode === 'full' ? '#dataSafetyFullBtn' : '#dataSafetySanitizedBtn')}).click();
          ${mode === 'full' ? "document.querySelector('#dataSafetyConfirmBtn').click();" : ''}
          return index;
        })()`);
        await wait(page, `window.__exports.length === ${index + 1} && !document.querySelector('#exportHarBtn').disabled`);
        return evaluate(page.cdp, `window.__exports[${index}].text().then((text) => JSON.parse(text).log.entries[0])`, true);
      };
      const hostEntry = await exportHar(host, 'full');
      const viewerEntry = await exportHar(viewer, 'full');
      expect(viewerEntry._webSocketMessages).toEqual(hostEntry._webSocketMessages);
      expect(viewerEntry._webSocketMessages.map(({ type, data }) => [type, data])).toEqual([
        ['send', 'accepted-private'], ['receive', 'first-private'], ['receive', 'later-private'],
      ]);
      expect(viewerEntry.request.postData).toEqual(hostEntry.request.postData);
      expect(viewerEntry.response.content).toEqual(hostEntry.response.content);
      expect(viewerEntry.response.statusText).toBe('Closed');
      expect(viewerEntry.request.bodySize).toBe(hostEntry.request.bodySize);
      expect(viewerEntry.response.bodySize).toBe(26);
      expect(viewerEntry.response.content.size).toBe(26);
      expect(viewerEntry.response.content.text.match(/later-private/g)).toHaveLength(1);
      expect(JSON.stringify(viewerEntry)).not.toContain('rejected-private');

      await evaluate(viewer.cdp, 'window.__hostListeners.disconnect.forEach((listener) => listener()); true');
      await attachScriptedHostPort(viewer.cdp);
      await relay();
      expect(await evaluate(viewer.cdp, rowState)).toEqual(closed);
      const afterReconnect = await exportHar(viewer, 'full');
      expect(afterReconnect._webSocketMessages).toEqual(viewerEntry._webSocketMessages);
      expect(afterReconnect.response.content).toEqual(viewerEntry.response.content);
      const start = traffic.length;
      const sanitized = await exportHar(viewer, 'sanitized');
      expect(sanitized._webSocketMessages).toBeUndefined();
      expect(sanitized._networkPlus.webSocketFramesOmitted).toBe(3);
      expect(JSON.stringify(sanitized)).not.toMatch(/accepted-private|first-private|later-private|rejected-private/);
      expect(traffic.slice(start).some((message) => 'frames' in message || message.type === 'body-request')).toBe(false);
    } finally {
      if (viewer) await viewer.close();
      await host.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'WebSocket and SSE keep their row IDs through lifecycle updates and mirror reconnection',
  async () => {
    const host = await launchPanelPage({
      executable: browserExecutable,
      initScript: HOST_STUB + `
        window.__streamQueues = { ws: [], sse: [] };
        const nativeEval = chrome.devtools.inspectedWindow.eval;
        chrome.devtools.inspectedWindow.eval = (source, callback) => {
          if (source.includes('function pageDrainStream')) {
            const queue = source.includes('__networkPlusSSE__') ? 'sse' : 'ws';
            callback(JSON.stringify(window.__streamQueues[queue].splice(0)));
          } else nativeEval(source, callback);
        };
        const navigationListeners = [];
        chrome.devtools.network.onNavigated.addListener = (callback) => navigationListeners.push(callback);
        window.__navigateStreamHost = () => {
          for (const callback of navigationListeners) callback('https://navigation.example.test/');
        };
      `,
    });
    let viewer;
    const readRows = `Array.from(document.querySelectorAll('#tbody tr[data-row-id]')).map((row) => ({
      id: row.dataset.rowId,
      status: row.querySelector('[data-col-id=status]').textContent,
      method: row.querySelector('[data-col-id=method]').textContent,
    }))`;
    const drive = (message) => evaluate(host.cdp, `window.__hostPortListener(${JSON.stringify(message)}); true`);
    const collect = () => evaluate(host.cdp, 'window.__fromHost.splice(0)');
    const forward = (messages) => evaluate(viewer.cdp, `${JSON.stringify(messages)}.forEach(window.__send); true`);
    const handshake = async () => {
      await attachScriptedHostPort(viewer.cdp);
      const hello = await evaluate(viewer.cdp, 'window.__sentToHost.splice(0).find((message) => message.type === "hello")');
      await drive(hello);
      await forward(await collect());
    };
    const add = (ws, sse) => evaluate(host.cdp, `(() => {
      const append = (queue, events) => {
        for (const event of events) window.__streamQueues[queue].push({ socketId: 1, at: Date.now(), ...event });
      };
      append('ws', ${JSON.stringify(ws)}); append('sse', ${JSON.stringify(sse)}); return true;
    })()`);
    const awaitStates = (page, statuses) => waitForImportResult(page.cdp,
      `(() => { const rows = ${readRows}; return rows.map((row) => row.status).join(',') === ${JSON.stringify(statuses.join(','))} && rows; })()`);
    const openAttempt = (url) => ({ kind: 'ws-open-attempt', url });
    const close = { kind: 'ws-closed' };
    try {
      viewer = await launchPanelPage({ executable: browserExecutable, query: '?view=window&src=7', initScript: VIEWER_STUB });
      await viewer.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await handshake();
      await drive({ type: 'command', commandId: 1, name: 'stream-toggle', args: {} });
      await add([openAttempt('wss://capture.example.test/ws')], [openAttempt('https://capture.example.test/sse')]);
      const initial = await awaitStates(host, ['Connecting', 'Connecting']);
      expect(initial?.map((row) => row.method)).toEqual(['WS', 'SSE']);
      await forward(await collect());
      expect(await awaitStates(viewer, ['Connecting', 'Connecting'])).toEqual(initial);

      const open = { kind: 'ws-open' };
      const receive = { kind: 'ws-received', preview: 'synthetic frame' };
      await add([open, receive, receive], [open, receive]);
      const opened = await awaitStates(host, ['Open', 'Open']);
      const updates = (await collect()).filter((message) => message.type === 'row');
      expect(updates.map((message) => String(message.row.id))).toEqual(initial.map((row) => row.id));
      await forward(updates);
      expect(await awaitStates(viewer, ['Open', 'Open'])).toEqual(opened);
      await forward(updates);
      expect(await evaluate(viewer.cdp, readRows)).toEqual(opened);

      const answerBody = async (request, content) => forward([{
        type: 'body-result', requestId: request.requestId, viewer: request.viewer, ok: true, content, encoding: '',
      }]);
      const lastBodyRequest = () => evaluate(viewer.cdp, `window.__sentToHost.filter((m) => m.type === 'body-request').at(-1)`);
      await evaluate(viewer.cdp, `
        document.querySelector('#tbody tr').click();
        document.querySelector('#ws-tab-details').click();
        document.querySelector('#res-tab-raw').click(); true`);
      const firstBody = await waitForImportResult(viewer.cdp, `window.__sentToHost.find((m) => m.type === 'body-request')`);
      expect(firstBody).toBeTruthy();
      await answerBody(firstBody, 'synthetic frame');
      expect(await waitForImportResult(viewer.cdp, "document.querySelector('#res-raw .pane-search-input') != null")).toBe(true);
      await evaluate(viewer.cdp, `(() => {
        const tab = document.querySelector('#res-tab-raw');
        tab.focus();
        tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
        const input = document.activeElement;
        input.value = 'synthetic'; input.setSelectionRange(2, 5); return true;
      })()`);
      await add([receive], []);
      expect(await waitForImportResult(host.cdp, "window.__fromHost.some((message) => message.type === 'row')")).toBe(true);
      const changedTranscript = (await collect()).find((message) => message.type === 'row');
      expect(changedTranscript.row.streamRevision).toBeGreaterThan(updates[0].row.streamRevision);
      await forward([changedTranscript]);
      await evaluate(viewer.cdp, 'new Promise(requestAnimationFrame).then(() => true)', true);
      expect(await evaluate(viewer.cdp, `[
        document.activeElement.matches('#res-raw .pane-search-input'),
        document.activeElement.value, document.activeElement.selectionStart, document.activeElement.selectionEnd,
      ]`)).toEqual([true, 'synthetic', 2, 5]);
      expect((await lastBodyRequest()).requestId).toBe(firstBody.requestId);
      await evaluate(viewer.cdp, "document.querySelector('#res-raw .pane-search-nav').focus();true");
      await evaluate(viewer.cdp, 'new Promise(requestAnimationFrame).then(() => true)', true);
      expect(await evaluate(viewer.cdp, "document.activeElement.matches('#res-raw .pane-search-nav')")).toBe(true);
      await evaluate(viewer.cdp, "document.querySelector('#res-tab-raw').focus();true");
      const refreshedBody = await waitForImportResult(viewer.cdp, `window.__sentToHost.filter((m) => m.type === 'body-request').find((m) => m.requestId > ${firstBody.requestId})`);
      expect(refreshedBody).not.toBeNull();
      await answerBody(refreshedBody, 'updated transcript');
      expect(await waitForImportResult(viewer.cdp, "document.querySelector('#res-raw').textContent.includes('updated transcript')")).toBe(true);

      // Close while recording is paused and while the mirror is disconnected.
      await evaluate(viewer.cdp, `window.__oldStreamPort = window.__hostListeners.message[0];
        window.__hostListeners.disconnect.forEach((fn) => fn()); true`);
      await evaluate(host.cdp, 'window.__hostPortDisconnect(); true');
      await evaluate(host.cdp, "document.querySelector('#pauseBtn').click();true");
      await add([close], []);
      const closed = await awaitStates(host, ['Closed', 'Open']);
      await evaluate(host.cdp, 'window.__navigateStreamHost(); true');
      const navigated = await awaitStates(host, ['Closed', 'Navigated']);
      expect(navigated?.map((row) => row.id)).toEqual(initial.map((row) => row.id));
      expect(closed?.map((row) => row.id)).toEqual(initial.map((row) => row.id));
      expect(await evaluate(viewer.cdp, readRows)).toEqual(opened);
      await handshake();
      expect(await awaitStates(viewer, ['Closed', 'Navigated'])).toEqual(navigated);
      await evaluate(viewer.cdp, `${JSON.stringify(updates.map((message) => ({ ...message,
        row: { ...message.row, streamRevision: message.row.streamRevision + 100 },
      })))}.forEach(window.__oldStreamPort); true`);
      expect(await evaluate(viewer.cdp, readRows)).toEqual(navigated);
    } finally {
      if (viewer) await viewer.close();
      await host.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'pop-out HAR exports preserve current WebSocket frames, omissions and reconnect identity',
  async () => {
    const host = await launchPanelPage({
      executable: browserExecutable,
      initScript: HOST_STUB + `
        window.__wsEvents = [];
        const originalEval = chrome.devtools.inspectedWindow.eval;
        chrome.devtools.inspectedWindow.eval = (source, cb) => {
          if (source.includes('function pageDrainStream') && source.includes('__networkPlusWS__')) {
            cb(JSON.stringify(window.__wsEvents.splice(0)), undefined);
          } else if (source.includes('function pageDrainStream') && source.includes('__networkPlusSSE__')) {
            cb('[]', undefined);
          } else originalEval(source, cb);
        };
        // Runtime ports clone messages rather than keeping references to rows.
        const pushHostMessage = window.__fromHost.push.bind(window.__fromHost);
        window.__fromHost.push = (message) => pushHostMessage(JSON.parse(JSON.stringify(message)));
      `,
    });
    let viewer;
    const traffic = [];
    try {
      await evaluate(host.cdp, `(() => {
        const har = ${MINI_HAR};
        const entry = har.log.entries[0];
        entry.request.url = 'wss://synthetic.invalid/imported';
        entry.response.status = 101;
        entry.response.content = { mimeType: 'websocket', size: 0, text: '' };
        entry._webSocketMessages = Array.from({ length: 1002 }, (_, index) => ({
          type: index % 2 ? 'receive' : 'send', time: 1700000000 + index / 1000,
          opcode: index === 1 ? 2 : 1, data: index === 1 ? 'AP8=' : 'private-frame-' + index,
        }));
        const files = new DataTransfer();
        files.items.add(new File([JSON.stringify(har)], 'websocket.har'));
        const input = document.querySelector('#importFile');
        input.files = files.files; input.dispatchEvent(new Event('change'));
        return true;
      })()`);
      expect(await waitForImportResult(host.cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length === 1"))
        .toBe(true);
      viewer = await launchPanelPage({
        executable: browserExecutable, query: '?view=window&src=7', initScript: VIEWER_STUB,
      });
      await attachScriptedHostPort(viewer.cdp);
      const relay = async () => {
        const toHost = await evaluate(viewer.cdp, 'window.__sentToHost.splice(0)');
        if (toHost.length) {
          traffic.push(...toHost.map((message) => ({ direction: 'to-host', ...message })));
          await evaluate(host.cdp, `(() => {
            for (const message of ${JSON.stringify(toHost)}) window.__hostPortListener(message);
            return true;
          })()`);
        }
        const toViewer = await evaluate(host.cdp, 'window.__fromHost.splice(0)');
        if (toViewer.length) {
          traffic.push(...toViewer.map((message) => ({ direction: 'to-viewer', ...message })));
          await evaluate(viewer.cdp, `(() => {
            for (const message of ${JSON.stringify(toViewer)}) window.__send(message);
            return true;
          })()`);
        }
      };
      const waitWithRelay = async (page, expression) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          await relay();
          const result = await evaluate(page.cdp, expression);
          if (result) return result;
          await delay(25);
        }
        throw new Error('The WebSocket mirror fixture did not reach: ' + expression);
      };
      expect(await waitWithRelay(viewer, "document.querySelectorAll('#tbody tr[data-row-id]').length === 1"))
        .toBe(true);
      for (const page of [host, viewer]) {
        await evaluate(page.cdp, `(() => {
          window.__harExports = [];
          URL.createObjectURL = (blob) => { window.__harExports.push(blob); return 'blob:synthetic-websocket-har'; };
          HTMLAnchorElement.prototype.click = () => {};
          return true;
        })()`);
      }
      const exportHar = async (page, mode) => {
        const index = await evaluate(page.cdp, `(() => {
          const index = window.__harExports.length;
          document.querySelector('#exportHarBtn').click();
          document.querySelector(${JSON.stringify(mode === 'full' ? '#dataSafetyFullBtn' : '#dataSafetySanitizedBtn')}).click();
          ${mode === 'full' ? "document.querySelector('#dataSafetyConfirmBtn').click();" : ''}
          return index;
        })()`);
        await waitWithRelay(page, `window.__harExports.length === ${index + 1} && !document.querySelector('#exportHarBtn').disabled`);
        return evaluate(page.cdp, `window.__harExports[${index}].text().then(JSON.parse)`, true);
      };

      const hostImported = (await exportHar(host, 'full')).log.entries[0];
      const viewerImported = (await exportHar(viewer, 'full')).log.entries[0];
      expect(hostImported._webSocketMessages).toHaveLength(1000);
      expect(viewerImported.request.method).toBe('GET');
      expect(viewerImported._webSocketMessages).toEqual(hostImported._webSocketMessages);
      expect(viewerImported._networkPlus.webSocketExport).toEqual({
        droppedFrames: 2, binaryFramesWithoutPayload: 1, textPreviewLimit: 2048,
      });
      expect(viewerImported._webSocketMessages[0]).toEqual({ type: 'send', time: 1700000000, opcode: 1, data: 'private-frame-0' });
      expect(viewerImported._webSocketMessages[1]).toEqual({ type: 'receive', time: 1700000000.001, opcode: 2 });
      const sanitizedStart = traffic.length;
      const sanitized = (await exportHar(viewer, 'sanitized')).log.entries[0];
      expect(sanitized._webSocketMessages).toBeUndefined();
      expect(sanitized._networkPlus.webSocketFramesOmitted).toBe(1000);
      expect(JSON.stringify(sanitized)).not.toMatch(/private-frame-|AP8=/);
      const sanitizedTraffic = traffic.slice(sanitizedStart);
      expect(sanitizedTraffic.filter((message) => message.type === 'ws-export-result')).toEqual([
        expect.objectContaining({ count: 1000, complete: true }),
      ]);
      expect(sanitizedTraffic.some((message) => 'frames' in message || message.type === 'body-request')).toBe(false);

      await evaluate(viewer.cdp, "document.querySelector('#tbody tr[data-row-id]').click(); true");
      const hasImportedHistory = `!document.querySelector('#ws-messages-panel').hidden &&
        document.querySelector('#ws-messages-panel .ws-message:last-child .ws-message-snippet')?.textContent === 'private-frame-1001' &&
        document.querySelector('#ws-messages-status').textContent.includes('902')`;
      expect(await waitWithRelay(viewer, hasImportedHistory)).toBe(true);
      expect(await evaluate(viewer.cdp, `document.querySelector('#ws-timeline-header').hidden === false &&
        !document.querySelector('#ws-messages-panel details[open], #ws-messages-panel pre')`)).toBe(true);
      await evaluate(viewer.cdp, "document.querySelector('#ws-messages-panel .ws-message:last-child summary').click(); true");
      expect(await waitWithRelay(viewer, `document.querySelector('#ws-messages-panel .ws-message:last-child details[open] pre')?.textContent === 'private-frame-1001'`)).toBe(true);
      const firstMessagesRequest = traffic.find((message) => message.type === 'ws-messages-request');
      expect(firstMessagesRequest).toMatchObject({ minimumRevision: 0 });
      await evaluate(viewer.cdp, "document.querySelector('#ws-tab-details').click(); true");

      await evaluate(host.cdp, `(() => {
        document.querySelector('#pauseBtn').click();
        window.__wsEvents.push(
          { socketId: 9, kind: 'ws-open-attempt', at: 1700000010000, url: 'wss://synthetic.invalid/live' },
          { socketId: 9, kind: 'ws-open', at: 1700000010001 },
        );
        document.querySelector('#wsCaptureBtn').click();
        return true;
      })()`);
      await waitWithRelay(viewer, "document.querySelectorAll('#tbody tr[data-row-id]').length === 2");
      const liveEntry = (har) => har.log.entries.find((entry) => entry.request.url.endsWith('/live'));
      const emptyLive = liveEntry(await exportHar(viewer, 'full'));
      expect(emptyLive._webSocketMessages).toBeUndefined();
      expect(emptyLive._networkPlus?.webSocketExport).toBeUndefined();
      await evaluate(host.cdp, `window.__wsEvents.push(
        { socketId: 9, kind: 'ws-sent', at: 1700000010002, preview: 'live-send' },
        { socketId: 9, kind: 'ws-received', at: 1700000010003, preview: 'live-first' },
      ); true`);
      await waitWithRelay(host, 'window.__wsEvents.length === 0');
      const firstLive = liveEntry(await exportHar(viewer, 'full'));
      expect(firstLive._webSocketMessages.map(({ data }) => data)).toEqual(['live-send', 'live-first']);
      await evaluate(host.cdp, `window.__wsEvents.push({ socketId: 9, kind: 'ws-received', at: 1700000010004, preview: 'live-later' }); true`);
      await waitWithRelay(host, 'window.__wsEvents.length === 0');
      const laterLive = liveEntry(await exportHar(viewer, 'full'));
      expect(laterLive._webSocketMessages).toEqual([
        { type: 'send', time: 1700000010.002, opcode: 1, data: 'live-send' },
        { type: 'receive', time: 1700000010.003, opcode: 1, data: 'live-first' },
        { type: 'receive', time: 1700000010.004, opcode: 1, data: 'live-later' },
      ]);

      // A same-session reconnect supplies the same IDs and transcripts again.
      const reconnectStart = traffic.length;
      await evaluate(viewer.cdp, 'window.__hostListeners.disconnect.forEach((fn) => fn()); true');
      await attachScriptedHostPort(viewer.cdp);
      await relay();
      expect(await evaluate(viewer.cdp, "document.querySelector('#ws-tab-details').getAttribute('aria-selected')")).toBe('true');
      expect(traffic.slice(reconnectStart).some((message) => message.type === 'ws-messages-request')).toBe(false);
      await evaluate(viewer.cdp, "document.querySelector('#ws-tab-messages').click(); true");
      expect(await waitWithRelay(viewer, hasImportedHistory)).toBe(true);
      const refreshedMessages = traffic.slice(reconnectStart).filter((message) => message.type === 'ws-messages-request');
      expect(refreshedMessages).toEqual([
        expect.objectContaining({ rowId: firstMessagesRequest.rowId, session: firstMessagesRequest.session, minimumRevision: 0 }),
      ]);
      expect(refreshedMessages[0].requestId).not.toBe(firstMessagesRequest.requestId);
      const reconnected = await exportHar(viewer, 'full');
      expect(reconnected.log.entries).toHaveLength(2);
      expect(liveEntry(reconnected)._webSocketMessages).toEqual(laterLive._webSocketMessages);
      expect(liveEntry(reconnected).request.postData).toEqual(laterLive.request.postData);
      expect(reconnected.log.entries[0]._webSocketMessages).toEqual(hostImported._webSocketMessages);
      const requests = traffic.filter((message) => message.type === 'ws-export-request');
      expect(requests.some((message) => message.includeFrames === false)).toBe(true);
      expect(requests.some((message) => message.includeFrames === true)).toBe(true);
    } finally {
      if (viewer) await viewer.close();
      await host.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'legacy live-stream HAR exports omit unavailable snapshots before and after disconnect',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable, query: '?view=window&src=7', initScript: VIEWER_STUB,
    });
    try {
      await attachScriptedHostPort(page.cdp);
      const row = wireRow(1);
      Object.assign(row, { streamRevision: 1, webSocket: true });
      Object.assign(row.request, {
        method: 'WS', url: 'wss://synthetic.invalid/legacy-live', bodySize: 31,
        postData: { mimeType: 'text/plain', text: 'private legacy live request' },
      });
      Object.assign(row.response, {
        status: '', statusText: 'Open', httpVersion: 'WS', headers: [], bodySize: 23,
        content: { mimeType: 'websocket', size: 23 },
      });
      await evaluate(page.cdp, `(() => {
        window.__send({ type: 'snapshot-start', generation: 1, total: 1, session: 'legacy-live-host',
          protocolVersion: 2, webSocketExport: true });
        window.__send({ type: 'snapshot-rows', generation: 1, rows: [${JSON.stringify(row)}] });
        window.__send({ type: 'snapshot-end', generation: 1 });
        window.__exports = [];
        URL.createObjectURL = (blob) => { window.__exports.push(blob); return 'blob:synthetic-legacy-live-har'; };
        HTMLAnchorElement.prototype.click = () => {};
        return true;
      })()`);
      expect(await waitForImportResult(page.cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length === 1"))
        .toBe(true);
      for (const disconnected of [false, true]) {
        const index = await evaluate(page.cdp, `(() => {
          ${disconnected ? 'window.__hostListeners.disconnect.forEach((listener) => listener());' : ''}
          const index = window.__exports.length;
          document.querySelector('#exportHarBtn').click();
          document.querySelector('#dataSafetyFullBtn').click();
          document.querySelector('#dataSafetyConfirmBtn').click();
          return index;
        })()`);
        expect(await waitForImportResult(page.cdp, `window.__exports.length === ${index + 1} && !document.querySelector('#exportHarBtn').disabled`))
          .toBe(true);
        const har = await evaluate(page.cdp, `window.__exports[${index}].text().then(JSON.parse)`, true);
        expect(har.log.entries).toHaveLength(1);
        const entry = har.log.entries[0];
        expect(entry).toMatchObject({
          startedDateTime: row.startedDateTime, time: row.time,
          request: { method: 'WS', url: row.request.url, bodySize: 31 },
          response: { statusText: 'Open', httpVersion: 'WS', bodySize: 23, content: { size: 23, mimeType: 'websocket' } },
          _networkPlus: {
            streamHarExport: { snapshotUnavailable: true },
            webSocketExport: { mirrorFramesUnavailable: true },
          },
        });
        expect(entry.request.postData).toBeUndefined();
        expect(entry.response.content.text).toBeUndefined();
        expect(entry._webSocketMessages).toBeUndefined();
        expect(JSON.stringify(har)).not.toContain('private legacy live request');
        expect(await evaluate(page.cdp, 'document.querySelector("#statusText").textContent'))
          .toContain('Stream data was omitted for 1 requests because a consistent snapshot was unavailable.');
      }
      expect(await evaluate(page.cdp, `window.__sentToHost.filter((message) =>
        ['body-request', 'ws-export-request', 'stream-har-request'].includes(message.type))`)).toEqual([]);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'legacy pop-out HAR exports mark unavailable frames and sanitize form-labelled transcripts',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable, query: '?view=window&src=7', initScript: VIEWER_STUB,
    });
    try {
      await attachScriptedHostPort(page.cdp);
      const row = wireRow(1);
      row.request.url = 'https://synthetic.invalid/legacy';
      row.request.postData = { mimeType: 'application/x-www-form-urlencoded', text: 'legacy-private-request=value' };
      row.response.status = 101;
      row.response.headers = [{ name: 'Upgrade', value: 'websocket' }];
      row.response.content.mimeType = 'application/x-www-form-urlencoded';
      // Older hosts send the existing protocol without the WS export capability.
      await sendSnapshot(page.cdp, [row], syncControl());
      expect(await waitForImportResult(page.cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length === 1"))
        .toBe(true);
      await evaluate(page.cdp, `(() => {
        window.__harExports = [];
        URL.createObjectURL = (blob) => { window.__harExports.push(blob); return 'blob:synthetic-legacy-har'; };
        HTMLAnchorElement.prototype.click = () => {};
        const messages = window.__sentToHost;
        const push = messages.push.bind(messages);
        messages.push = (message) => {
          const length = push(message);
          if (message.type === 'body-request') queueMicrotask(() => window.__send({
            type: 'body-result', requestId: message.requestId, viewer: message.viewer,
            ok: true, content: 'legacy-private-response=value', encoding: '',
          }));
          return length;
        };
        return true;
      })()`);
      const exportHar = async (mode) => {
        const index = await evaluate(page.cdp, `(() => {
          const index = window.__harExports.length;
          document.querySelector('#exportHarBtn').click();
          document.querySelector(${JSON.stringify(mode === 'full' ? '#dataSafetyFullBtn' : '#dataSafetySanitizedBtn')}).click();
          ${mode === 'full' ? "document.querySelector('#dataSafetyConfirmBtn').click();" : ''}
          return index;
        })()`);
        expect(await waitForImportResult(page.cdp, `window.__harExports.length === ${index + 1} && !document.querySelector('#exportHarBtn').disabled`))
          .toBe(true);
        return evaluate(page.cdp, `window.__harExports[${index}].text().then(JSON.parse)`, true);
      };
      const full = (await exportHar('full')).log.entries[0];
      expect(full._webSocketMessages).toBeUndefined();
      expect(full).toMatchObject({ _networkPlus: { webSocketExport: { mirrorFramesUnavailable: true } } });
      expect(full.request.postData.text).toBe('legacy-private-request=value');
      expect(full.response.content.text).toBe('legacy-private-response=value');
      const sanitized = (await exportHar('sanitized')).log.entries[0];
      expect(sanitized._webSocketMessages).toBeUndefined();
      expect(sanitized.request.postData._networkPlus.status).toBe('omitted');
      expect(sanitized.response.content._networkPlus.status).toBe('omitted');
      expect(JSON.stringify(sanitized)).not.toMatch(/legacy-private-request|legacy-private-response/);
      expect(await evaluate(page.cdp, "window.__sentToHost.some((message) => message.type === 'ws-export-request')"))
        .toBe(false);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'pending mirror rows update in place through pushes and snapshots without reopening closed details',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable, query: '?view=window&src=7', initScript: VIEWER_STUB,
    });
    const pending = (id) => ({ ...wireRow(id), pending: true, time: 0, response: { status: 0, headers: [], content: {} } });
    const done = (id, status) => ({ ...wireRow(id), response: { ...wireRow(id).response, status } });
    const states = () => evaluate(page.cdp, `Array.from(document.querySelectorAll('#tbody tr[data-row-id]'))
      .map((row) => [row.dataset.rowId, row.querySelector('[data-col-id="status"]').textContent])`);
    try {
      await attachScriptedHostPort(page.cdp);
      expect(await evaluate(page.cdp, "window.__sentToHost.find((m) => m.type === 'hello').pendingRows")).toBe(true);
      await sendSnapshot(page.cdp, [pending(1), wireRow(2)], syncControl());
      expect(await waitForImportResult(page.cdp, "document.querySelector('#tbody tr[data-row-id=\"1\"] [data-col-id=status]')?.textContent === 'Pending'")).toBe(true);
      await evaluate(page.cdp, "document.querySelector('#tbody tr[data-row-id=\"1\"]').click(); true");
      expect(await evaluate(page.cdp, "window.__sentToHost.filter((m) => m.type === 'body-request').length")).toBe(0);
      await evaluate(page.cdp, `window.__send({ type: 'row', row: ${JSON.stringify(done(1, 201))} }); true`);
      expect(await waitForImportResult(page.cdp, "document.querySelector('.details-summary-status')?.textContent.includes('201')")).toBe(true);
      expect(await states()).toEqual([['1', '201'], ['2', '200']]);
      expect(await evaluate(page.cdp, "document.querySelector('#tbody tr[data-row-id=\"1\"]').getAttribute('aria-selected')")).toBe('true');
      // A delayed provisional push must never regress a finished row.
      await evaluate(page.cdp, `window.__send({ type: 'row', row: ${JSON.stringify(pending(1))} }); true`);
      expect(await states()).toEqual([['1', '201'], ['2', '200']]);

      await sendSnapshot(page.cdp, [done(1, 201), wireRow(2), pending(3)], syncControl({ paused: true }));
      await evaluate(page.cdp, `(() => {
        document.querySelector('#tbody tr[data-row-id="3"]').click();
        document.querySelector('#tbody tr[data-row-id="3"]').focus();
        const language = document.querySelector('#langSelect');
        language.value = 'ja'; language.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      expect((await states()).at(-1)).toEqual(['3', '応答待ち']);
      expect(await waitForImportResult(page.cdp, "document.querySelector('#res-body').textContent.includes('レスポンスの完了を待っています。')")).toBe(true);
      expect(await evaluate(page.cdp, 'document.activeElement.dataset.rowId')).toBe('3');
      await evaluate(page.cdp, 'document.querySelector("#detailsCloseBtn").click(); true');
      await sendSnapshot(page.cdp, [done(1, 201), wireRow(2), done(3, 204)], syncControl({ paused: true }));
      expect(await states()).toEqual([['1', '201'], ['2', '200'], ['3', '204']]);
      expect(await evaluate(page.cdp, 'document.querySelector("#details").hidden')).toBe(true);
      expect(await evaluate(page.cdp, 'document.documentElement.lang')).toBe('ja');
      // Host Clear/Undo snapshots retain the host's IDs and capture order.
      await sendSnapshot(page.cdp, [], syncControl({ undoAvailable: true }));
      expect(await states()).toEqual([]);
      await sendSnapshot(page.cdp, [done(1, 201), wireRow(2), done(3, 204)], syncControl());
      expect(await states()).toEqual([['1', '201'], ['2', '200'], ['3', '204']]);
      await evaluate(page.cdp, 'window.__hostListeners.disconnect.forEach((fn) => fn()); true');
      expect(await states()).toEqual([['1', '201'], ['2', '200'], ['3', '204']]);
      expect(await evaluate(page.cdp, 'document.querySelector("#statusText").textContent')).toContain('接続が切れました');
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'the hidden host polls on request only from a connected capable viewer',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable,
      initScript: HOST_STUB + `
        window.__testHidden = true;
        window.__harEntries = [];
        window.__harPolls = 0;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__testHidden });
        chrome.devtools.network.getHAR = (callback) => {
          window.__harPolls += 1; callback({ entries: window.__harEntries });
        };
      `,
    });
    const drive = (message) => evaluate(page.cdp, `window.__hostPortListener(${JSON.stringify(message)}); true`);
    const snapshotRows = async () => {
      await evaluate(page.cdp, 'window.__fromHost.length = 0; true');
      await drive({ type: 'snapshot-request' });
      return evaluate(page.cdp, "window.__fromHost.filter((m) => m.type === 'snapshot-rows').flatMap((m) => m.rows)");
    };
    try {
      await drive({ type: 'hello', protocolVersion: 2 });
      await drive({ type: 'poll-pending' });
      await delay(1100);
      expect(await evaluate(page.cdp, 'window.__harPolls')).toBe(0);
      await evaluate(page.cdp, `(() => {
        window.__first = {
          startedDateTime: new Date().toISOString(), time: 0,
          request: { method: 'GET', url: 'https://mirror.example.test/first', headers: [] },
          response: { status: 0, headers: [], content: {} },
        };
        window.__harEntries = [window.__first]; return true;
      })()`);
      await drive({ type: 'hello', protocolVersion: 2, pendingRows: true });
      expect(await evaluate(page.cdp, 'window.__harPolls')).toBe(0);
      await drive({ type: 'poll-pending' });
      expect(await waitForImportResult(page.cdp, "window.__fromHost.some((m) => m.type === 'row' && m.row.pending === true)")).toBe(true);
      expect((await snapshotRows()).map((row) => [row.id, row.pending])).toEqual([[1, true]]);
      await drive({ type: 'hello', protocolVersion: 2 });
      expect(await snapshotRows()).toEqual([]);
      await drive({ type: 'hello', protocolVersion: 2, pendingRows: true });
      await drive({ type: 'command', commandId: 1, name: 'clear', args: {} });
      expect(await snapshotRows()).toEqual([]);
      await evaluate(page.cdp, `(() => {
        const done = { ...window.__first, time: 900,
          response: { status: 200, headers: [], content: { size: 0, mimeType: 'text/plain' } },
          getContent: (callback) => callback('', ''),
        };
        window.__harEntries = [done];
        window.__requestListeners.forEach((fn) => fn(done)); return true;
      })()`);
      expect(await snapshotRows()).toEqual([]);
      await drive({ type: 'command', commandId: 2, name: 'undo-clear', args: {} });
      expect((await snapshotRows()).map((row) => [row.id, row.pending, row.response.status])).toEqual([[1, undefined, 200]]);
      await evaluate(page.cdp, 'window.__hostPortDisconnect(); true');
      const polls = await evaluate(page.cdp, 'window.__harPolls');
      await delay(1100);
      expect(await evaluate(page.cdp, 'window.__harPolls')).toBe(polls);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'mirror auto-scroll survives host Clear resync and follows new requests',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable,
      query: '?view=window&src=7',
      initScript: VIEWER_STUB,
      width: 1280,
      height: 480,
    });
    try {
      await attachScriptedHostPort(page.cdp);
      const settle = () =>
        evaluate(page.cdp, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
      const snapshot = () =>
        evaluate(
          page.cdp,
          `(() => {
            const tableWrap = document.querySelector('#tableWrap');
            return {
              rows: document.querySelectorAll('#tbody tr[data-row-id]').length,
              pressed: document.querySelector('#autoScrollBtn').getAttribute('aria-pressed'),
              atBottom: tableWrap.scrollTop + tableWrap.clientHeight >= tableWrap.scrollHeight - 2,
              scrollTop: tableWrap.scrollTop,
            };
          })()`,
        );
      const initialRows = Array.from({ length: 60 }, (_, index) => wireRow(index + 1));
      await sendSnapshot(page.cdp, initialRows, syncControl());
      await settle();
      const initial = await snapshot();
      await sendSnapshot(page.cdp, [], syncControl({ undoAvailable: true }));
      await settle();
      const afterClear = await snapshot();
      const newRows = Array.from({ length: 60 }, (_, index) => wireRow(index + 61));
      await evaluate(
        page.cdp,
        `for (const row of ${JSON.stringify(newRows)}) window.__send({ type: 'row', row }); true`,
      );
      await settle();
      const afterClearLive = await snapshot();
      await sendSnapshot(page.cdp, initialRows.concat(newRows), syncControl());
      await settle();
      const afterUndo = await snapshot();
      await evaluate(page.cdp, "document.querySelector('#tableWrap').scrollTop = 0");
      await settle();
      const afterManualScroll = await snapshot();

      expect(initial).toMatchObject({ rows: 60, pressed: 'true', atBottom: true });
      expect(initial.scrollTop).toBeGreaterThan(0);
      expect(afterClear).toMatchObject({ rows: 0, pressed: 'true' });
      expect(afterClearLive).toMatchObject({ rows: 60, pressed: 'true', atBottom: true });
      expect(afterUndo).toMatchObject({ rows: 120, pressed: 'true', atBottom: true });
      expect(afterManualScroll).toMatchObject({ pressed: 'false', atBottom: false });
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'the mirror viewer drives the session remotely and explains the docked case once',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable,
      query: '?view=window&src=7',
      initScript: VIEWER_STUB,
    });
    try {
      await attachScriptedHostPort(page.cdp);
      expect(
        await evaluate(page.cdp, "document.querySelectorAll('.empty-state-action').length"),
      ).toBe(0);
      await sendSnapshot(page.cdp, [wireRow(1), wireRow(2), wireRow(3)], syncControl());
      await delay(300);

      const visible = await evaluate(
        page.cdp,
        `Object.fromEntries(
          ['pauseBtn', 'clearBtn', 'importBtn', 'settingsBtn', 'popoutBtn', 'wsCaptureBtn'].map((id) => {
            const el = document.getElementById(id);
            return [id, el ? !el.hidden && el.getBoundingClientRect().width > 0 : null];
          }),
        )`,
      );
      expect(visible.pauseBtn).toBe(true);
      expect(visible.settingsBtn).toBe(true);
      expect(visible.popoutBtn).toBe(false);
      expect(visible.wsCaptureBtn).toBe(true);

      // Pause is a remote command; the answered sync flips the status line.
      await evaluate(page.cdp, "document.getElementById('pauseBtn').click(); true");
      await delay(100);
      let command = await lastViewerCommand(page.cdp);
      expect(command.name).toBe('pause-toggle');
      await answerCommand(page.cdp, command.commandId, syncControl({ paused: true }));
      await delay(150);
      expect(await evaluate(page.cdp, "document.getElementById('statusText').textContent")).toContain(
        '(recording paused)',
      );

      // Retention travels as retention-set from inside the Settings dialog.
      await evaluate(page.cdp, "document.getElementById('settingsBtn').click(); true");
      await delay(100);
      expect(await evaluate(page.cdp, "document.getElementById('retentionLimit').value")).toBe('20000');
      await evaluate(
        page.cdp,
        `(() => {
          document.getElementById('retentionLimit').value = '500';
          document.getElementById('retentionSaveBtn').click();
          return true;
        })()`,
      );
      await delay(100);
      command = await lastViewerCommand(page.cdp);
      expect(command.name).toBe('retention-set');
      expect(command.args.requestLimit).toBe(500);
      await answerCommand(
        page.cdp,
        command.commandId,
        syncControl({ paused: true, retention: { requestLimit: 500, unlimited: false } }),
      );
      await delay(150);
      expect(await evaluate(page.cdp, "document.getElementById('settingsDialog').open")).toBe(false);
      expect(
        await evaluate(page.cdp, "document.getElementById('retentionStatus').getAttribute('title')"),
      ).toContain('Retention: 500');

      // Import transfers as begin/chunk/end carrying the file bytes.
      await evaluate(
        page.cdp,
        `(() => {
          const input = document.getElementById('viewerImportFile');
          const dt = new DataTransfer();
          dt.items.add(new File([${JSON.stringify(MINI_HAR)}], 'transfer.har', { type: 'application/json' }));
          input.files = dt.files;
          input.dispatchEvent(new Event('change'));
          return true;
        })()`,
      );
      await delay(300);
      const importParts = await evaluate(
        page.cdp,
        `(() => {
          const msgs = window.__sentToHost.filter((m) => m.type && m.type.startsWith('import-'));
          return {
            begin: msgs.find((m) => m.type === 'import-begin') || null,
            end: msgs.some((m) => m.type === 'import-end'),
            data: msgs.filter((m) => m.type === 'import-chunk').map((m) => m.data).join(''),
          };
        })()`,
      );
      expect(importParts.begin.fileName).toBe('transfer.har');
      expect(importParts.end).toBe(true);
      expect(Buffer.from(importParts.data, 'base64').toString('utf8')).toBe(MINI_HAR);

      await evaluate(page.cdp, `window.__send({
        type: 'command-result',
        commandId: ${importParts.begin.commandId},
        ok: true,
      }); true`);

      // The docked report raises the undock explainer exactly once per load,
      // and "Don't show this again" persists across a reload.
      await evaluate(
        page.cdp,
        `window.__send({ type: 'sync', count: 3, maxId: 3, paused: true, control: ${JSON.stringify(
          syncControl({ paused: true, devtoolsMinimized: false }),
        )} }); true`,
      );
      await delay(150);
      expect(await evaluate(page.cdp, "document.getElementById('undockHintDialog').open")).toBe(true);
      await evaluate(
        page.cdp,
        `(() => {
          document.getElementById('undockHintDontShowAgain').checked = true;
          document.getElementById('undockHintCloseBtn').click();
          return true;
        })()`,
      );
      await delay(100);
      expect(await evaluate(page.cdp, "localStorage.getItem('networkPlus.undockHint.v1')")).toBe('1');
      await page.navigate();
      await attachScriptedHostPort(page.cdp);
      await evaluate(
        page.cdp,
        `window.__send({ type: 'sync', count: 0, maxId: 0, paused: false, control: ${JSON.stringify(
          syncControl({ devtoolsMinimized: false }),
        )} }); true`,
      );
      await delay(150);
      expect(await evaluate(page.cdp, "document.getElementById('undockHintDialog').open")).toBe(false);

      // Language applies to explanations instantly; labels stay English.
      await evaluate(
        page.cdp,
        `(() => {
          const select = document.getElementById('langSelect');
          select.value = 'ja';
          select.dispatchEvent(new Event('change'));
          return true;
        })()`,
      );
      await delay(100);
      const jaTexts = await evaluate(
        page.cdp,
        `(() => ({
          help: document.getElementById('langHelp').textContent,
          label: document.querySelector('label[for="retentionLimit"]').textContent,
          searchTitle: document.getElementById('searchToggleBtn').title,
          resendIntro: document.getElementById('resendDialogIntro').textContent,
          emptyDesc: (document.getElementById('empty-state-description') || {}).textContent || '',
        }))()`,
      );
      expect(jaTexts.help).toBe(
        '説明文とすべてのダイアログ(項目名を含む)に適用されます。ツールバーのボタンと列見出しは英語のままです。',
      );
      // The Settings dialog now localizes its own item names too, so the label
      // the help text points at has to move with it.
      expect(jaTexts.label).toBe('保持するリクエストの最大数');
      // Wave 2: tooltips, dialog prose, and the JS-composed empty state all
      // swap in place from the same dictionary.
      expect(jaTexts.searchTitle).toBe('検索パネルを開閉 (Ctrl+F)');
      expect(jaTexts.resendIntro).toContain('検査対象ページと同じオリジン');
      expect(jaTexts.emptyDesc).toBe(
        'リクエストは DevTools セッションから流れてきます。ガイド付きローカルサンプルは DevTools 側でのみ使えます。',
      );

      // A disconnected remote resend reports inside the dialog and keeps it
      // open with the edited request instead of throwing.
      await sendSnapshot(page.cdp, [wireRow(1)], syncControl());
      await delay(250);
      await evaluate(page.cdp, 'window.__hostListeners.disconnect.forEach((fn) => fn()); true');
      await delay(100);
      await evaluate(
        page.cdp,
        `(() => {
          const row = document.querySelector('#tbody tr[data-row-id="1"]');
          const rect = row.getBoundingClientRect();
          row.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 5, clientY: rect.top + 5 }),
          );
          return true;
        })()`,
      );
      await delay(150);
      // The panel is in Japanese here, and the row menu now translates with
      // it — an English label at this point is the mixed-language bug back.
      await evaluate(
        page.cdp,
        `(() => {
          const labels = Array.from(document.querySelectorAll('.context-menu-item')).map((el) => el.textContent);
          if (labels.includes('Edit and resend...')) {
            throw new Error('The row menu kept an English label while the panel was Japanese: ' + labels.join(' | '));
          }
          const item = Array.from(document.querySelectorAll('.context-menu-item')).find(
            (el) => el.textContent === '編集して再送...',
          );
          if (!item) throw new Error('The Japanese resend entry was missing: ' + labels.join(' | '));
          item.click();
          return true;
        })()`,
      );
      await delay(150);
      await evaluate(page.cdp, "document.getElementById('resendSendBtn').click(); true");
      await delay(150);
      const resendState = await evaluate(
        page.cdp,
        `(() => ({
          open: document.getElementById('resendDialog').open,
          hidden: document.getElementById('resendError').hidden,
          error: document.getElementById('resendError').textContent,
        }))()`,
      );
      expect(resendState.open).toBe(true);
      expect(resendState.hidden).toBe(false);
      // The dialog error translates with the panel language ('system' follows
      // the browser locale), so the pin accepts the frame in either language.
      expect(/^(Re-send failed:|再送信に失敗しました:)/.test(resendState.error)).toBe(true);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'the host executes remote commands against its own controls and answers each one',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable,
      initScript: HOST_STUB + `
        const evalOrigin = chrome.devtools.inspectedWindow.eval;
        chrome.devtools.inspectedWindow.eval = (source, cb) => {
          if (source === 'location.origin') cb('https://api.example.test');
          else evalOrigin(source, cb);
        };
        window.__replayInjections = [];
        chrome.scripting = {
          executeScript: async ({ target, world, args }) => {
            window.__replayInjections.push({ target, world, args });
            if (target.frameIds) return [{ documentId: 'active-doc', result: true }];
            return [{ documentId: 'active-doc', result: { status: 200 } }];
          },
        };
      `,
    });
    try {
      // One captured live row so the snapshot has content.
      await evaluate(
        page.cdp,
        `(() => {
          const entry = {
            startedDateTime: new Date().toISOString(),
            time: 50,
            request: { method: 'GET', url: 'https://live.example.test/a', headers: [], postData: null },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/2',
              headers: [],
              bodySize: 2,
              content: { mimeType: 'text/plain', size: 2 },
            },
            timings: {},
            getContent: (cb) => cb('ok', ''),
          };
          window.__requestListeners.forEach((fn) => fn(entry));
          return true;
        })()`,
      );
      await delay(200);
      await evaluate(page.cdp, "document.getElementById('popoutBtn').click(); true");
      await delay(200);
      expect(await evaluate(page.cdp, 'window.__openedUrls')).toEqual(['panel.html?view=window&src=42']);
      expect(await evaluate(page.cdp, 'window.__minimizeCalls')).toBe(1);

      const drive = (message) =>
        evaluate(page.cdp, `window.__hostPortListener(${JSON.stringify(message)}); true`);
      const fromHost = () => evaluate(page.cdp, 'window.__fromHost');

      await drive({ type: 'hello', protocolVersion: 2 });
      await delay(150);
      let messages = await fromHost();
      const firstSync = messages.find((m) => m.type === 'sync');
      expect(firstSync.control.retention.requestLimit).toBe(20000);
      expect(firstSync.control.streamCapture.supported).toBe(true);
      expect(firstSync.control.devtoolsMinimized).toBe(true);

      await drive({ type: 'command', commandId: 11, name: 'pause-toggle', args: {} });
      await delay(150);
      messages = await fromHost();
      expect(messages.find((m) => m.type === 'command-result' && m.commandId === 11).ok).toBe(true);
      expect(messages.filter((m) => m.type === 'sync').at(-1).paused).toBe(true);

      await drive({ type: 'command', commandId: 12, name: 'retention-set', args: { requestLimit: 7, unlimited: false } });
      await delay(150);
      messages = await fromHost();
      const retentionReject = messages.find((m) => m.type === 'command-result' && m.commandId === 12);
      expect(retentionReject.ok).toBe(false);
      expect(retentionReject.error).toContain('100');

      // A transfer that exceeds its declared size is refused mid-flight.
      await drive({ type: 'import-begin', commandId: 13, fileName: 'lie.har', size: 10 });
      await drive({ type: 'import-chunk', commandId: 13, data: 'A'.repeat(64) });
      await delay(100);
      messages = await fromHost();
      expect(messages.find((m) => m.type === 'command-result' && m.commandId === 13).error).toBe(
        'The transfer exceeded its declared size and was refused.',
      );

      // A well-formed transfer imports into the host's own pipeline.
      const harBase64 = Buffer.from(MINI_HAR).toString('base64');
      await drive({ type: 'import-begin', commandId: 14, fileName: 'transfer.har', size: MINI_HAR.length });
      await drive({ type: 'import-chunk', commandId: 14, data: harBase64 });
      await drive({ type: 'import-end', commandId: 14 });
      await delay(400);
      messages = await fromHost();
      expect(messages.find((m) => m.type === 'command-result' && m.commandId === 14).ok).toBe(true);
      expect(await evaluate(page.cdp, "document.querySelectorAll('#tbody tr').length")).toBe(1);
      expect(await evaluate(page.cdp, "document.getElementById('tbody').textContent")).toContain(
        'imported.example.test',
      );

      await drive({ type: 'command', commandId: 15, name: 'stream-toggle', args: {} });
      await delay(200);
      messages = await fromHost();
      expect(messages.find((m) => m.type === 'command-result' && m.commandId === 15).ok).toBe(true);
      expect(await evaluate(page.cdp, "document.getElementById('wsCaptureBtn').textContent")).toBe(
        'Stream capture: On',
      );
      expect(
        await evaluate(page.cdp, "window.__evals.some((s) => s.startsWith('(function pageWebSocketWrapper('))"),
      ).toBe(true);

      await drive({
        type: 'command',
        commandId: 16,
        name: 'resend',
        args: {
          epoch: firstSync.control.resendEpoch,
          spec: { method: 'GET', url: 'https://api.example.test/echo', headers: [], body: '', credentials: true },
        },
      });
      await delay(200);
      messages = await fromHost();
      expect(messages.find((m) => m.type === 'command-result' && m.commandId === 16).ok).toBe(true);
      const [probe, send] = await evaluate(page.cdp, 'window.__replayInjections');
      expect(probe.world).toBe('ISOLATED');
      expect(probe.args[0]).toBe('https://api.example.test');
      expect(send.world).toBe('ISOLATED');
      expect(send.target).toEqual({ tabId: 42, documentIds: ['active-doc'] });
      expect(send.args[0].url).toBe('https://api.example.test/echo');
      expect(await evaluate(page.cdp, "window.__evals.some((source) => source.includes('api.example.test/echo'))")).toBe(false);

      await drive({
        type: 'command',
        commandId: 18,
        name: 'resend',
        args: {
          epoch: firstSync.control.resendEpoch - 1,
          spec: { method: 'GET', url: 'https://api.example.test/echo', headers: [], body: '', credentials: true },
        },
      });
      await delay(100);
      expect((await fromHost()).find((m) => m.type === 'command-result' && m.commandId === 18).error).toBe(
        'resendErrDocumentChanged',
      );
      expect(await evaluate(page.cdp, 'window.__replayInjections.length')).toBe(2);

      await drive({ type: 'command', commandId: 17, name: 'nope', args: {} });
      await delay(100);
      messages = await fromHost();
      expect(messages.find((m) => m.type === 'command-result' && m.commandId === 17).error).toBe(
        'Unknown mirror command: nope',
      );
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'HAR and SAZ import status follows the chosen language and preserves both counts',
  async () => {
    const host = await launchPanelPage({
      executable: browserExecutable,
      initScript: HOST_STUB + `localStorage.setItem('networkPlus.retention.v1', '{"requestLimit":100,"unlimited":false}');`,
    });
    try {
      await evaluate(host.cdp, `(() => {
        const count = 101;
        const har = ${MINI_HAR};
        har.log.entries = Array.from({ length: count }, () => har.log.entries[0]);
        const sessions = {};
        for (let id = 1; id <= count; id++) {
          sessions['raw/' + id + '_c.txt'] = new TextEncoder().encode('GET /saved HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n');
          sessions['raw/' + id + '_s.txt'] = new TextEncoder().encode('HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok');
        }
        window.__syntheticImports = {
          HAR: new File([JSON.stringify(har)], 'test.HAR'),
          SAZ: new File([fflate.zipSync(sessions)], 'test.SAZ'),
        };
        return true;
      })()`);
      const readStatus = "document.querySelector('#statusText').textContent";
      const finished = "document.querySelector('#importBtn').getAttribute('aria-busy') === 'false'";
      for (const format of ['HAR', 'SAZ']) {
        for (const language of ['en', 'ja']) {
          const progress = await evaluate(host.cdp, `(() => {
            const select = document.querySelector('#langSelect');
            select.value = ${JSON.stringify(language)};
            select.dispatchEvent(new Event('change', { bubbles: true }));
            const input = document.querySelector('#importFile');
            const transfer = new DataTransfer();
            transfer.items.add(window.__syntheticImports[${JSON.stringify(format)}]);
            input.files = transfer.files;
            input.dispatchEvent(new Event('change'));
            return ${readStatus};
          })()`);
          const result = await waitForImportResult(host.cdp, `${finished} && ${readStatus}`);
          expect({ progress, result }).toEqual(language === 'en' ? {
            progress: `Importing ${format}...`,
            result: `Imported 101 requests from ${format}; retained 100`,
          } : {
            progress: `${format} をインポートしています...`,
            result: `${format} からリクエストを 101 件読み込み、100 件を保持しました。`,
          });
          expect(await evaluate(host.cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length")).toBe(100);
        }
      }
    } finally {
      await host.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'Body and Raw search keep dense match plans bounded and report only actual overflow',
  async () => {
    const page = await launchPanelPage({ executable: browserExecutable, initScript: HOST_STUB });
    try {
      const result = await evaluate(page.cdp, `(async () => {
        const file = document.querySelector('#importFile');
        const body = 'x'.repeat(2000) + 'Y'.repeat(200000);
        const har = ${MINI_HAR};
        har.log.entries[0].response.content.text = body;
        const files = new DataTransfer();
        files.items.add(new File([JSON.stringify(har)], 'dense.har'));
        file.files = files.files;
        file.dispatchEvent(new Event('change'));
        const waitFor = async (predicate) => {
          for (let i = 0; i < 160; i++) {
            if (predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error('The dense pane search fixture timed out');
        };
        await waitFor(() => document.querySelector('#tbody tr[data-row-id]'));
        document.querySelector('#tbody tr[data-row-id]').click();
        const search = async (name, query) => {
          const pane = document.querySelector('#res-' + name);
          const tab = document.querySelector('#res-tab-' + name);
          tab.click();
          tab.focus();
          tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
          const input = pane.querySelector('.pane-search-input');
          const count = pane.querySelector('.pane-search-count');
          const before = count.textContent;
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await waitFor(() => count.textContent !== before);
          return { count: count.textContent, marks: pane.querySelectorAll('mark.pane-search-hit').length };
        };
        await waitFor(() => document.querySelector('#res-body .pane-search-input'));
        const hidden = await search('body', 'Y');
        const rawDense = await search('raw', 'Y');
        const raw = document.querySelector('#res-raw .code-raw');
        const rawTextIntact = raw.textContent.endsWith(body);
        // The extra text node holds no further match. Exactly 1,500 is not overflow.
        raw.textContent = '';
        raw.append(document.createTextNode('x'.repeat(1500)), document.createElement('br'), document.createTextNode('tail'));
        const rawExact = await search('raw', 'x');
        return { hidden, rawDense, rawExact, rawTextIntact };
      })()`, true);
      expect(result).toEqual({
        hidden: { count: 'No matches (+200000 collapsed)', marks: 0 },
        rawDense: { count: '1 / 1500+', marks: 1500 },
        rawExact: { count: '1 / 1500', marks: 1500 },
        rawTextIntact: true,
      });
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'full HAR import and export preserve encoded payload metadata and distinct byte sizes',
  async () => {
    const page = await launchPanelPage({ executable: browserExecutable, query: '?view=offline', initScript: HOST_STUB });
    try {
      const result = await evaluate(page.cdp, `(async () => {
        const input = document.querySelector('#importFile');
        const source = ${MINI_HAR};
        const entry = source.log.entries[0];
        entry.request.bodySize = 0;
        entry.request.postData = { mimeType: 'multipart/form-data', params: [{ name: 'tag', value: 'private-tag' }] };
        entry.response.bodySize = 20;
        entry.response.content = { size: 90, compression: 70, mimeType: 'text/plain', text: 'sample' };
        source.log.entries.push({
          ...entry,
          request: { ...entry.request, bodySize: undefined, postData: { mimeType: 'application/octet-stream', text: 'AP8=', encoding: 'base64' } },
          response: { ...entry.response, bodySize: -1, content: { size: -1, mimeType: 'text/plain' } },
        });
        const files = new DataTransfer();
        files.items.add(new File([JSON.stringify(source)], 'metadata.har'));
        input.files = files.files;
        input.dispatchEvent(new Event('change'));
        const waitFor = async (predicate) => {
          for (let i = 0; i < 160; i++) {
            if (predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error('HAR round-trip fixture timed out');
        };
        await waitFor(() => document.querySelectorAll('#tbody tr[data-row-id]').length === 2);
        const blobs = [];
        URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:synthetic-har'; };
        HTMLAnchorElement.prototype.click = () => {};
        const exportBtn = document.querySelector('#exportHarBtn');
        exportBtn.click();
        document.querySelector('#dataSafetyFullBtn').click();
        document.querySelector('#dataSafetyConfirmBtn').click();
        await waitFor(() => blobs.length === 1 && !exportBtn.disabled);
        exportBtn.click();
        document.querySelector('#dataSafetySanitizedBtn').click();
        await waitFor(() => blobs.length === 2 && !exportBtn.disabled);
        const [full, sanitized] = await Promise.all(blobs.map(async (blob) => JSON.parse(await blob.text())));
        return { full: full.log.entries, sanitized: sanitized.log.entries };
      })()`, true);
      expect(result.full[0].request).toMatchObject({ bodySize: 0, postData: {
        mimeType: 'multipart/form-data', params: [{ name: 'tag', value: 'private-tag' }],
      } });
      expect(result.full[0].request.postData.text).toBeUndefined();
      expect(result.full[0].response).toMatchObject({ bodySize: 20, content: { size: 90, compression: 70 } });
      expect(result.full[1].request).toMatchObject({ bodySize: 2, postData: { text: 'AP8=', encoding: 'base64' } });
      expect(result.full[1].response).toMatchObject({ bodySize: -1, content: { size: -1 } });
      expect(JSON.stringify(result.sanitized)).not.toMatch(/private-tag|AP8=/);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'a HAR above both old source limits imports locally and over the mirror',
  async () => {
    const size = 65 * 1024 * 1024;
    const host = await launchPanelPage({ executable: browserExecutable, initScript: HOST_STUB });
    try {
      const local = await evaluate(
        host.cdp,
        `(() => {
          window.__pickHar = (content) => {
            const file = new File([content, ' '.repeat(${size})], 'large.har');
            const input = document.getElementById('importFile');
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change'));
            return file.size;
          };
          return window.__pickHar(${JSON.stringify(MINI_HAR)});
        })()`,
      );
      expect(local).toBeGreaterThan(size);
      const importStatus = "document.getElementById('statusText').textContent";
      expect(await waitForImportResult(host.cdp, `${importStatus}.includes('Imported 1 requests from HAR') && ${importStatus}`))
        .toContain('retained 1');
      await evaluate(host.cdp, `window.__pickHar('{broken'); true`);
      expect(await waitForImportResult(host.cdp, `${importStatus}.includes('HAR is not valid JSON') && ${importStatus}`))
        .toContain('HAR is not valid JSON');
      expect(await evaluate(host.cdp, "document.querySelector('#tbody tr').textContent")).toContain('imported.example.test');
      expect(await evaluate(host.cdp, "document.getElementById('importBtn').disabled")).toBe(false);

      await evaluate(host.cdp, `(async () => {
        const send = window.__hostPortListener;
        const header = ${JSON.stringify(MINI_HAR.replace('imported.example.test', 'mirror-large.example.test'))};
        const commandId = 31;
        send({ type: 'import-begin', commandId, fileName: 'mirror-large.har', size: header.length + ${size}, stream: true });
        const sendChunk = async (data) => {
          const replies = window.__fromHost;
          const offset = replies.length;
          send({ type: 'import-chunk', commandId, data });
          for (let attempt = 0; attempt < 100; attempt++) {
            const reply = replies.slice(offset).find((m) => m.commandId === commandId);
            if (reply?.type === 'import-ack') return;
            if (reply?.type === 'command-result') throw Error(reply.error);
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          throw Error('Missing import acknowledgment');
        };
        await sendChunk(btoa(header));
        const chunk = 384 * 1024;
        const padding = btoa(' '.repeat(chunk));
        for (let offset = 0; offset < ${size}; offset += chunk) {
          const length = Math.min(chunk, ${size} - offset);
          await sendChunk(length === chunk ? padding : btoa(' '.repeat(length)));
        }
        send({ type: 'import-end', commandId });
        return true;
      })()`, true);
      expect(await waitForImportResult(host.cdp, "window.__fromHost.find((msg) => msg.type === 'command-result' && msg.commandId === 31)"))
        .toMatchObject({ ok: true });
      expect(await evaluate(host.cdp, "document.querySelector('#tbody tr').textContent")).toContain('mirror-large.example.test');
    } finally {
      await host.close();
    }

    const viewer = await launchPanelPage({
      executable: browserExecutable,
      query: '?view=window&src=7',
      initScript: VIEWER_STUB,
    });
    try {
      await attachScriptedHostPort(viewer.cdp);
      const declared = await evaluate(viewer.cdp, `(() => {
        const messages = window.__sentToHost;
        const push = messages.push.bind(messages);
        messages.push = (message) => {
          const length = push(message);
          if (message.type === 'import-chunk') {
            queueMicrotask(() => window.__send({ type: 'import-ack', commandId: message.commandId, viewer: message.viewer }));
          }
          return length;
        };
        const input = document.getElementById('viewerImportFile');
        const dt = new DataTransfer();
        const file = new File([${JSON.stringify(MINI_HAR)}, ' '.repeat(${size})], 'large.har');
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        return file.size;
      })()`);
      const sent = await waitForImportResult(viewer.cdp, `(() => {
        const messages = window.__sentToHost;
        const end = messages.find((m) => m.type === 'import-end');
        if (!end) return null;
        const begin = messages.find((m) => m.type === 'import-begin');
        const chunks = messages.filter((m) => m.type === 'import-chunk');
        const decodedBytes = chunks.reduce((sum, { data }) =>
          sum + data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0), 0);
        return {
          commandId: end.commandId,
          declared: begin.size,
          streamed: begin.stream,
          decodedBytes,
          bounded: chunks.every(({ data }) => data.length <= 512 * 1024),
          busy: document.getElementById('importBtn').disabled,
        };
      })()`);
      expect(sent).toMatchObject({ declared, streamed: true, decodedBytes: declared, bounded: true, busy: true });
      await evaluate(viewer.cdp, `window.__send({ type: 'command-result', commandId: ${sent.commandId}, ok: true }); true`);
      expect(await evaluate(viewer.cdp, "document.getElementById('importBtn').disabled")).toBe(false);
    } finally {
      await viewer.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'a surviving mirror tab is adopted at startup and never duplicated',
  async () => {
    const page = await launchPanelPage({ executable: browserExecutable, initScript: HOST_STUB });
    try {
      // The startup probe registered the port listener without any pop-out.
      expect(await evaluate(page.cdp, "typeof window.__hostPortListener === 'function'")).toBe(true);
      await evaluate(page.cdp, "window.__hostPortListener({ type: 'hello', protocolVersion: 2 }); true");
      await delay(200);
      expect(await evaluate(page.cdp, "document.getElementById('statusText').textContent")).toContain(
        'reattached and mirrors this DevTools session again',
      );
      const sync = await evaluate(page.cdp, "window.__fromHost.find((m) => m.type === 'sync') || null");
      expect(sync.control.devtoolsMinimized).toBeNull();

      await evaluate(page.cdp, "document.getElementById('popoutBtn').click(); true");
      await delay(150);
      expect(await evaluate(page.cdp, "document.getElementById('statusText').textContent")).toContain(
        'already mirroring this session',
      );
      expect(await evaluate(page.cdp, 'window.__openedUrls.length')).toBe(0);
      expect(await evaluate(page.cdp, 'window.__minimizeCalls')).toBe(0);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'the pop-out reports the minimize outcome either way and never re-sends on focus',
  async () => {
    const page = await launchPanelPage({ executable: browserExecutable, initScript: HOST_STUB });
    try {
      await evaluate(page.cdp, 'window.__minimizeAnswer = { minimized: false }; true');
      await evaluate(page.cdp, "document.getElementById('popoutBtn').click(); true");
      await delay(200);
      expect(await evaluate(page.cdp, "document.getElementById('statusText').textContent")).toContain(
        'DevTools stayed put — undock it into its own window',
      );
      // A second click focuses the existing tab without a second minimize.
      await evaluate(page.cdp, "document.getElementById('popoutBtn').click(); true");
      await delay(150);
      expect(await evaluate(page.cdp, 'window.__minimizeCalls')).toBe(1);
      expect(await evaluate(page.cdp, 'window.__openedUrls.length')).toBe(1);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'the domain summary panel aggregates, filters, and clears from the Columns menu',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable,
      query: '?view=window&src=7',
      initScript: VIEWER_STUB,
    });
    const domainWireRow = (id, url, status) => {
      const row = wireRow(id);
      row.request = Object.assign({}, row.request, { url });
      row.response = Object.assign({}, row.response, { status });
      return row;
    };
    try {
      await attachScriptedHostPort(page.cdp);
      await sendSnapshot(
        page.cdp,
        [
          domainWireRow(1, 'https://api.example.test/v1/a', 200),
          domainWireRow(2, 'https://api.example.test/v1/b', 500),
          domainWireRow(3, 'https://api.example.test/v1/c', 200),
          domainWireRow(4, 'https://cdn.example.test/asset.js', 200),
        ],
        syncControl(),
      );
      await delay(300);

      // Hidden by default; the toggle lives in the Columns menu because the
      // toolbar's button set is pinned by the responsive journeys.
      expect(await evaluate(page.cdp, "document.getElementById('domainSummary').hidden")).toBe(true);
      await evaluate(page.cdp, "document.getElementById('columnsBtn').click(); true");
      await delay(150);
      await evaluate(page.cdp, "document.getElementById('domainSummaryToggle').click(); true");
      await delay(150);
      expect(await evaluate(page.cdp, "document.getElementById('domainSummary').hidden")).toBe(false);
      expect(await evaluate(page.cdp, "localStorage.getItem('networkPlus.domainSummary.v1')")).toBe('1');
      const entries = await evaluate(
        page.cdp,
        `Array.from(document.querySelectorAll('#domainSummary .domain-summary-row')).map((el) => el.textContent)`,
      );
      expect(entries).toHaveLength(2);
      expect(entries[0]).toContain('api.example.test');
      expect(entries[0]).toContain('3 requests');
      expect(entries[0]).toContain('1 error');
      expect(entries[1]).toContain('cdn.example.test');
      expect(entries[1]).toContain('1 request');

      // A streamed live row for a new domain reaches the panel through the
      // same updateTableSummary hook the incremental fast path already calls.
      await evaluate(
        page.cdp,
        `window.__send({ type: 'row', row: ${JSON.stringify(
          domainWireRow(5, 'https://ws.example.test/live', 200),
        )} }); true`,
      );
      await delay(400);
      expect(
        await evaluate(page.cdp, "document.querySelectorAll('#domainSummary .domain-summary-row').length"),
      ).toBe(3);

      // Click-to-filter feeds the same multiText rules the Filters popup
      // edits; clicking the pressed entry clears it again.
      await evaluate(
        page.cdp,
        `document.querySelector('#domainSummary button[data-domain="api.example.test"]').click(); true`,
      );
      await delay(200);
      expect(await evaluate(page.cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length")).toBe(3);
      expect(await evaluate(page.cdp, "document.getElementById('filterBtn').textContent")).toContain(
        'Filters (1)',
      );
      expect(
        await evaluate(
          page.cdp,
          `document.querySelector('#domainSummary button[data-domain="api.example.test"]').getAttribute('aria-pressed')`,
        ),
      ).toBe('true');
      await evaluate(
        page.cdp,
        `document.querySelector('#domainSummary button[data-domain="api.example.test"]').click(); true`,
      );
      await delay(200);
      expect(await evaluate(page.cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length")).toBe(5);
      expect(await evaluate(page.cdp, "document.getElementById('filterBtn').textContent")).not.toContain('(');

      // Invariant guard: the panel never leaks non-data rows into the grid.
      expect(
        await evaluate(
          page.cdp,
          `Array.from(document.getElementById('tbody').children).every((tr) => tr.hasAttribute('data-row-id'))`,
        ),
      ).toBe(true);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);

browserTest(
  'the undock explainer sizes itself to its text instead of wrapping it',
  async () => {
    const page = await launchPanelPage({
      executable: browserExecutable,
      query: '?view=window&src=7',
      initScript: VIEWER_STUB,
      width: 1440,
      height: 900,
    });
    // Range.getClientRects() yields one rect per line box, so distinct rect
    // tops count the real rendered lines. Prose only: the dismiss label wraps
    // its checkbox into a second rect that is not a second line. The probe
    // reports what the content wants with no wrapping at all.
    const measureProse = `(() => {
      const dialog = document.getElementById('undockHintDialog');
      if (!dialog.open) dialog.showModal();
      const form = dialog.querySelector('.undock-hint-form');
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-99999px;top:0;width:max-content';
      probe.appendChild(form.cloneNode(true));
      document.body.appendChild(probe);
      const wanted = Math.round(probe.getBoundingClientRect().width);
      probe.remove();
      let multiLine = 0;
      let counted = 0;
      for (const el of form.querySelectorAll('p, li')) {
        if (!el.textContent.trim()) continue;
        counted += 1;
        const range = document.createRange();
        range.selectNodeContents(el);
        const tops = new Set();
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 || rect.height > 0) tops.add(Math.round(rect.top));
        }
        if (tops.size > 1) multiLine += 1;
      }
      return {
        width: Math.round(dialog.getBoundingClientRect().width),
        wanted,
        multiLine,
        counted,
        viewport: window.innerWidth,
      };
    })()`;
    // Absolute pixel thresholds are deliberately avoided: the text's intrinsic
    // width depends on the fonts the runner happens to have, and a CI image
    // without Japanese fonts measures the same sentences hundreds of pixels
    // narrower than a desktop with them. What must hold everywhere is that the
    // dialog is sized by its content (its own width plus the 1px borders)
    // rather than pinned to a fixed cap, and that no prose wraps.
    const expectContentSized = (measurement) => {
      expect(measurement.counted).toBeGreaterThanOrEqual(7);
      expect(measurement.multiLine).toBe(0);
      expect(measurement.wanted).toBeLessThanOrEqual(960);
      expect(measurement.width).toBeGreaterThanOrEqual(measurement.wanted);
      expect(measurement.width).toBeLessThanOrEqual(measurement.wanted + 4);
      expect(measurement.width).toBeLessThanOrEqual(measurement.viewport);
    };
    try {
      await attachScriptedHostPort(page.cdp);
      await evaluate(
        page.cdp,
        `window.__send({ type: 'sync', count: 0, maxId: 0, paused: false, control: ${JSON.stringify(
          syncControl({ devtoolsMinimized: false }),
        )} }); true`,
      );
      await delay(200);
      expect(await evaluate(page.cdp, "document.getElementById('undockHintDialog').open")).toBe(true);

      // English: the dialog grows past the old fixed cap so nothing wraps.
      const english = await evaluate(page.cdp, measureProse);
      expectContentSized(english);

      // Japanese explanations run to a different length; the dialog
      // re-measures itself rather than reflowing the text into wrapped lines.
      await evaluate(
        page.cdp,
        `(() => {
          const select = document.getElementById('langSelect');
          select.value = 'ja';
          select.dispatchEvent(new Event('change'));
          return true;
        })()`,
      );
      await delay(150);
      const japanese = await evaluate(page.cdp, measureProse);
      expectContentSized(japanese);

      // The old defect was a width that ignored the content entirely, so the
      // two languages rendered at the identical pinned width.
      expect(english.wanted).not.toBe(japanese.wanted);
    } finally {
      await page.close();
    }
  },
  TEST_TIMEOUT_MS,
);
