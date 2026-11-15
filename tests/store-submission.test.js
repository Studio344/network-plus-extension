'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertArchiveMatchesReviewedDigest,
  describeArchive,
  extractOperationId,
  interpretChromePublish,
  interpretChromeUpload,
  interpretEdgeOperation,
  parseArguments,
  planStoreSubmissions,
  pollUntilTerminal,
  redact,
  submitToChrome,
  submitToEdge,
  CHROME_ITEM_ROOT,
  CHROME_TOKEN_URL,
  CHROME_UPLOAD_ROOT,
  EDGE_API_ROOT,
} = require('../scripts/submit-to-stores');

const ROOT = path.join(__dirname, '..');
const SUBMIT_WORKFLOW = path.join('.github', 'workflows', 'store-submit.yml');
const readRepoFile = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const headers = (entries) => ({ get: (name) => entries[name.toLowerCase()] ?? null });
const response = (status, body, headerEntries = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: headers(headerEntries),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// Every submission ends in a poll, so tests drive one with an injected clock
// instead of waiting on a real one.
const instantPoll = (describe, readStatus) =>
  pollUntilTerminal(describe, readStatus, {
    intervalMs: 0,
    timeoutMs: 1000,
    now: (() => {
      let clock = 0;
      return () => (clock += 100);
    })(),
    wait: async () => {},
  });

const baseContext = (fetchImpl, overrides = {}) => ({
  version: '9.9.9',
  archive: { name: 'network-plus-extension-9.9.9.zip', size: 4, sha256: 'a'.repeat(64), bytes: Buffer.from('zip!') },
  notes: 'release notes',
  fetchImpl,
  log: () => {},
  secrets: [],
  uploadOnly: false,
  poll: instantPoll,
  publishTarget: 'default',
  ...overrides,
});

describe('archive gate', () => {
  test('describes an archive by name, byte length, and digest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-plus-submit-'));
    const archivePath = path.join(directory, 'network-plus-extension-9.9.9.zip');
    fs.writeFileSync(archivePath, Buffer.from('network-plus', 'utf8'));
    try {
      const archive = describeArchive(archivePath);
      expect(archive.name).toBe('network-plus-extension-9.9.9.zip');
      expect(archive.size).toBe(12);
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // The whole point of the gate: an archive nobody reviewed never reaches a store.
  test('refuses an archive whose digest is not the reviewed one', () => {
    const archive = { name: 'tampered.zip', sha256: 'b'.repeat(64) };
    expect(() => assertArchiveMatchesReviewedDigest(archive, 'a'.repeat(64))).toThrow(
      /does not match the digest recorded in the submission dossiers/,
    );
  });

  test('accepts the archive that matches the reviewed digest', () => {
    expect(() => assertArchiveMatchesReviewedDigest({ sha256: 'a'.repeat(64) }, 'a'.repeat(64))).not.toThrow();
  });
});

describe('credential planning', () => {
  const full = {
    EDGE_PRODUCT_ID: 'p',
    EDGE_CLIENT_ID: 'c',
    EDGE_API_KEY: 'k',
    CHROME_PUBLISHER_ID: 'p',
    CHROME_ITEM_ID: 'i',
    CHROME_CLIENT_ID: 'ci',
    CHROME_CLIENT_SECRET: 'cs',
    CHROME_REFRESH_TOKEN: 'rt',
  };

  test('plans both stores when both are configured', () => {
    expect(planStoreSubmissions(full, 'both')).toEqual([
      { store: 'edge', ready: true, missing: [], required: true },
      { store: 'chrome', ready: true, missing: [], required: true },
    ]);
  });

  // A missing second store must fail preflight, before the first store uploads.
  test('requires both stores when both were requested', () => {
    const plans = planStoreSubmissions({ ...full, CHROME_REFRESH_TOKEN: '' }, 'both');
    expect(plans[0]).toMatchObject({ store: 'edge', ready: true });
    expect(plans[1]).toMatchObject({ store: 'chrome', ready: false, missing: ['CHROME_REFRESH_TOKEN'], required: true });
  });

  // Asking for one store by name is a claim that it is configured.
  test('marks an explicitly requested store as required', () => {
    expect(planStoreSubmissions({}, 'edge')).toEqual([
      { store: 'edge', ready: false, missing: ['EDGE_PRODUCT_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY'], required: true },
    ]);
  });
});

describe('secret redaction', () => {
  test('masks every configured secret in text that gets logged', () => {
    const text = 'failed for key sk-abcdefgh1234 with token rt-zyxwvutsrq';
    expect(redact(text, ['sk-abcdefgh1234', 'rt-zyxwvutsrq'])).toBe('failed for key *** with token ***');
  });

  // A short value is more likely to be a common substring than a credential;
  // masking it would corrupt messages without protecting anything.
  test('leaves values too short to be a credential alone', () => {
    expect(redact('status 404 for item ab', ['ab'])).toBe('status 404 for item ab');
  });
});

describe('operation tracking', () => {
  test('reads the operation id from a bare Location header', () => {
    expect(extractOperationId(response(202, '', { location: 'abc-123' }))).toBe('abc-123');
  });

  test('reads the operation id from a Location header carrying a full URL', () => {
    expect(extractOperationId(response(202, '', { location: 'https://example.test/v1/operations/abc-123' }))).toBe(
      'abc-123',
    );
  });

  // Without an id there is nothing to poll, so an untrackable submission must
  // fail loudly instead of being reported as accepted.
  test('rejects an accepted response that carries no Location header', () => {
    expect(() => extractOperationId(response(202, ''))).toThrow(/returned no Location header/);
  });
});

describe('status interpretation', () => {
  test('maps the documented Edge operation states', () => {
    expect(interpretEdgeOperation({ status: 'Succeeded' }).state).toBe('succeeded');
    expect(interpretEdgeOperation({ status: 'InProgress' }).state).toBe('pending');
    expect(interpretEdgeOperation({ status: 'Failed', message: 'bad manifest' })).toEqual({
      state: 'failed',
      detail: 'Failed - bad manifest',
    });
  });

  // An unrecognized status is not success. Treating it as pending lets the poll
  // time out and report, rather than declaring a submission that never happened.
  test('treats an unknown Edge status as still pending', () => {
    expect(interpretEdgeOperation({ status: 'Whatever' }).state).toBe('pending');
    expect(interpretEdgeOperation(null).state).toBe('pending');
  });

  test('uses V2 upload enums and rejects unknown or legacy states', () => {
    expect(interpretChromeUpload({ uploadState: 'SUCCEEDED' }).state).toBe('succeeded');
    expect(interpretChromeUpload({ uploadState: 'IN_PROGRESS' }).state).toBe('pending');
    for (const uploadState of ['FAILED', 'NOT_FOUND', 'SUCCESS', 'FAILURE', 'UNRECOGNIZED', undefined]) {
      expect(interpretChromeUpload({ uploadState }).state).toBe('failed');
    }
  });

  test('distinguishes V2 submission acknowledgement from rejected, staged or unknown states', () => {
    for (const state of ['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']) {
      expect(interpretChromePublish({ state }).state).toBe('succeeded');
    }
    for (const state of ['REJECTED', 'CANCELLED', 'STAGED', undefined]) {
      expect(interpretChromePublish({ state }).state).toBe('failed');
    }
  });
});

describe('polling', () => {
  test('returns as soon as the operation succeeds', async () => {
    const states = ['pending', 'pending', 'succeeded'];
    let calls = 0;
    const result = await instantPoll('test op', async () => ({ state: states[calls++], detail: '' }));
    expect(result.state).toBe('succeeded');
    expect(calls).toBe(3);
  });

  test('throws with the store detail when the operation fails', async () => {
    await expect(instantPoll('test op', async () => ({ state: 'failed', detail: 'rejected' }))).rejects.toThrow(
      'test op failed: rejected',
    );
  });

  // A run that never terminates is worse than one that reports a timeout.
  test('gives up with a retryable message instead of hanging', async () => {
    await expect(instantPoll('test op', async () => ({ state: 'pending', detail: 'InProgress' }))).rejects.toThrow(
      /still InProgress after 1s; check the portal before retrying/,
    );
  });
});

describe('Edge submission', () => {
  const credentials = { productId: 'PRODUCT', clientId: 'CLIENT', apiKey: 'KEY-12345678' };

  test('uploads, waits for the package, then publishes with JSON notes', async () => {
    const calls = [];
    const log = jest.fn();
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body });
      if (url.endsWith('/submissions/draft/package')) return response(202, '', { location: 'op-upload' });
      if (url.includes('/draft/package/operations/')) return response(200, { status: 'Succeeded' });
      if (url.endsWith('/submissions')) return response(202, '', { location: 'op-publish' });
      return response(200, { status: 'Succeeded' });
    };

    const result = await submitToEdge(baseContext(fetchImpl, { credentials, log }));

    expect(result).toEqual({ store: 'edge', outcome: 'submitted', submitted: true, operationId: 'op-publish', operationState: 'Succeeded' });
    expect(calls[0].url).toBe(`${EDGE_API_ROOT}/v1/products/PRODUCT/submissions/draft/package`);
    expect(calls[0].headers).toMatchObject({
      Authorization: 'ApiKey KEY-12345678',
      'X-ClientID': 'CLIENT',
      'Content-Type': 'application/zip',
    });
    const publishCall = calls.find((call) => call.method === 'POST' && call.url.endsWith('/submissions'));
    // The published sample body is not valid JSON; this must send real JSON.
    expect(JSON.parse(publishCall.body)).toEqual({ notes: 'release notes' });
    expect(log.mock.calls.flat().join('\n')).toContain('upload acknowledged, operationId=op-upload');
    expect(log.mock.calls.flat().join('\n')).toContain('submission acknowledged, operationId=op-publish');
    expect(log.mock.calls.flat().join('\n')).toContain('"operationId":"op-publish","state":"Succeeded"');
    expect(log.mock.calls.flat().join('\n')).not.toContain(credentials.apiKey);
  });

  test('stops after the upload when only an upload was asked for', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/submissions/draft/package')) return response(202, '', { location: 'op-upload' });
      if (url.includes('/operations/')) return response(200, { status: 'Succeeded' });
      throw new Error(`unexpected call to ${url}`);
    };
    await expect(submitToEdge(baseContext(fetchImpl, { credentials, uploadOnly: true }))).resolves.toEqual({
      store: 'edge',
      outcome: 'uploaded',
      submitted: false,
      operationId: 'op-upload',
      operationState: 'Succeeded',
    });
  });

  test('reports a rejected upload with the store response', async () => {
    const fetchImpl = async () => response(400, 'manifest version must increase');
    await expect(submitToEdge(baseContext(fetchImpl, { credentials }))).rejects.toThrow(
      /edge package upload returned 400: manifest version must increase/,
    );
  });

  // A failure message travels to CI logs, so it must not carry the API key.
  test('keeps the API key out of failure messages', async () => {
    const fetchImpl = async () => response(401, 'rejected ApiKey KEY-12345678');
    await expect(
      submitToEdge(baseContext(fetchImpl, { credentials, secrets: ['KEY-12345678'] })),
    ).rejects.toThrow(/rejected ApiKey \*\*\*/);
  });

  test.each(['upload', 'publish'])('redacts provider error details during %s polling', async (stage) => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/submissions/draft/package')) return response(202, '', { location: 'op-upload' });
      if (url.endsWith('/submissions')) return response(202, '', { location: 'op-publish' });
      if (stage === 'publish' && url.includes('/draft/package/operations/')) return response(200, { status: 'Succeeded' });
      return response(200, { status: 'Failed', message: 'provider echoed KEY-12345678', errors: ['KEY-12345678'] });
    };
    await expect(submitToEdge(baseContext(fetchImpl, { credentials, secrets: [credentials.apiKey] }))).rejects.toThrow(/provider echoed \*\*\*/);
    try {
      await submitToEdge(baseContext(fetchImpl, { credentials, secrets: [credentials.apiKey] }));
    } catch (error) {
      expect(error.message).not.toContain(credentials.apiKey);
    }
  });
});

