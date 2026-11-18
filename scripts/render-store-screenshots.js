#!/usr/bin/env node
/* global DataTransfer, document -- Browser callbacks are executed in the isolated panel. */
// Render the listing graphics and current workbench from local, synthetic data.
// Usage: CHROME_BIN=/path/to/chrome npm run store:screenshots

const fs = require('node:fs');
const path = require('node:path');
const { launchPanelPage, evaluate, delay } = require('../tests/helpers/browser-harness.js');

const ROOT = path.join(__dirname, '..');
const ASSET_DIR = path.join(ROOT, 'docs', 'store-assets');
const CANVAS = Object.freeze({ width: 1280, height: 800 });
const INNER = Object.freeze({ width: 1232, height: 664 });
const EPOCH = Date.UTC(2026, 0, 29, 9, 35, 12);
const HOST = 'https://api.network-plus.test';

const SCREENSHOTS = Object.freeze([
  {
    file: 'screenshot-1-request-detail-1280x800.png',
    title: 'Inspect every request',
    subtitle: 'Find the failing request and inspect its headers, body, and timing.',
    scene: 'inspector',
  },
  {
    file: 'screenshot-2-timeline-1280x800.png',
    title: 'Zoom in on slow traffic',
    subtitle: 'Select a time range to narrow the request list and latency distribution.',
    scene: 'timeline',
  },
  {
    file: 'screenshot-3-websocket-1280x800.png',
    title: 'Follow the WebSocket conversation',
    subtitle: 'Search sent and received messages, then expand the JSON you need.',
    scene: 'websocket',
  },
  {
    file: 'screenshot-4-sanitized-export-1280x800.png',
    title: 'Share a sanitized HAR',
    subtitle: 'Redact sensitive fields before sharing captured traffic.',
    scene: 'export',
  },
]);

const bytes = (file) => fs.readFileSync(path.join(ROOT, file));
const dataUrl = (buffer) => 'data:image/png;base64,' + buffer.toString('base64');
const panelExpression = (callback, value) => '(' + callback.toString() + ')(' + JSON.stringify(value) + ')';

function createStoreCapture() {
  const names = ['catalog', 'pricing', 'cart', 'inventory', 'checkout', 'receipt', 'shipping', 'rates'];
  const entries = Array.from({ length: 16 }, (_, index) => {
    const status = index === 6 ? 503 : index === 10 ? 504 : index === 13 ? 304 : 200;
    const duration = index === 6 ? 2260 : index === 10 ? 1400 : 64 + ((index * 77) % 410);
    const route = names[index % names.length];
    const content = { status, service: route, trace: 'synthetic-' + (index + 1) };
    const text = JSON.stringify(content);
    return {
      startedDateTime: new Date(EPOCH + index * 460).toISOString(),
      time: duration,
      request: {
        method: index === 6 ? 'POST' : 'GET',
        url: HOST + '/v1/' + (index === 6 ? 'checkout' : route),
        headers: [{ name: 'Accept', value: 'application/json' }],
      },
      response: {
        status,
        statusText: status === 503 ? 'Service Unavailable' : status === 504 ? 'Gateway Timeout' : '',
        headers: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'X-Request-Id', value: content.trace },
          ...(status === 503 ? [{ name: 'Retry-After', value: '5' }] : []),
        ],
        content: { mimeType: 'application/json', size: Buffer.byteLength(text), text },
      },
      timings: { send: 1, wait: duration - 10, receive: 9 },
    };
  });
  const frames = [
    ['send', { type: 'subscribe', channel: 'orders', requestId: 'demo-01' }],
    ['receive', { type: 'ready', channel: 'orders', sequence: 1 }],
    ['send', { type: 'track', orderId: 'order-204', region: 'west' }],
    ['receive', { type: 'order.updated', order: { id: 'order-204', status: 'packed', items: 3 }, sequence: 2 }],
    ['receive', { type: 'order.updated', order: { id: 'order-204', status: 'shipped' }, sequence: 3 }],
  ];
  entries.push({
    startedDateTime: new Date(EPOCH + 1300).toISOString(),
    time: 1250,
    request: { method: 'GET', url: 'wss://api.network-plus.test/v1/orders/stream', headers: [] },
    response: {
      status: 101,
      statusText: 'Switching Protocols',
      headers: [{ name: 'Upgrade', value: 'websocket' }],
      content: { size: 0 },
    },
    timings: { send: 0, wait: 100, receive: 0 },
    _webSocketMessages: frames.map(([type, value], index) => ({
      type,
      opcode: 1,
      time: (EPOCH + 1430 + index * 204) / 1000,
      data: JSON.stringify(value),
    })),
  });
  return JSON.stringify({ log: { version: '1.2', entries } });
}

