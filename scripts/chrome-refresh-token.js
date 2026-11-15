'use strict';

// Obtains the Chrome Web Store refresh token that `npm run store:submit` needs,
// by running the OAuth consent flow once against a loopback listener.
//
// Run it on an operator machine, never in CI:
//   node scripts/chrome-refresh-token.js
//
// The published Chrome Web Store guide still documents the out-of-band flow
// (redirect_uri=urn:ietf:wg:oauth:2.0:oob), which Google retired; a client
// created today is refused by it. A Desktop App client accepts a loopback
// redirect on any port, which is what this uses.
//
// The client secret prompt suppresses echo. Existing environments can also
// supply both values to the process.

const http = require('http');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');

const CONSENT_ROOT = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN_URL = 'https://accounts.google.com/o/oauth2/token';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const buildConsentUrl = (clientId, redirectUri) => {
  const query = new URLSearchParams({
    response_type: 'code',
    scope: SCOPE,
    client_id: clientId,
    redirect_uri: redirectUri,
    // Google only returns a refresh token when it is asked for offline access,
    // and only on the first consent unless the prompt is forced. A run that
    // returns an access token but no refresh token is a wasted round trip.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${CONSENT_ROOT}?${query.toString()}`;
};

// The callback arrives as a browser request, which may carry an error instead
// of a code. Both have to be recognized, or the run hangs on a flow the user
// already declined.
const extractAuthorizationCode = (requestUrl, origin) => {
  const url = new URL(requestUrl, origin);
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`Google returned "${error}" instead of an authorization code`);
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('the callback carried neither a code nor an error');
  }
  return code;
};

const readRefreshToken = (payload) => {
  if (!payload || !payload.refresh_token) {
    // Google omits the refresh token when the account has already granted this
    // client and the request did not force a fresh consent.
    throw new Error(
      'the token response carried no refresh_token; revoke this app under https://myaccount.google.com/permissions and run this again',
    );
  }
  return payload.refresh_token;
};

const exchangeCodeForTokens = async (code, credentials, redirectUri) => {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`token exchange returned ${response.status}: ${text}`);
  }
  return readRefreshToken(JSON.parse(text));
};

// Serves exactly one callback, then stops. The port is chosen by the OS so the
// helper never collides with something the operator is already running.
const awaitAuthorizationCode = (onListening) =>
  new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      let code;
      try {
        code = extractAuthorizationCode(request.url, 'http://127.0.0.1');
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(`${error.message}\n`);
        server.close(() => reject(error));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Authorization received. You can close this tab and return to the terminal.\n');
      server.close(() => resolve(code));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => onListening(`http://127.0.0.1:${server.address().port}`));
  });

const readCredentials = async (env, input, output) => {
  const credentials = {
    clientId: env.CHROME_CLIENT_ID,
    clientSecret: env.CHROME_CLIENT_SECRET,
  };
  if (credentials.clientId && credentials.clientSecret) return credentials;
  if (!input.isTTY) throw new Error('Run in a terminal or supply OAuth credentials in the process environment.');

  let muted = false;
  const terminalOutput = new Writable({
    write(chunk, encoding, callback) {
      if (muted) callback();
      else output.write(chunk, encoding, callback);
    },
  });
  const terminal = readline.createInterface({ input, output: terminalOutput, terminal: true, historySize: 0 });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.once('SIGINT', cancel);
  terminal.once('close', cancel);
  const question = (prompt) => terminal.question(prompt, { signal: controller.signal });
  try {
    if (!credentials.clientId) credentials.clientId = (await question('OAuth client ID: ')).trim();
    if (!credentials.clientSecret) {
      output.write('OAuth client secret (input hidden): ');
      muted = true;
      try {
        credentials.clientSecret = (await question('')).trim();
      } finally {
        muted = false;
        output.write('\n');
      }
    }
  } finally {
    terminal.close();
  }
  if (!credentials.clientId || !credentials.clientSecret) throw new Error('Both OAuth credentials are required.');
  return credentials;
};

const main = async () => {
  const credentials = await readCredentials(process.env, process.stdin, process.stderr);
  let redirectUri = '';
  const code = await awaitAuthorizationCode((uri) => {
    redirectUri = uri;
    process.stdout.write(
      [
        'Add this exact URI to the OAuth client under "Authorized redirect URIs" if it is not accepted:',
        `  ${redirectUri}`,
        '',
        'Open this URL, sign in as the account that OWNS the Chrome Web Store item, and accept:',
        `  ${buildConsentUrl(credentials.clientId, redirectUri)}`,
        '',
        'Waiting for the callback...',
        '',
      ].join('\n'),
    );
  });

  const refreshToken = await exchangeCodeForTokens(code, credentials, redirectUri);
  process.stdout.write(
    [
      '',
      'Store this as the CHROME_REFRESH_TOKEN repository secret. It is not printed again:',
      '',
      refreshToken,
      '',
    ].join('\n'),
  );
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  awaitAuthorizationCode,
  buildConsentUrl,
  extractAuthorizationCode,
  readCredentials,
  readRefreshToken,
  SCOPE,
};
