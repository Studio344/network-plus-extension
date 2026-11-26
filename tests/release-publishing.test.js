'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildReleaseNotes, describeArchive, extractReleaseSection } = require('../scripts/build-release-notes');
const { EXPECTED_RELEASE_SHA256 } = require('../scripts/check-store-readiness');

const ROOT = path.join(__dirname, '..');
const RELEASE_WORKFLOW = path.join('.github', 'workflows', 'release.yml');
const readRepoFile = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('release notes builder', () => {
  const changelog = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '- No changes have been recorded since v9.9.9.',
    '',
    '## v9.9.9 - 2026-01-02',
    '',
    '- Added a thing.',
    '- Fixed another thing.',
    '',
    '## v9.9.8 - 2025-12-01',
    '',
    '- Older entry that must not leak into the newer section.',
    '',
  ].join('\n');

  test('extracts only the requested version section', () => {
    const section = extractReleaseSection(changelog, '9.9.9');
    expect(section.date).toBe('2026-01-02');
    expect(section.body).toBe('- Added a thing.\n- Fixed another thing.');
    expect(section.body).not.toContain('Older entry');
    expect(section.body).not.toContain('No changes have been recorded');
  });

  test('rejects a version with no recorded section', () => {
    expect(() => extractReleaseSection(changelog, '1.2.3')).toThrow(/no "## v1\.2\.3/);
  });

  test('rejects a section that carries no bullet entries', () => {
    const empty = ['# Changelog', '', '## v9.9.9 - 2026-01-02', '', '## v9.9.8 - 2025-12-01', ''].join('\n');
    expect(() => extractReleaseSection(empty, '9.9.9')).toThrow(/no bullet entries/);
  });

  test('describes an archive by name, byte length, and digest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-plus-release-'));
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

  test('renders the changelog body and the verifiable artifact facts', () => {
    const notes = buildReleaseNotes({
      version: '9.9.9',
      date: '2026-01-02',
      body: '- Added a thing.',
      archive: { name: 'network-plus-extension-9.9.9.zip', size: 1234, sha256: 'a'.repeat(64) },
    });
    expect(notes).toContain('Released 2026-01-02.');
    expect(notes).toContain('- Added a thing.');
    expect(notes).toContain('| Size | 1234 bytes |');
    expect(notes).toContain(`| SHA-256 | \`${'a'.repeat(64)}\` |`);
    expect(notes).toContain('Load unpacked');
  });
});

describe('release publishing workflow', () => {
  const workflow = readRepoFile(RELEASE_WORKFLOW);

  test('publishes from a reviewed version bump on main or from an explicit version tag', () => {
    // Tag pushes are rejected by some environments, so reaching main with a
    // bumped version is the primary trigger and the tag push is the fallback.
    expect(workflow).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*- main\s*\n\s*tags:\s*\n\s*- 'v\*'/);
    expect(workflow).toContain('tag="v$version"');
    expect(workflow).toContain('does not match package.json version');
  });

  test('skips a version that is already published instead of republishing it', () => {
    expect(workflow).toContain('refusing to overwrite a published release');
    expect(workflow).toContain('published=true');
    // Every step that builds or publishes is gated on the skip decision.
    const gated = workflow.match(/if: steps\.existing\.outputs\.published == 'false'/g) || [];
    expect(gated.length).toBeGreaterThanOrEqual(7);
  });

  test('keeps the default token read-only and grants write only to the publishing job', () => {
    expect(workflow).toMatch(/^permissions:\s*\n\s*contents: read/m);
    expect(workflow).toMatch(/permissions:\s*\n(?:\s*#[^\n]*\n)*\s*contents: write/);
    expect(workflow).toContain('persist-credentials: false');
  });

  test('pins every action to the same commit as the quality workflow', () => {
    const quality = readRepoFile(path.join('.github', 'workflows', 'quality-gates.yml'));
    // A local reusable workflow is versioned with this file, so it has no pin.
    const external = (workflow.match(/uses: [^\s]+/g) || []).filter((used) => !used.startsWith('uses: ./'));
    expect(external.length).toBeGreaterThan(0);
    for (const pinned of external) {
      expect(pinned).toMatch(/@[0-9a-f]{40}$/);
      expect(quality).toContain(pinned);
    }
  });

  test('verifies the tag, the package, and the published digest before releasing', () => {
    expect(workflow).toContain('npm run version:check');
    expect(workflow).toContain('npm run extension:check');
    expect(workflow).toContain('npm run extension:package');
    expect(workflow).toContain('npm run store:check');
    expect(workflow).toContain("require('./scripts/check-store-readiness.js').EXPECTED_RELEASE_SHA256");
    expect(workflow).toContain('does not match the digest recorded in the submission dossiers');
    // The publish step must run after the digest guard, never before it.
    expect(workflow.indexOf('archive digest verified')).toBeLessThan(workflow.indexOf('gh release create'));
  });

  test('takes only a release this run published to the stores', () => {
    // GITHUB_TOKEN releases raise no release event, so this call is the
    // automatic path. A rerun for an existing version must never resubmit.
    const submit = workflow.slice(workflow.indexOf('\n  submit:'));
    expect(submit).toContain('needs: publish');
    expect(submit).toContain("if: needs.publish.outputs.published == 'false'");
    expect(submit).toContain('uses: ./.github/workflows/store-submit.yml');
    expect(submit).toContain('store: both');
    expect(submit).toContain('ref: ${{ needs.publish.outputs.tag }}');
    expect(submit).toContain('secrets: inherit');
    expect(submit).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(workflow).toContain('published: ${{ steps.existing.outputs.published }}');
    expect(workflow).toContain('tag: ${{ steps.release.outputs.tag }}');
  });

  test('sends a release that changes store images as a draft only', () => {
    // Images have no store API, so package and media must share one review
    // that the operator submits after swapping the images by hand.
    expect(workflow).toContain('upload_only: ${{ needs.publish.outputs.media_changed == \'true\' }}');
    expect(workflow).toContain('git diff --quiet "$previous" "$GITHUB_SHA" -- docs/store-assets');
    // Only a clean comparison counts as unchanged; anything else is a draft.
    expect(workflow).toMatch(/if \[ -n "\$previous" \] && git diff --quiet[^\n]*\n[^\n]*\n\s*echo "media_changed=false"/);
    expect(workflow.indexOf('media_changed=true')).toBeGreaterThan(workflow.indexOf('media_changed=false'));
    expect(workflow.indexOf('id: media')).toBeLessThan(workflow.indexOf('gh release create'));
  });

  test('exposes the digest constant the workflow reads', () => {
    expect(EXPECTED_RELEASE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