async function waitFor(cdp, expression, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await delay(75);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function click(cdp, selector) {
  const clicked = await evaluate(
    cdp,
    panelExpression((target) => {
      const element = document.querySelector(target);
      if (!element || element.disabled || !element.getClientRects().length) return false;
      element.click();
      return true;
    }, selector),
  );
  if (!clicked) throw new Error('Could not activate ' + selector);
}

async function paint(cdp) {
  await evaluate(cdp, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
}

async function captureScene(screenshot) {
  const page = await launchPanelPage({
    executable: process.env.CHROME_BIN,
    query: '?view=offline',
    ...INNER,
    initScript:
      "localStorage.setItem('networkPlus.theme','dark');localStorage.setItem('networkPlus.lang','en');" +
      "document.addEventListener('DOMContentLoaded', () => {" +
      " const style = document.createElement('style');" +
      " style.textContent = '*,*::before,*::after{transition:none !important}';" +
      ' document.head.appendChild(style); });',
  });
  const { cdp } = page;
  try {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate(
      cdp,
      panelExpression((trace) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([trace], 'synthetic-network-plus.har', { type: 'application/json' }));
        const input = document.getElementById('importFile');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, createStoreCapture()),
    );
    await waitFor(cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length === 17", 'the synthetic HAR');

    if (screenshot.scene === 'timeline') {
      await click(cdp, '#overviewToggleBtn');
      await waitFor(cdp, "document.querySelectorAll('#overviewTimeline button').length >= 6", 'timeline bins');
      await click(cdp, '#overviewTimeline button:nth-child(5)');
      await waitFor(cdp, "!document.querySelector('#overviewRangeControls').hidden", 'the selected time range');
      await click(cdp, '#overviewZoomTime');
      await waitFor(
        cdp,
        "document.querySelector('#overviewZoomTime').getAttribute('aria-pressed') === 'true'",
        'the zoomed time range',
      );
      await click(cdp, '#request-row-7');
    } else if (screenshot.scene === 'websocket') {
      await click(cdp, '#webSocketOnlyBtn');
      await waitFor(cdp, "document.querySelectorAll('#tbody tr[data-row-id]').length === 1", 'the WebSocket filter');
      await click(cdp, '#tbody tr[data-row-id]');
      await click(cdp, '#ws-message-search-toggle');
      await evaluate(
        cdp,
        panelExpression((query) => {
          const input = document.getElementById('ws-message-query');
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, 'order-204'),
      );
      await waitFor(
        cdp,
        "document.querySelector('#ws-message-results').textContent.includes('3')",
        'message search hits',
      );
      await click(cdp, '#ws-message-next');
      await click(cdp, '#ws-message-next');
      await waitFor(
        cdp,
        "[...document.querySelectorAll('.ws-message-payload')].some(payload => payload.textContent.includes('packed'))",
        'expanded JSON',
      );
      await evaluate(
        cdp,
        "document.querySelectorAll('.ws-message[data-direction=send] details[open]').forEach(message => { message.open = false; });" +
          "document.getElementById('ws-timeline-scroll').scrollTop = 0; true",
      );
    } else {
      await click(cdp, '#request-row-7');
      await waitFor(
        cdp,
        "document.querySelector('#detailsSummary').textContent.includes('503')",
        'the failing response',
      );
      if (screenshot.scene === 'export') {
        await click(cdp, '#exportHarBtn');
        await waitFor(cdp, '[...document.querySelectorAll("dialog")].some(dialog => dialog.open)', 'the export dialog');
      }
    }
    await paint(cdp);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  } finally {
    await page.close();
  }
}

const BRAND_CSS =
  '*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}' +
  '[data-store-artwork]{width:100%;height:100%}' +
  'body{color:#fcf7ed;font-family:system-ui,-apple-system,sans-serif}' +
  '.brand{width:100%;height:100%;position:relative;overflow:hidden;background:' +
  'radial-gradient(ellipse at 76% 42%,#54402d 0,transparent 58%),linear-gradient(125deg,#171514,#27211b 83%)}' +
  '.lines{position:absolute;inset:0;opacity:.37;background:repeating-linear-gradient(0deg,transparent 0 35px,#d8aa7c33 35px 36px)}' +
  '.mark,.mascot{position:absolute;object-fit:contain}.mark{filter:drop-shadow(0 14px 28px #110d0a95)}' +
  '.small .mark{width:150px;left:193px;top:56px}.small .mascot{width:119px;left:84px;bottom:40px}' +
  '.wide .mark{width:216px;right:120px;top:149px}.wide .mascot{width:186px;right:282px;bottom:94px}' +
  '.copy{position:absolute;left:88px;top:166px}.copy h1{font-size:104px;line-height:1;margin:0;letter-spacing:-.045em}' +
  '.copy p{font-size:37px;font-weight:550;color:#f1c69d;margin:27px 0 0}' +
  '.shot{height:100%;padding:18px 24px 24px;background:linear-gradient(155deg,#30271e,#141311 46%)}' +
  '.shot header{height:94px;display:flex;align-items:flex-start;gap:18px}' +
  '.shot header img{width:61px;height:61px;margin-top:2px}.shot h1{font-size:36px;line-height:1.1;margin:0;font-weight:760;letter-spacing:-.025em}' +
  '.shot p{font-size:17px;color:#e0c4a7;margin:7px 0 0}.panel{width:1232px;height:664px;display:block;border-radius:10px;outline:1px solid #97704d}';

async function renderGraphic(cdp, width, height, markup, transparent = false) {
  const html =
    '<!doctype html><meta charset="utf-8"><style>' +
    BRAND_CSS +
    '</style>' +
    '<div data-store-artwork>' +
    markup +
    '</div>';
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: transparent ? 0 : 1 },
  });
  await cdp.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
  await waitFor(
    cdp,
    "document.readyState === 'complete' && !!document.querySelector('[data-store-artwork]') && [...document.images].every(image => image.complete && image.naturalWidth > 0)",
    'graphic assets',
  );
  await paint(cdp);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const png = Buffer.from(data, 'base64');
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height)
    throw new Error('Unexpected artwork dimensions');
  return png;
}