describe('Chrome V2 submission', () => {
  const credentials = {
    publisherId: 'PUBLISHER', itemId: 'ITEM', clientId: 'client',
    clientSecret: 'secret-12345678', refreshToken: 'refresh-12345678',
  };
  const identity = { name: 'publishers/PUBLISHER/items/ITEM', itemId: 'ITEM' };
  const revision = (version = '9.9.9', state = 'PENDING_REVIEW') => ({ state, distributionChannels: [{ crxVersion: version }] });
  const status = (overrides = {}) => ({ ...identity, ...overrides });
  const accepted = () => status({ submittedItemRevisionStatus: revision() });
  const upload = () => ({ ...identity, uploadState: 'SUCCEEDED', crxVersion: '9.9.9' });
  const setup = ({ before = status(), afterUpload = status(), final = accepted(), uploadBody = upload(), publishBody = { ...identity, state: 'PENDING_REVIEW' }, uploadStatus = 200, publishStatus = 200 } = {}) => {
    const calls = [];
    let reads = 0;
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', ...init });
      if (url === CHROME_TOKEN_URL) return response(200, { access_token: 'token-abcdefgh' });
      if (url.endsWith(':fetchStatus')) return response(200, [before, afterUpload, final][Math.min(reads++, 2)]);
      if (url.endsWith(':upload')) return response(uploadStatus, uploadBody);
      if (url.endsWith(':publish')) return response(publishStatus, publishBody);
      throw new Error(`unexpected call ${url}`);
    };
    return { calls, fetchImpl };
  };
  const mutations = (calls) => calls.filter((call) => call.url !== CHROME_TOKEN_URL && call.method === 'POST');

  test('reads before upload and after publish, binds version, and preserves OAuth and visibility', async () => {
    const { calls, fetchImpl } = setup();
    const result = await submitToChrome(baseContext(fetchImpl, { credentials }));
    expect(result).toMatchObject({ store: 'chrome', outcome: 'submitted', submitted: true, expectedVersion: '9.9.9', localArchiveSha256: 'a'.repeat(64), submittedRevision: { state: 'PENDING_REVIEW', versions: ['9.9.9'] } });
    expect(new URLSearchParams(calls[0].body).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(calls[0].body).has('scope')).toBe(false);
    expect(calls.map((call) => call.url)).toEqual([
      CHROME_TOKEN_URL, `${CHROME_ITEM_ROOT}/${identity.name}:fetchStatus`,
      `${CHROME_UPLOAD_ROOT}/${identity.name}:upload`, `${CHROME_ITEM_ROOT}/${identity.name}:fetchStatus`,
      `${CHROME_ITEM_ROOT}/${identity.name}:publish`, `${CHROME_ITEM_ROOT}/${identity.name}:fetchStatus`,
    ]);
    expect(mutations(calls)[0]).toMatchObject({ method: 'POST', body: Buffer.from('zip!'), headers: { 'Content-Type': 'application/zip', Authorization: 'Bearer token-abcdefgh' } });
    expect(mutations(calls)[1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(calls.some((call) => call.url.includes('v1.1') || call.url.includes('publishTarget'))).toBe(false);
  });

  test('polls lastAsyncUploadState after an asynchronous upload, then verifies the submitted version', async () => {
    const { calls, fetchImpl: inner } = setup();
    let reads = 0;
    let published = false;
    const fetchImpl = async (url, init) => {
      if (url.endsWith(':upload')) {
        calls.push({ url, ...init });
        return response(200, { ...identity, uploadState: 'IN_PROGRESS' });
      }
      if (url.endsWith(':publish')) published = true;
      if (url.endsWith(':fetchStatus')) {
        calls.push({ url, ...init });
        reads += 1;
        return response(200, published ? accepted() : status({ lastAsyncUploadState: reads === 2 ? 'IN_PROGRESS' : 'SUCCEEDED' }));
      }
      return inner(url, init);
    };
    expect(await submitToChrome(baseContext(fetchImpl, { credentials }))).toMatchObject({ outcome: 'submitted' });
    expect(reads).toBe(5);
    expect(mutations(calls)).toHaveLength(2);
  });

  test.each(['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'])('does not upload an already observed target version (%s)', async (state) => {
    const before = state === 'PENDING_REVIEW' ? status({ submittedItemRevisionStatus: revision('9.9.9', state) }) : status({ publishedItemRevisionStatus: revision('9.9.9', state) });
    const { calls, fetchImpl } = setup({ before });
    expect(await submitToChrome(baseContext(fetchImpl, { credentials }))).toMatchObject({ outcome: 'already-submitted-or-published', submitted: false });
    expect(mutations(calls)).toHaveLength(0);
  });

  test.each(['FAILED', 'NOT_FOUND', 'IN_PROGRESS', undefined])('does not publish after failed or unfinished async upload (%s)', async (lastAsyncUploadState) => {
    const current = status({ ...(lastAsyncUploadState ? { lastAsyncUploadState } : {}) });
    const { calls, fetchImpl } = setup({ uploadBody: { ...identity, uploadState: 'IN_PROGRESS' }, afterUpload: current, final: current });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/upload was not confirmed/);
    expect(mutations(calls)).toHaveLength(1);
  });

  test.each(['PENDING_REVIEW', 'STAGED'])('blocks an occupied review queue (%s) before uploading', async (state) => {
    const { calls, fetchImpl } = setup({ before: status({ submittedItemRevisionStatus: revision('8.8.8', state) }) });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/existing/);
    expect(mutations(calls)).toHaveLength(0);
  });

  test('keeps upload-only distinct from a verified submission', async () => {
    const { calls, fetchImpl } = setup();
    expect(await submitToChrome(baseContext(fetchImpl, { credentials, uploadOnly: true }))).toMatchObject({ outcome: 'uploaded', submitted: false, uploadVersionVerified: true });
    expect(mutations(calls)).toHaveLength(1);
  });

  test('does not replace an upload already in progress', async () => {
    const { calls, fetchImpl } = setup({ before: status({ lastAsyncUploadState: 'IN_PROGRESS' }) });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/upload in progress/);
    expect(mutations(calls)).toHaveLength(0);
  });

  test.each(['10.0.0', '9.10.0', '9.9.9.1'])('refuses an older release when published version is %s', async (version) => {
    const { calls, fetchImpl } = setup({ before: status({ publishedItemRevisionStatus: revision(version, 'PUBLISHED') }) });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/newer published version/);
    expect(mutations(calls)).toHaveLength(0);
  });

  test('compares version components numerically rather than lexically', async () => {
    const { fetchImpl } = setup({ before: status({ publishedItemRevisionStatus: revision('9.9.8.100', 'PUBLISHED') }) });
    expect(await submitToChrome(baseContext(fetchImpl, { credentials }))).toMatchObject({ outcome: 'submitted' });
  });

  test('status-only requires no archive and makes only token exchange and status GET', async () => {
    const { calls, fetchImpl } = setup({ before: accepted() });
    const result = await submitToChrome(baseContext(fetchImpl, { credentials, statusOnly: true, archive: undefined }));
    expect(result).toMatchObject({ outcome: 'status-only', submitted: false });
    expect(result).not.toHaveProperty('localArchiveSha256');
    expect(calls).toHaveLength(2);
    expect(mutations(calls)).toHaveLength(0);
  });

  test.each([
    { ...identity, name: 'publishers/OTHER/items/ITEM' },
    { ...identity, itemId: 'OTHER' },
  ])('refuses mismatched preflight identity', async (before) => {
    const { calls, fetchImpl } = setup({ before });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/requested publisher and item/);
    expect(mutations(calls)).toHaveLength(0);
  });

  test.each([
    { ...identity, uploadState: 'SUCCEEDED', crxVersion: '8.8.8' },
    { ...identity, uploadState: 'SUCCEEDED' },
    { ...identity, name: 'publishers/OTHER/items/ITEM', uploadState: 'SUCCEEDED', crxVersion: '9.9.9' },
    { ...identity, uploadState: 'FAILED' },
    { ...identity, uploadState: 'SUCCESS', crxVersion: '9.9.9' },
  ])('never publishes a wrong, missing or failed upload version/state', async (uploadBody) => {
    const { calls, fetchImpl } = setup({ uploadBody });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/upload was not confirmed/);
    expect(mutations(calls)).toHaveLength(1);
  });

  test('HTTP publish success cannot substitute for version-matching readback', async () => {
    const { calls, fetchImpl } = setup({ final: status({ submittedItemRevisionStatus: revision('8.8.8') }) });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/publish was not confirmed/);
    expect(mutations(calls)).toHaveLength(2);
  });

  test.each(['REJECTED', 'CANCELLED', 'STAGED'])('does not report final %s as a successful submission', async (state) => {
    const { fetchImpl } = setup({ final: status({ submittedItemRevisionStatus: revision('9.9.9', state) }) });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/publish was not confirmed/);
  });

  test('recovers a duplicate/error acknowledgement by readback without retrying the POST', async () => {
    const { calls, fetchImpl } = setup({ publishStatus: 409, publishBody: { error: { message: 'already submitted' } } });
    expect(await submitToChrome(baseContext(fetchImpl, { credentials }))).toMatchObject({ outcome: 'observed-after-error', submitted: false, submittedRevision: { versions: ['9.9.9'] } });
    expect(mutations(calls)).toHaveLength(2);
  });

  test('reads status after an uncertain upload and never retries or publishes an unverified draft', async () => {
    const { calls, fetchImpl: inner } = setup();
    const fetchImpl = async (url, init) => {
      if (url.endsWith(':upload')) {
        calls.push({ url, ...init });
        throw new Error('connection lost after request');
      }
      return inner(url, init);
    };
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/--status-only before retrying/);
    expect(mutations(calls)).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith(':fetchStatus'))).toHaveLength(2);
  });

  test('keeps minted access tokens out of failure messages', async () => {
    const { fetchImpl } = setup({ uploadStatus: 500, uploadBody: 'upstream rejected Bearer token-abcdefgh' });
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/Bearer \*\*\*/);
  });

  test('fails token exchange without contacting item endpoints', async () => {
    const fetchImpl = jest.fn(async () => response(400, { error: 'invalid_grant' }));
    await expect(submitToChrome(baseContext(fetchImpl, { credentials }))).rejects.toThrow(/chrome token exchange returned 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('requires a valid publisher ID before any network request', async () => {
    const fetchImpl = jest.fn();
    await expect(submitToChrome(baseContext(fetchImpl, { credentials: { ...credentials, publisherId: '' } }))).rejects.toThrow(/publisherId/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('command line', () => {
  test('status-only requires explicit Chrome and excludes mutation/diagnosis combinations', () => {
    expect(parseArguments(['--store', 'chrome', '--status-only'])).toMatchObject({ store: 'chrome', statusOnly: true });
    for (const flags of [[], ['--store', 'edge'], ['--store', 'chrome', '--upload-only'], ['--store', 'chrome', '--diagnose']]) {
      expect(() => parseArguments([...flags, '--status-only'])).toThrow(/--status-only requires/);
    }
  });

  test('the status-only CLI succeeds without an archive and cannot perform store mutations', () => {
    const { execFileSync } = require('child_process');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-plus-status-'));
    const preload = path.join(directory, 'mock-fetch.cjs');
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    fs.writeFileSync(preload, `global.fetch = async (url, init) => {
      if (url === '${CHROME_TOKEN_URL}') return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'synthetic-access-token' }) };
      if (url === '${CHROME_ITEM_ROOT}/publishers/PUBLISHER/items/ITEM:fetchStatus' && !init.method) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'publishers/PUBLISHER/items/ITEM', itemId: 'ITEM' }) };
      }
      throw new Error('unexpected mutation or URL');
    };`);
    try {
      const output = execFileSync(process.execPath, ['--require', preload, path.join(ROOT, 'scripts/submit-to-stores.js'), '--store', 'chrome', '--status-only'], {
        cwd: directory, encoding: 'utf8', env: {
          CHROME_PUBLISHER_ID: 'PUBLISHER', CHROME_ITEM_ID: 'ITEM', CHROME_CLIENT_ID: 'synthetic-client',
          CHROME_CLIENT_SECRET: 'synthetic-secret', CHROME_REFRESH_TOKEN: 'synthetic-refresh',
        },
      });
      expect(output).toContain('"outcome":"status-only"');
      expect(output).not.toContain('synthetic-access-token');
      expect(output).not.toContain('localArchiveSha256');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('defaults to submitting the packaged release to both stores', () => {
    expect(parseArguments([])).toEqual({
      store: 'both',
      archive: '',
      notesFile: '',
      uploadOnly: false,
      statusOnly: false,
      publishTarget: 'default',
      diagnose: false,
    });
  });

  test('accepts the documented flags', () => {
    expect(parseArguments(['--store', 'chrome', '--archive', 'a.zip', '--notes-file', 'n.md', '--upload-only'])).toEqual(
      { store: 'chrome', archive: 'a.zip', notesFile: 'n.md', uploadOnly: true, statusOnly: false, publishTarget: 'default', diagnose: false },
    );
  });

  test('rejects an unknown store or publish target rather than guessing', () => {
    expect(() => parseArguments(['--store', 'firefox'])).toThrow(/--store must be edge, chrome, or both/);
    expect(() => parseArguments(['--publish-target', 'everyone'])).toThrow(/--publish-target must be/);
    expect(() => parseArguments(['--publish-target', 'trustedTesters'])).toThrow(/preserves the existing store visibility/);
    expect(() => parseArguments(['--yolo'])).toThrow(/unknown argument --yolo/);
  });
});

describe('store submission workflow', () => {
  const workflow = readRepoFile(SUBMIT_WORKFLOW);

  test('declares the release trigger, says why it never fires, and runs on demand', () => {
    // The release trigger stays declared for manually created releases, but
    // the normal path is a manual dispatch: release.yml creates releases with
    // the workflow GITHUB_TOKEN, and GitHub suppresses that token's events to
    // prevent workflow recursion. The comment carrying that fact lives inside
    // the trigger block and is pinned here so a cleanup pass cannot silently
    // delete the knowledge and leave the next operator waiting for a run that
    // will never start.
    expect(workflow).toMatch(/on:\s*\n(?:\s*#[^\n]*\n)*\s*release:\s*\n\s*types:\s*\n\s*- published/);
    expect(workflow).toContain("GitHub suppresses events");
    expect(workflow).toContain('workflow_dispatch:');
  });

  test('keeps the token read-only, since it publishes to stores and not to the repository', () => {
    expect(workflow).toMatch(/^permissions:\s*\n\s*contents: read/m);
    expect(workflow).not.toContain('contents: write');
    expect(workflow).toContain('persist-credentials: false');
  });

  test('pins every action to the same commit as the quality workflow', () => {
    const quality = readRepoFile(path.join('.github', 'workflows', 'quality-gates.yml'));
    for (const pinned of workflow.match(/uses: [^\s]+/g) || []) {
      expect(pinned).toMatch(/@[0-9a-f]{40}$/);
      expect(quality).toContain(pinned);
    }
  });

  // Store credentials must arrive as secrets, never as literals in the file.
  test('reads every credential from secrets and nothing from the workflow text', () => {
    for (const name of [
      'EDGE_PRODUCT_ID',
      'EDGE_CLIENT_ID',
      'EDGE_API_KEY',
      'CHROME_ITEM_ID',
      'CHROME_CLIENT_ID',
      'CHROME_CLIENT_SECRET',
      'CHROME_REFRESH_TOKEN',
    ]) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    }
  });

  test('passes the non-secret publisher input through env and exposes a read-only status route', () => {
    expect(workflow).toContain('CHROME_PUBLISHER_ID: ${{ inputs.chrome_publisher_id || vars.CHROME_PUBLISHER_ID }}');
    expect(workflow).toContain("STATUS_ONLY: ${{ inputs.status_only && '--status-only' || '' }}");
    expect(workflow).toContain('$UPLOAD_ONLY $STATUS_ONLY $DIAGNOSE');
    expect(workflow).toContain("if: ${{ !inputs.status_only && !inputs.diagnose }}");
    expect(workflow).toContain('run-name: Store');
    expect(workflow).toContain('ref: ${{ github.event.release.tag_name || github.ref }}');
    expect(workflow.indexOf('ref: ${{ github.event.release.tag_name || github.ref }}')).toBeLessThan(workflow.indexOf('npm ci'));
    expect(workflow).not.toContain('git checkout --detach');
  });

  test('rebuilds and verifies the package before it can be uploaded', () => {
    expect(workflow).toContain('npm run extension:package');
    expect(workflow).toContain('npm run store:check');
    expect(workflow.indexOf('npm run extension:package')).toBeLessThan(workflow.indexOf('npm run store:submit'));
  });

  test('is wired to the npm script the repository documents', () => {
    const scripts = JSON.parse(readRepoFile('package.json')).scripts;
    expect(scripts['store:submit']).toBe('node scripts/submit-to-stores.js');
  });
});

describe('chrome refresh token helper', () => {
  const {
    awaitAuthorizationCode,
    buildConsentUrl,
    extractAuthorizationCode,
    readCredentials,
    readRefreshToken,
    SCOPE,
  } = require('../scripts/chrome-refresh-token');

  test('reads an interactive client secret without writing it to the terminal', async () => {
    const { PassThrough } = require('node:stream');
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {};
    let transcript = '';
    output.on('data', (chunk) => { transcript += chunk; });
    const prompt = readCredentials({ CHROME_CLIENT_ID: 'synthetic-client' }, input, output);
    input.write('synthetic-secret\r');
    await expect(prompt).resolves.toEqual({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret' });
    expect(transcript).toContain('OAuth client secret (input hidden)');
    expect(transcript).not.toContain('synthetic-secret');
  });

  test('asks for offline access, or the flow returns no refresh token at all', () => {
    const url = new URL(buildConsentUrl('client-123', 'http://127.0.0.1:5000'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(SCOPE);
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5000');
  });

  // The retired out-of-band redirect is exactly what the published guide still
  // shows; a client created today is refused by it.
  test('uses a loopback redirect rather than the retired out-of-band one', () => {
    expect(buildConsentUrl('client-123', 'http://127.0.0.1:5000')).not.toContain('oauth:2.0:oob');
  });

  test('reads the code out of the callback', () => {
    expect(extractAuthorizationCode('/?code=abc123&scope=x', 'http://127.0.0.1')).toBe('abc123');
  });

  // A declined consent must end the run, not leave it waiting forever.
  test('surfaces a declined consent instead of waiting', () => {
    expect(() => extractAuthorizationCode('/?error=access_denied', 'http://127.0.0.1')).toThrow(
      /Google returned "access_denied"/,
    );
    expect(() => extractAuthorizationCode('/', 'http://127.0.0.1')).toThrow(/neither a code nor an error/);
  });

  test('explains the fix when Google withholds the refresh token', () => {
    expect(() => readRefreshToken({ access_token: 'ya29' })).toThrow(/revoke this app under/);
    expect(readRefreshToken({ refresh_token: '1/rwn' })).toBe('1/rwn');
  });

  test('serves one callback on a loopback port and then stops', async () => {
    const pending = awaitAuthorizationCode(async (redirectUri) => {
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${redirectUri}/?code=from-browser`);
      expect(response.status).toBe(200);
    });
    await expect(pending).resolves.toBe('from-browser');
  });
});

describe('guided secret setup', () => {
  const { browserOpenCommand, cleanValue, secretSetArguments, ENVIRONMENT, REPO, STEPS } = require('../scripts/setup-store-secrets');
  const { planStoreSubmissions: plan } = require('../scripts/submit-to-stores');

  // The wizard and the workflow must agree on every name, or setup completes
  // and the submission still reports missing credentials.
  test('collects submission secrets while the non-secret publisher ID uses an input or variable', () => {
    const collected = [...STEPS.edge, ...STEPS.chrome].map((step) => step.secret);
    const required = plan({}, 'both').flatMap((entry) => entry.missing).filter((name) => name !== 'CHROME_PUBLISHER_ID');
    expect(collected.sort()).toEqual(required.sort());
  });

  test('targets the environment and repository the workflow reads', () => {
    expect(ENVIRONMENT).toBe('store-submission');
    const workflow = readRepoFile(path.join('.github', 'workflows', 'store-submit.yml'));
    expect(workflow).toContain(`environment: ${ENVIRONMENT}`);
    expect(REPO).toBe('himiyosh/network-plus-extension');
  });

  // The value goes over stdin; putting it in argv would expose it to any
  // process that can read the process table.
  test('never passes a secret value as a command-line argument', () => {
    const args = secretSetArguments('EDGE_API_KEY');
    expect(args).toEqual(['secret', 'set', 'EDGE_API_KEY', '--repo', REPO, '--env', ENVIRONMENT]);
    expect(args).not.toContain('--body');
  });

  // A pasted credential routinely carries a trailing newline, and the store
  // rejects it much later with an unhelpful error.
  test('trims whitespace that pasting adds', () => {
    expect(cleanValue('  abc123\n')).toBe('abc123');
    expect(cleanValue('\tdef\r\n')).toBe('def');
  });

  test('opens pages with the right command per platform', () => {
    expect(browserOpenCommand('darwin')).toBe('open');
    expect(browserOpenCommand('win32')).toBe('start');
    expect(browserOpenCommand('linux')).toBe('xdg-open');
  });

  test('hides the values that are credentials and not identifiers', () => {
    const hidden = [...STEPS.edge, ...STEPS.chrome].filter((step) => step.hidden).map((step) => step.secret);
    expect(hidden.sort()).toEqual(['CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN', 'EDGE_API_KEY']);
  });

  test('checks the two identifiers whose shape is documented', () => {
    const find = (secret) => [...STEPS.edge, ...STEPS.chrome].find((step) => step.secret === secret);
    expect(find('EDGE_PRODUCT_ID').check('d34f98f5-f9b7-42b1-bebb-98707202b21d')).toBeNull();
    expect(find('EDGE_PRODUCT_ID').check('not-a-guid')).toMatch(/GUID/);
    expect(find('CHROME_ITEM_ID').check('a'.repeat(32))).toBeNull();
    expect(find('CHROME_ITEM_ID').check('z'.repeat(32))).toMatch(/a-p/);
    expect(find('CHROME_CLIENT_ID').check('123.apps.googleusercontent.com')).toBeNull();
    expect(find('CHROME_CLIENT_ID').check('123')).toMatch(/googleusercontent/);
  });
});

describe('credential fingerprint', () => {
  const { fingerprint } = require('../scripts/submit-to-stores');

  // The point is to compare a value stored in CI against one on an operator
  // machine without either being printed, so the value must not be recoverable.
  test('identifies a value without disclosing it', () => {
    const secret = 'super-secret-api-key-value';
    const print = fingerprint(secret);
    expect(print).toMatch(/^len=26 sha=[0-9a-f]{8}$/);
    expect(print).not.toContain(secret);
    expect(print).not.toContain(secret.slice(0, 6));
  });

  test('distinguishes two values of the same length', () => {
    expect(fingerprint('aaaaaaaaaaaa')).not.toBe(fingerprint('aaaaaaaaaaab'));
  });

  test('is stable, so the two sides can be compared at all', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
  });

  // "Not configured" and "configured wrongly" are different diagnoses.
  test('reports an unset value as absent rather than hashing the empty string', () => {
    expect(fingerprint(undefined)).toBe('absent');
    expect(fingerprint('')).toBe('absent');
  });

  test('is reachable from the command line and the workflow', () => {
    expect(parseArguments(['--diagnose']).diagnose).toBe(true);
    expect(parseArguments([]).diagnose).toBe(false);
    const workflow = readRepoFile(path.join('.github', 'workflows', 'store-submit.yml'));
    expect(workflow).toContain("DIAGNOSE: ${{ inputs.diagnose && '--diagnose' || '' }}");
  });
});

describe('duplicate credential guard', () => {
  const { duplicateOf } = require('../scripts/setup-store-secrets');

  // What actually happened: the Edge product ID answered the client ID prompt
  // too, and the store rejected the pair with a bare 401 naming neither field.
  test('names the earlier field a repeated value came from', () => {
    const collected = [['EDGE_PRODUCT_ID', '4fcf1d3e-d1fe-4d4a-a741-97d8d8fa4241']];
    expect(duplicateOf('4fcf1d3e-d1fe-4d4a-a741-97d8d8fa4241', collected)).toBe('EDGE_PRODUCT_ID');
  });

  test('passes a genuinely different value', () => {
    const collected = [['EDGE_PRODUCT_ID', 'aaaa']];
    expect(duplicateOf('bbbb', collected)).toBeNull();
    expect(duplicateOf('aaaa', [])).toBeNull();
  });
});

describe('quoted credential values', () => {
  const { cleanValue: clean } = require('../scripts/setup-store-secrets');

  // What happened: a 36-character GUID arrived as 38 characters because the
  // .env line quoted it, and copying the line's text kept the quotes. A shell
  // strips them on `source`, so the same value worked locally and not in CI.
  test('strips matched surrounding quotes', () => {
    const guid = '4fcf1d3e-d1fe-4d4a-a741-97d8d8fa4241';
    expect(clean(`"${guid}"`)).toBe(guid);
    expect(clean(`'${guid}'`)).toBe(guid);
    expect(clean(`  "${guid}"  \n`)).toBe(guid);
    expect(clean(`"${guid}"`)).toHaveLength(36);
  });

  // A quote on one side is not a wrapper, and a credential may legitimately
  // contain one; removing it would corrupt the value.
  test('leaves unmatched or interior quotes alone', () => {
    expect(clean('"abc')).toBe('"abc');
    expect(clean('abc"')).toBe('abc"');
    expect(clean('ab"cd')).toBe('ab"cd');
    expect(clean('"')).toBe('"');
  });
});

describe('Edge product id from the dashboard URL', () => {
  const { extractEdgeProductId } = require('../scripts/setup-store-secrets');
  const GUID = '4fcf1d3e-d1fe-4d4a-a741-97d8d8fa4241';

  // Partner Center uses a GUID for both the product id and the API client id,
  // so no shape check separates them; the URL does.
  test('reads the product id out of the dashboard URL', () => {
    expect(
      extractEdgeProductId(`https://partner.microsoft.com/ja-jp/dashboard/microsoftedge/${GUID}/packages/dashboard`),
    ).toBe(GUID);
    expect(extractEdgeProductId(`https://partner.microsoft.com/dashboard/microsoftedge/${GUID}`)).toBe(GUID);
    expect(extractEdgeProductId(`  https://partner.microsoft.com/dashboard/microsoftedge/${GUID}/packages  `)).toBe(GUID);
  });

  test('still accepts a bare GUID', () => {
    expect(extractEdgeProductId(GUID)).toBe(GUID);
  });

  // A client id pasted here is a bare GUID and cannot be distinguished, but a
  // URL that is not the extension's dashboard must not yield anything.
  test('yields nothing for text that carries no product id', () => {
    expect(extractEdgeProductId('https://partner.microsoft.com/dashboard/microsoftedge/overview')).toBeNull();
    expect(extractEdgeProductId('not a guid at all')).toBeNull();
  });
});
