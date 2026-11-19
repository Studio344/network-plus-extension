const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findTrackedIgnoredFiles, validatePackageLock } = require('../scripts/check-repository-integrity');

const packageJson = {
  version: '1.5.0',
  devDependencies: {
    eslint: '^10.7.0',
  },
};

const createLockfile = () => ({
  version: '1.5.0',
  lockfileVersion: 3,
  packages: {
    '': {
      version: '1.5.0',
      devDependencies: {
        eslint: '^10.7.0',
      },
    },
    'node_modules/eslint': {
      version: '10.7.0',
      resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.7.0.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
    },
  },
});

describe('validatePackageLock', () => {
  test('accepts npm registry HTTPS URLs with sha512 integrity', () => {
    expect(validatePackageLock(createLockfile(), packageJson)).toEqual([]);
  });

  test('rejects untrusted registries and weak integrity hashes', () => {
    const lockfile = createLockfile();
    lockfile.packages['node_modules/eslint'].resolved = 'https://example.com/eslint.tgz';
    lockfile.packages['node_modules/eslint'].integrity = 'sha1-weak';

    expect(validatePackageLock(lockfile, packageJson)).toEqual([
      'node_modules/eslint must resolve from https://registry.npmjs.org',
      'node_modules/eslint must use sha512 integrity',
    ]);
  });

  test('rejects a registry URL for the wrong package identity', () => {
    const lockfile = createLockfile();
    lockfile.packages['node_modules/eslint'].resolved =
      'https://registry.npmjs.org/eslint-placeholder/-/eslint-placeholder-10.7.0.tgz';

    expect(validatePackageLock(lockfile, packageJson)).toEqual([
      'node_modules/eslint resolved URL must match its package identity',
    ]);
  });

  test('rejects stale root package metadata', () => {
    const lockfile = createLockfile();
    lockfile.version = '1.4.0';
    lockfile.packages[''].devDependencies.eslint = '^10.0.2';

    expect(validatePackageLock(lockfile, packageJson)).toEqual([
      'package-lock.json version metadata must match package.json',
      'package-lock.json development dependencies must match package.json',
    ]);
  });
});

test('guards local credentials, captures, and evidence without excluding public documentation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'network-plus-ignore-'));
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'core.ignoreCase=false', '-c', 'core.excludesFile=' + path.join(root, 'excludes'), ...args],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
  const localFiles = [
    '.env.edge',
    'tools/.env.cws',
    'captures/session.har',
    'captures/session.har.gz',
    'captures/session.saz',
    'captures/mixed.HaR.Gz',
    'captures/mixed.SaZ',
    'signing.pem',
    'release.zip',
    'outputs/verification.png',
    'test-results/result.json',
    '.claude/worktrees/check/README.md',
    'es-metadata.yml',
  ];
  const publicFiles = ['.env.example', 'README.md', 'docs/media/network-plus-banner.webp', 'tests/har.test.js'];

  try {
    git('init', '--quiet');
    fs.copyFileSync(path.join(__dirname, '..', '.gitignore'), path.join(root, '.gitignore'));
    for (const filename of [...localFiles, ...publicFiles]) {
      const target = path.join(root, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'synthetic fixture\n');
    }

    git('add', '--all');
    expect(git('ls-files').trim().split('\n').sort()).toEqual(['.gitignore', ...publicFiles].sort());
    expect(findTrackedIgnoredFiles(root)).toEqual([]);

    git('add', '--force', '--', ...localFiles);
    expect(findTrackedIgnoredFiles(root).sort()).toEqual(localFiles.sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
