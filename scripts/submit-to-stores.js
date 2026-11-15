'use strict';

// Uploads a released extension archive to Microsoft Edge Add-ons and the Chrome
// Web Store and submits it for review.
//
// Credentials are read from the environment and never printed. The archive is
// checked against the digest the submission dossiers pin before a single byte
// is uploaded, so this script cannot ship an archive nobody reviewed.
//
// API contracts (Chrome V2 checked 2026-11-15; Edge checked 2026-08-19):
// - Edge Add-ons Update API v1.1
//   https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api
//   https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/addons-api-reference
// - Chrome Web Store API
//   https://developer.chrome.com/docs/webstore/using-api
//   https://developer.chrome.com/docs/webstore/api/reference/rest

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EDGE_API_ROOT = 'https://api.addons.microsoftedge.microsoft.com';
const CHROME_TOKEN_URL = 'https://accounts.google.com/o/oauth2/token';
const CHROME_UPLOAD_ROOT = 'https://chromewebstore.googleapis.com/upload/v2';
const CHROME_ITEM_ROOT = 'https://chromewebstore.googleapis.com/v2';

// Both stores answer "accepted, come back later", so every submission ends in a
// poll. The ceiling is generous because upload processing is not instant, and
// bounded because a run that never terminates is worse than one that reports a
// timeout an operator can retry.
const POLL_INTERVAL_MS = 10000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const EDGE_TERMINAL_STATUS = Object.freeze({ Succeeded: 'succeeded', Failed: 'failed' });
const CHROME_TERMINAL_UPLOAD_STATE = Object.freeze({
  SUCCEEDED: 'succeeded',
  IN_PROGRESS: 'pending',
  FAILED: 'failed',
  NOT_FOUND: 'failed',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A secret that reached a log is a secret that has to be rotated, so anything
// that might carry one goes through here before it is written anywhere.
const redact = (text, secrets) => {
  let output = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      output = output.split(secret).join('***');
    }
  }
  return output;
};