async function main() {
  if (!process.env.CHROME_BIN) throw new Error('Set CHROME_BIN to render the store artwork.');
  const captures = new Map();
  for (const screenshot of SCREENSHOTS) captures.set(screenshot.file, await captureScene(screenshot));
  const page = await launchPanelPage({ executable: process.env.CHROME_BIN, width: 400, height: 300 });
  const output = new Map();
  try {
    const vector = bytes('icons/network-plus.svg').toString('utf8');
    const logo = await renderGraphic(
      page.cdp,
      300,
      300,
      '<style>svg{width:300px;height:300px;display:block}</style>' + vector,
      true,
    );
    output.set('logo-300.png', logo);
    const mark = '<img alt="" class="mark" src="' + dataUrl(logo) + '">';
    const mascot = '<img alt="" class="mascot" src="' + dataUrl(bytes('assets/support-otter.png')) + '">';
    output.set(
      'chrome-small-promo-440x280.png',
      await renderGraphic(
        page.cdp,
        440,
        280,
        '<div class="brand small"><div class="lines"></div>' + mark + mascot + '</div>',
      ),
    );
    output.set(
      'chrome-marquee-1400x560.png',
      await renderGraphic(
        page.cdp,
        1400,
        560,
        '<div class="brand wide"><div class="lines"></div>' +
          '<div class="copy"><h1>Network+</h1><p>Inspect HTTP and WebSocket traffic</p></div>' +
          mark +
          mascot +
          '</div>',
      ),
    );
    for (const screenshot of SCREENSHOTS) {
      const panel = '<img class="panel" alt="" src="' + dataUrl(captures.get(screenshot.file)) + '">';
      const heading =
        '<header><img alt="" src="' +
        dataUrl(logo) +
        '"><div><h1>' +
        screenshot.title +
        '</h1><p>' +
        screenshot.subtitle +
        '</p></div></header>';
      output.set(
        screenshot.file,
        await renderGraphic(page.cdp, CANVAS.width, CANVAS.height, '<div class="shot">' + heading + panel + '</div>'),
      );
    }
  } finally {
    await page.close();
  }
  for (const [file, png] of output) {
    const target = path.join(ASSET_DIR, file);
    fs.writeFileSync(target, png);
    console.log('rendered ' + path.relative(ROOT, target));
  }
}

module.exports = { CANVAS, INNER, SCREENSHOTS };

if (require.main === module) {
  main().catch((error) => {
    console.error('ERROR: ' + error.message);
    process.exitCode = 1;
  });
}