// Identifies a credential without disclosing it, so a value stored in CI can be
// compared against the one that works on an operator machine. A length plus 8
// hex characters of a digest distinguishes two high-entropy secrets while
// revealing nothing usable about either.
const fingerprint = (value) => {
  const text = String(value == null ? '' : value);
  if (text.length === 0) return 'absent';
  return `len=${text.length} sha=${crypto.createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
};

const describeArchive = (archivePath) => {
  const bytes = fs.readFileSync(archivePath);
  return {
    name: path.basename(archivePath),
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
};

// The reviewed digest is the gate. An archive that does not match it may be
// newer, older, or tampered with; none of those are things to upload.
const assertArchiveMatchesReviewedDigest = (archive, expectedSha256) => {
  if (archive.sha256 !== expectedSha256) {
    throw new Error(
      `archive ${archive.name} has SHA-256 ${archive.sha256}, which does not match the digest recorded in the submission dossiers (${expectedSha256})`,
    );
  }
};

// Validate every requested store before mutating any of them. Use --store edge
// or --store chrome when only one store is intended.
const planStoreSubmissions = (env, requested) => {
  const wanted = requested === 'both' ? ['edge', 'chrome'] : [requested];
  const required = {
    edge: ['EDGE_PRODUCT_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY'],
    chrome: [
      'CHROME_PUBLISHER_ID',
      'CHROME_ITEM_ID',
      'CHROME_CLIENT_ID',
      'CHROME_CLIENT_SECRET',
      'CHROME_REFRESH_TOKEN',
    ],
  };

  return wanted.map((store) => {
    const missing = required[store].filter((name) => !env[name]);
    return {
      store,
      ready: missing.length === 0,
      missing,
      required: true,
    };
  });
};

const extractOperationId = (response) => {
  const location = response.headers.get('location');
  if (!location) {
    throw new Error('store accepted the request but returned no Location header, so the operation cannot be tracked');
  }
  // The header is documented as carrying the operationID; some responses send a
  // full URL instead, in which case the id is its last path segment.
  return location.split('/').filter(Boolean).pop();
};

const readBody = async (response) => {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
};

// Polls one operation until it reaches a terminal state, and turns "still
// running when the clock ran out" into a distinct, retryable failure rather
// than a silent success.
const pollUntilTerminal = async (describe, readStatus, options) => {
  const { intervalMs, timeoutMs, now, wait } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await readStatus();
    if (result.state === 'succeeded') return result;
    if (result.state === 'failed') {
      throw new Error(`${describe} failed: ${result.detail}`);
    }
    if (now() >= deadline) {
      throw new Error(
        `${describe} was still ${result.detail || 'in progress'} after ${Math.round(timeoutMs / 1000)}s; check the portal before retrying`,
      );
    }
    await wait(intervalMs);
  }
};

// --- Microsoft Edge Add-ons -------------------------------------------------

const edgeHeaders = (credentials) => ({
  Authorization: `ApiKey ${credentials.apiKey}`,
  'X-ClientID': credentials.clientId,
});

const interpretEdgeOperation = (payload) => {
  const status = payload && payload.status;
  const state = EDGE_TERMINAL_STATUS[status] || 'pending';
  const detail = [status, payload && payload.message, payload && JSON.stringify(payload.errors || [])]
    .filter((part) => part && part !== '[]')
    .join(' - ');
  return { state, detail: detail || 'InProgress' };
};

const submitToEdge = async (context) => {
  const { archive, notes, credentials, fetchImpl, log, secrets, uploadOnly, poll } = context;
  const product = `${EDGE_API_ROOT}/v1/products/${credentials.productId}`;

  log('edge: uploading the package');
  const upload = await fetchImpl(`${product}/submissions/draft/package`, {
    method: 'POST',
    headers: { ...edgeHeaders(credentials), 'Content-Type': 'application/zip' },
    body: archive.bytes,
  });
  if (upload.status !== 202) {
    const body = await readBody(upload);
    throw new Error(`edge package upload returned ${upload.status}: ${redact(body.text, secrets)}`);
  }
  const uploadOperation = extractOperationId(upload);
  log(`edge: upload acknowledged, operationId=${redact(uploadOperation, secrets)}`);

  await poll('edge package upload', async () => {
    const response = await fetchImpl(`${product}/submissions/draft/package/operations/${uploadOperation}`, {
      headers: edgeHeaders(credentials),
    });
    const body = await readBody(response);
    if (!response.ok) {
      return { state: 'failed', detail: `HTTP ${response.status}: ${redact(body.text, secrets)}` };
    }
    const result = interpretEdgeOperation(body.json);
    return { ...result, detail: redact(result.detail, secrets) };
  });
  log('edge: package accepted into the draft submission');
  log(`edge: upload receipt ${redact(JSON.stringify({ operationId: uploadOperation, state: 'Succeeded' }), secrets)}`);

  if (uploadOnly) {
    log('edge: stopping before publish because --upload-only was given');
    return {
      store: 'edge',
      outcome: 'uploaded',
      submitted: false,
      operationId: uploadOperation,
      operationState: 'Succeeded',
    };
  }

  log('edge: publishing the draft submission');
  const publish = await fetchImpl(`${product}/submissions`, {
    method: 'POST',
    headers: { ...edgeHeaders(credentials), 'Content-Type': 'application/json' },
    // The published sample writes `{ "notes"="text value" }`, which is not JSON.
    // The endpoint documents a JSON body, so this sends actual JSON.
    body: JSON.stringify({ notes }),
  });
  if (publish.status !== 202) {
    const body = await readBody(publish);
    throw new Error(`edge publish returned ${publish.status}: ${redact(body.text, secrets)}`);
  }
  const publishOperation = extractOperationId(publish);
  log(`edge: submission acknowledged, operationId=${redact(publishOperation, secrets)}`);

  await poll('edge publish', async () => {
    const response = await fetchImpl(`${product}/submissions/operations/${publishOperation}`, {
      headers: edgeHeaders(credentials),
    });
    const body = await readBody(response);
    if (!response.ok) {
      return { state: 'failed', detail: `HTTP ${response.status}: ${redact(body.text, secrets)}` };
    }
    const result = interpretEdgeOperation(body.json);
    return { ...result, detail: redact(result.detail, secrets) };
  });

  log(
    `edge: submission receipt ${redact(JSON.stringify({ operationId: publishOperation, state: 'Succeeded' }), secrets)}`,
  );
  return {
    store: 'edge',
    outcome: 'submitted',
    submitted: true,
    operationId: publishOperation,
    operationState: 'Succeeded',
  };
};

// --- Chrome Web Store -------------------------------------------------------

const requestChromeAccessToken = async (credentials, fetchImpl, secrets) => {
  const response = await fetchImpl(CHROME_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const body = await readBody(response);
  if (!response.ok || !body.json || !body.json.access_token) {
    throw new Error(`chrome token exchange returned ${response.status}: ${redact(body.text, secrets)}`);
  }
  return body.json.access_token;
};

const interpretChromeUpload = (payload) => {
  const state = CHROME_TERMINAL_UPLOAD_STATE[payload && payload.uploadState] || 'failed';
  return { state, detail: (payload && payload.uploadState) || 'missing upload state' };
};

const CHROME_ITEM_STATES = new Set([
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
  'REJECTED',
  'CANCELLED',
]);
const CHROME_ACCEPTED_STATES = new Set(['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

const interpretChromePublish = (payload) => ({
  state: payload && CHROME_ACCEPTED_STATES.has(payload.state) ? 'succeeded' : 'failed',
  detail: (payload && payload.state) || 'missing submission state',
});

const chromeResourceName = (credentials) => {
  for (const key of ['publisherId', 'itemId']) {
    if (typeof credentials[key] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(credentials[key])) {
      throw new Error(`chrome ${key} is missing or invalid`);
    }
  }
  return `publishers/${credentials.publisherId}/items/${credentials.itemId}`;
};

const assertChromeIdentity = (payload, name, itemId) => {
  if (!payload || payload.name !== name || payload.itemId !== itemId) {
    throw new Error('chrome response did not identify the requested publisher and item');
  }
};

// Only retain documented, non-secret fields for receipts. A status response has
// no draft version or package hash; lastAsyncUploadState alone proves neither.
const summarizeChromeStatus = (payload) => {
  if (
    payload.lastAsyncUploadState !== undefined &&
    !Object.hasOwn(CHROME_TERMINAL_UPLOAD_STATE, payload.lastAsyncUploadState) &&
    payload.lastAsyncUploadState !== 'UPLOAD_STATE_UNSPECIFIED'
  ) {
    throw new Error('chrome status has an unknown async upload state');
  }
  const revision = (value) => {
    if (!value) return null;
    const channels = value.distributionChannels === undefined ? [] : value.distributionChannels;
    if (!CHROME_ITEM_STATES.has(value.state) || !Array.isArray(channels)) {
      throw new Error('chrome status has an unknown state or missing revision channels');
    }
    const versions = channels.map((channel) => {
      if (!channel || typeof channel.crxVersion !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(channel.crxVersion)) {
        throw new Error('chrome status has a revision without a version');
      }
      return channel.crxVersion;
    });
    return { state: value.state, versions };
  };
  return {
    name: payload.name,
    itemId: payload.itemId,
    publishedRevision: revision(payload.publishedItemRevisionStatus),
    submittedRevision: revision(payload.submittedItemRevisionStatus),
    lastAsyncUploadState: payload.lastAsyncUploadState || null,
    takenDown: payload.takenDown === true,
    warned: payload.warned === true,
  };
};

const matchingChromeRevision = (status, version) => {
  if (status.takenDown) return null;
  return [status.submittedRevision, status.publishedRevision].find(
    (revision) => revision && CHROME_ACCEPTED_STATES.has(revision.state) && revision.versions.includes(version),
  );
};

const assertChromeCanSubmit = (status, version) => {
  if (status.takenDown) throw new Error('chrome item is taken down; check the developer dashboard');
  const expectedParts = version.split('.').map(Number);
  const newerPublishedVersion =
    status.publishedRevision &&
    status.publishedRevision.versions.find((published) => {
      const observedParts = published.split('.').map(Number);
      for (let index = 0; index < 4; index += 1) {
        const difference = (observedParts[index] || 0) - (expectedParts[index] || 0);
        if (difference !== 0) return difference > 0;
      }
      return false;
    });
  if (newerPublishedVersion) {
    throw new Error(
      `chrome already has newer published version ${newerPublishedVersion}; refusing to upload v${version}`,
    );
  }
  if (status.lastAsyncUploadState === 'IN_PROGRESS') {
    throw new Error('chrome has an upload in progress; check status before retrying');
  }
  const revision = status.submittedRevision;
  if (revision && (['PENDING_REVIEW', 'STAGED'].includes(revision.state) || revision.versions.includes(version))) {
    throw new Error(
      `chrome has an existing ${revision.state} revision (${revision.versions.join(', ') || 'unknown version'}); check status before retrying`,
    );
  }
};

const submitToChrome = async (context) => {
  const { archive, credentials, fetchImpl, log, secrets, uploadOnly, poll, version, statusOnly = false } = context;
  const name = chromeResourceName(credentials);
  if (context.publishTarget && context.publishTarget !== 'default') {
    throw new Error('Chrome V2 preserves existing visibility; --publish-target must be default');
  }
  if (typeof version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(version)) {
    throw new Error('chrome expected release version is required and must be numeric');
  }
  const token = await requestChromeAccessToken(credentials, fetchImpl, secrets);
  const allSecrets = [...secrets, token];
  const authHeaders = { Authorization: `Bearer ${token}` };
  const resourceUrl = `${CHROME_ITEM_ROOT}/${name}`;
  const readStatus = async () => {
    const response = await fetchImpl(`${resourceUrl}:fetchStatus`, { headers: authHeaders });
    const body = await readBody(response);
    if (!response.ok) throw new Error(`chrome status returned ${response.status}: ${redact(body.text, allSecrets)}`);
    assertChromeIdentity(body.json, name, credentials.itemId);
    return summarizeChromeStatus(body.json);
  };
  const receipt = (outcome, status, submitted = false) => ({
    store: 'chrome',
    outcome,
    submitted,
    expectedVersion: version,
    // The hash identifies our reviewed upload; it is not a server hash readback.
    ...(archive ? { localArchiveSha256: archive.sha256 } : {}),
    ...status,
  });
  const recover = async (stage, error) => {
    let status;
    try {
      status = await readStatus();
    } catch (readError) {
      throw new Error(
        `chrome ${stage} outcome is unconfirmed: ${redact(error.message, allSecrets)}; readback failed: ${redact(readError.message, allSecrets)}; use --store chrome --status-only before retrying`,
        { cause: readError },
      );
    }
    if (matchingChromeRevision(status, version)) return receipt('observed-after-error', status);
    throw new Error(
      `chrome ${stage} was not confirmed for v${version}: ${redact(error.message, allSecrets)}; status=${JSON.stringify(status)}; use --store chrome --status-only before retrying`,
    );
  };

  const before = await readStatus();
  log(`chrome: status ${JSON.stringify(before)}`);
  if (statusOnly) return receipt('status-only', before);
  if (matchingChromeRevision(before, version)) return receipt('already-submitted-or-published', before);
  assertChromeCanSubmit(before, version);

  let uploadVersionVerified = false;
  try {
    log('chrome: uploading the reviewed package');
    const upload = await fetchImpl(`${CHROME_UPLOAD_ROOT}/${name}:upload`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/zip' },
      body: archive.bytes,
    });
    const body = await readBody(upload);
    if (!upload.ok) throw new Error(`upload returned ${upload.status}: ${redact(body.text, allSecrets)}`);
    assertChromeIdentity(body.json, name, credentials.itemId);
    const result = interpretChromeUpload(body.json);
    if (body.json.crxVersion && body.json.crxVersion !== version)
      throw new Error('upload returned a different version');
    if (result.state === 'failed') throw new Error(`upload failed: ${result.detail}`);
    if (result.state === 'succeeded') {
      if (body.json.crxVersion !== version) throw new Error('upload did not confirm the expected version');
      uploadVersionVerified = true;
    } else {
      await poll('chrome package upload', async () => {
        const status = await readStatus();
        return interpretChromeUpload({ uploadState: status.lastAsyncUploadState });
      });
    }
  } catch (error) {
    return recover('upload', error);
  }

  const uploaded = await readStatus();
  if (uploadOnly) return { ...receipt('uploaded', uploaded), uploadState: 'SUCCEEDED', uploadVersionVerified };
  if (matchingChromeRevision(uploaded, version)) return receipt('already-submitted-or-published', uploaded);
  assertChromeCanSubmit(uploaded, version);
  try {
    log('chrome: submitting the draft for review with existing visibility and rollout');
    const publish = await fetchImpl(`${resourceUrl}:publish`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await readBody(publish);
    if (!publish.ok) throw new Error(`publish returned ${publish.status}: ${redact(body.text, allSecrets)}`);
    assertChromeIdentity(body.json, name, credentials.itemId);
    const result = interpretChromePublish(body.json);
    if (result.state !== 'succeeded') throw new Error(`publish failed: ${result.detail}`);
    if (body.json.warningInfo)
      log(`chrome: publish warnings ${redact(JSON.stringify(body.json.warningInfo), allSecrets)}`);
    log(`chrome: submission acknowledged, state=${result.detail}; verifying version`);
    const verified = await poll('chrome submission readback', async () => {
      const status = await readStatus();
      if (matchingChromeRevision(status, version)) return { state: 'succeeded', status };
      const rejected =
        status.takenDown ||
        (status.submittedRevision &&
          status.submittedRevision.versions.includes(version) &&
          ['REJECTED', 'CANCELLED', 'STAGED'].includes(status.submittedRevision.state));
      return { state: rejected ? 'failed' : 'pending', detail: JSON.stringify(status) };
    });
    return receipt('submitted', verified.status, true);
  } catch (error) {
    return recover('publish', error);
  }
};

// --- Entry point ------------------------------------------------------------

const parseArguments = (argv) => {
  const options = {
    store: 'both',
    archive: '',
    notesFile: '',
    uploadOnly: false,
    statusOnly: false,
    publishTarget: 'default',
    diagnose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--upload-only') options.uploadOnly = true;
    else if (argument === '--status-only') options.statusOnly = true;
    else if (argument === '--diagnose') options.diagnose = true;
    else if (argument === '--store') options.store = argv[(index += 1)];
    else if (argument === '--archive') options.archive = argv[(index += 1)];
    else if (argument === '--notes-file') options.notesFile = argv[(index += 1)];
    else if (argument === '--publish-target') options.publishTarget = argv[(index += 1)];
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!['edge', 'chrome', 'both'].includes(options.store)) {
    throw new Error(`--store must be edge, chrome, or both (received ${options.store})`);
  }
  if (options.publishTarget !== 'default') {
    throw new Error('--publish-target must be default; Chrome V2 preserves the existing store visibility');
  }
  if (options.statusOnly && (options.store !== 'chrome' || options.uploadOnly || options.diagnose)) {
    throw new Error('--status-only requires --store chrome and cannot be combined with --upload-only or --diagnose');
  }
  return options;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.diagnose) {
    // Reaching a store and being refused by it looks the same whether the value
    // is wrong or the account is not entitled. This separates the two without
    // printing anything an operator would have to rotate afterwards.
    for (const name of [
      'EDGE_PRODUCT_ID',
      'EDGE_CLIENT_ID',
      'EDGE_API_KEY',
      'CHROME_ITEM_ID',
      'CHROME_PUBLISHER_ID',
      'CHROME_CLIENT_ID',
      'CHROME_CLIENT_SECRET',
      'CHROME_REFRESH_TOKEN',
    ]) {
      process.stdout.write(`${name.padEnd(22)} ${fingerprint(process.env[name])}\n`);
    }
    return;
  }
  const root = process.cwd();
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const plans = planStoreSubmissions(process.env, options.store);
  for (const plan of plans) {
    if (!plan.ready) throw new Error(`${plan.store} was requested but is missing ${plan.missing.join(', ')}`);
  }
  let archive;
  if (!options.statusOnly) {
    const archivePath = options.archive || path.join(root, 'dist', `network-plus-extension-${version}.zip`);
    if (!fs.existsSync(archivePath)) {
      throw new Error(`${archivePath} is missing; run npm run extension:package first`);
    }
    const { EXPECTED_RELEASE_SHA256 } = require('./check-store-readiness.js');
    archive = describeArchive(archivePath);
    assertArchiveMatchesReviewedDigest(archive, EXPECTED_RELEASE_SHA256);
    process.stdout.write(`archive ${archive.name} verified: ${archive.size} bytes, SHA-256 ${archive.sha256}\n`);
  }

  const notes = options.notesFile
    ? fs.readFileSync(options.notesFile, 'utf8').trim()
    : `Network+ for DevTools v${version}. Release notes: https://github.com/himiyosh/network-plus-extension/releases/tag/v${version}`;

  const secrets = [process.env.EDGE_API_KEY, process.env.CHROME_CLIENT_SECRET, process.env.CHROME_REFRESH_TOKEN].filter(
    Boolean,
  );
  const log = (message) => process.stdout.write(`${redact(message, secrets)}\n`);
  const poll = (describe, readStatus) =>
    pollUntilTerminal(describe, readStatus, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
      now: () => Date.now(),
      wait: sleep,
    });

  const results = [];
  for (const plan of plans) {
    const shared = {
      archive,
      notes,
      version,
      // Bound each HTTP call as well as the polling loop; never retry a POST.
      fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(120000) }),
      log,
      secrets,
      uploadOnly: options.uploadOnly,
      statusOnly: options.statusOnly,
      poll,
      publishTarget: options.publishTarget,
    };
    if (plan.store === 'edge') {
      results.push(
        await submitToEdge({
          ...shared,
          credentials: {
            productId: process.env.EDGE_PRODUCT_ID,
            clientId: process.env.EDGE_CLIENT_ID,
            apiKey: process.env.EDGE_API_KEY,
          },
        }),
      );
    } else {
      results.push(
        await submitToChrome({
          ...shared,
          credentials: {
            publisherId: process.env.CHROME_PUBLISHER_ID,
            itemId: process.env.CHROME_ITEM_ID,
            clientId: process.env.CHROME_CLIENT_ID,
            clientSecret: process.env.CHROME_CLIENT_SECRET,
            refreshToken: process.env.CHROME_REFRESH_TOKEN,
          },
        }),
      );
    }
    const result = results[results.length - 1];
    log(
      `receipt ${JSON.stringify({
        expectedVersion: version,
        ...(archive ? { localArchiveSha256: archive.sha256 } : {}),
        ...result,
      })}`,
    );
  }
  process.stdout.write(
    'OK: requested store operations completed; see each receipt for submission and publication state\n',
  );
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertArchiveMatchesReviewedDigest,
  fingerprint,
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
  summarizeChromeStatus,
  submitToEdge,
  CHROME_ITEM_ROOT,
  CHROME_TOKEN_URL,
  CHROME_UPLOAD_ROOT,
  EDGE_API_ROOT,
};
