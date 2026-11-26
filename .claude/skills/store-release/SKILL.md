---
name: store-release
description: >-
  Cut a new Network+ release and resubmit it to the Microsoft Edge Add-ons and
  Chrome Web Store listings, end to end: version bump, changelog cut, digest
  repointing, merge, GitHub release, store upload, and review submission. Use
  this whenever the user asks to release, publish, resubmit, bump the version,
  or ship accumulated changes to the stores — including Japanese phrasings such
  as リリース, 再申請, ストア申請, 公開, バージョンアップ, ストアに出す — and
  whenever store-submit runs fail and need diagnosing. Do not improvise the
  release steps from memory; this runbook encodes the order and the failure
  modes that were learned the hard way.
---

# Store release runbook

Turns the accumulated `## Unreleased` changes into a published GitHub release
and submits that exact archive to both browser stores. The digest pinned in
the dossiers is the gate everywhere: CI refuses to publish a release, and the
submission workflow refuses to upload, unless the archive it builds matches
it. That is why the order below matters — the digest is computed once, at the
cut, and everything downstream verifies against it.

Two facts shape the whole flow. First, `store-submit.yml` **never fires on the
release event**: the release is created by `release.yml` using the workflow
`GITHUB_TOKEN`, and GitHub suppresses workflow triggers from events created
with that token (recursion prevention). So `release.yml` calls it with
`workflow_call` and `store=both` on the new tag, only in a run that created
the release. When `docs/store-assets/` changed since the previous release, or
the comparison fails, that call is `upload_only` and leaves drafts for the
media sequence below. Retries, Chrome `status_only`, `diagnose`, and the final
media-changed submission are started by hand with `workflow_dispatch` on the
verified release tag. Second, **listing text and images have no
API on either store** — the Chrome Items API and the Edge Update API both take
packages and nothing else. Package submission is therefore automated in CI;
the images are swapped by `npm run store:pages`, which drives the two consoles
from the operator's own machine. Listing *text* is still entered in the portal,
and it must be compared with the dossier's description block on **every**
release: through v1.13.0 both listings silently kept the first-submission text
because it was only retyped when the dossier changed.

## Phase 0 — before cutting

- Read back the existing branch, worktree, latest release, and store workflow runs. Work from verified green `main` in the designated checkout or an isolated worktree. Record any running or accepted submission before taking action.
- Pick a version from the accumulated changelog (new features → minor). Check that the intended version has no prior release or store submission. Use the standing merge and release authorization in `CLAUDE.md` and the current request.
- Compare both existing listings and the dossier description blocks. Check `docs/store-assets/` against the previously submitted ref. A changed dossier digest alone does not require a listing or media edit.
- Use the existing `store-submission` environment and the current provider accounts. Chrome Web Store API V2 uses the existing refresh token and the publisher ID from **Publisher → Settings** for the publisher that owns the existing item. Pass the identifier as the workflow’s `chrome_publisher_id` input or reuse the configured `CHROME_PUBLISHER_ID` Actions variable. Use the [Chrome API guide](https://developer.chrome.com/docs/webstore/using-api/) to confirm the account and item. If a publisher ID or a fresh authorization is required, continue the other authorized phases and report what the affected store needs.
- The Edge API key can expire. Reuse an authorized existing status check when available. Follow [troubleshooting](references/troubleshooting.md) for authentication errors and uncertain submissions.

## Phase 1 — cut the release (one commit, plus a reopen commit)

Work on the designated working branch. `npm run version:check` is the
authority for version locations; the known set is:

| File | What |
| --- | --- |
| `package.json`, `manifest.json` | `"version"` |
| `package-lock.json` | two `"version"` entries |
| `panel.js` | `TEST_EXTENSION_VERSION_FALLBACK` |
| `tests/extension-package.test.js` | expected zip name |
| `tests/panel.test.js` | four version literals |

The READMEs (`README.md`, `README.ja.md`) are deliberately version-free —
every release link points at `releases/latest` — so the cut never touches
them, and `version:check` fails if a versioned route or version literal
sneaks back in.

1. Bump all of the above to the new version.
2. In `docs/CHANGELOG.md`, rename `## Unreleased` to `## vX.Y.Z - YYYY-MM-DD`.
3. Build twice and require identical bytes — the digest is only worth pinning
   if the build is reproducible:
   Run `TZ=UTC npm run extension:package` for both builds. Copy the first ZIP to the
   evidence directory, compare with `cmp`, and record bytes and SHA-256 with
   `wc -c` and `shasum -a 256`. Preserve the first ZIP for the public readback.
4. Repoint the digest pins at the new archive:
   - `scripts/check-store-readiness.js` → `EXPECTED_RELEASE_SHA256`
   - `tests/store-readiness.test.js` → the same digest appears twice
   - `docs/edge-addons-submission.md` and `docs/chrome-web-store-submission.md`
     → version, zip name, size, digest, download URL. Use the **cut-time
     phrasing**: the archive "was built from the reviewed commit … Public
     observation of the release is a post-merge step and is not claimed
     here". Never claim the release was publicly observed in the commit that
     creates it — it cannot have been. Move the previous version's evidence
     row to "Superseded as the upload source by vX.Y.Z".
   - Finish by grepping both dossiers for the previous version string. The
     only legitimate hits are evidence-table history rows and the two
     "vX.Y.Z satisfies this against v<prev>" sentences; any other hit is a
     missed repoint. (The v1.11.0 cut missed exactly one this way: the
     Chrome dossier's "Upload `network-plus-extension-<prev>.zip`" bullet.)
5. Commit (`release: cut vX.Y.Z and repoint the store kits at it`).
6. Reopen the changelog in a second commit: add back `## Unreleased` with the
   placeholder bullet `- No changes have been recorded since vX.Y.Z.` — the
   changelog gate requires the section to always exist with a bullet, and the
   release-notes builder skips exactly this placeholder.
7. Run the exact candidate gates from `CLAUDE.md`. Derive the suite count
   from Git and `npm --silent test -- --list`. Run the full suites with installed Edge and Chrome and
   require zero skips. Use `EDGE_BIN` for Edge and unset it when setting
   `CHROME_BIN` for Chrome. Load the extracted checked ZIP in fresh browser
   profiles for changed user journeys. Record source ref, ZIP digest, actual
   browser version and results. Follow any requested independent review and
   actual test requirements for the release.

## Phase 2 — merge and let CI publish the release

1. Push and open the PR. Verify that required Node 22 and Node 24 checks
   passed for the current head, and that the merge tree matches the reviewed candidate.
   Merge through the PR once all gates and existing authorization are satisfied.
2. Synchronize `develop` as the repository permits. Honor the current GitHub
   branch rules before updating it.
3. The push to `main` runs `release.yml`. Verify the public tag points to the
   reviewed merge and re-download its single release ZIP. Check its byte count
   and whole digest against both dossiers, and `cmp` it against the reviewed ZIP
   before starting store submission. An existing release can make the job
   skip. Verify its asset independently in that case.

## Phase 3 — submit to each store

For the existing listing, reconcile the latest known draft/review state and
previous dispatches. Chrome V2 reads live submitted and published version
state before changing the item. Use the Chrome `status_only` workflow input for an authenticated readback without uploading or submitting. Edge's Update API reads specific operation
IDs. Check the Partner Center draft if a previous Edge result is uncertain.
Keep the installed listing's visibility and markets.

The merge's `release.yml` run already called `store-submit.yml` once for both
stores (its `Submit to stores` job). Read that run first: submitted when media
was unchanged, uploaded as drafts when it changed. Dispatch by hand only to
retry, to finish the media sequence, or when the automatic job did not run.
For a manual run, dispatch `store-submit.yml` with `ref=vX.Y.Z` and explicit
`store=edge` or `store=chrome`, one run per store. The tag pins both the
submission code and the archive source. Confirm each run's head matches the
tag and log shows the expected archive bytes and SHA-256. With GitHub CLI,
`gh workflow run store-submit.yml --ref vX.Y.Z -f store=edge` is the Edge
example. The Actions interface or the [dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
accepts the same ref and inputs.

**Media unchanged** — the automatic call already made the normal review
submission for each store. Record each store's acknowledgement and available
operation/version status independently.

**Media changed** — sequence it so one review carries everything:

1. The automatic call already uploaded to both stores with `upload_only`, so
   each package is in a draft. Dispatch once per affected store with
   `upload_only=true` only if that job did not run or failed.
2. Swap the images with `npm run store:pages` on the operator's machine — it
   cannot run in CI, because it needs an interactive sign-in and a profile
   that survives between runs:

   ```
   npm run store:pages -- login     # once, or whenever a session expires
   npm run store:pages -- status    # confirms both consoles are signed in
   npm run store:pages -- chrome
   npm run store:pages -- edge
   ```

   It reads the file list from `docs/store-assets/inventory.json`, so a
   re-capture that renames a file cannot leave it uploading the previous set.
   It never touches the store icon or submits anything. It needs
   `CHROME_ITEM_ID` and `EDGE_PRODUCT_ID` in the environment or in a local
   `.env.cws` / `.env.edge`; those identifiers are recorded in CLAUDE.md.

   - `chrome` reads and fingerprints every slot first and refuses to start if
     anything could fail partway. It keeps screenshots that already match and
     replaces the required tiles through their inputs, never by clearing them.
   - `edge` clears the screenshots, saves and reloads, then uploads one at a
     time, waiting for each file name to appear.
   - Both end by reloading the console and printing what it actually holds, and
     exit 1 when that differs from `docs/store-assets/`. A failure lists exactly
     what the run had already removed, replaced and uploaded.
   - `status` is safe to run while the `login` window is open: it attaches to
     that browser and leaves it running.

   **Still reload the console and read the listing after this step.** Both
   stores broke the draft in the v1.12.0 and v1.14.0 cycles while the log read
   as success. The fixes are unit-tested but have not yet run against a live
   console, so the first release that uses them is the live check.
   `references/troubleshooting.md` has the symptoms and a pixel-comparison
   check that settles listing state without trusting the log. If `chrome`
   refuses to start because slots look empty or have no input, but the console
   clearly shows images, check the console language first. Labels are matched
   in Japanese and English only, so a third language needs its label added to
   `CHROME_SLOTS`. The slot-by-slot manual procedure in the two submission
   dossiers remains the fallback.
3. Dispatch again without `upload_only` — the publish step submits the whole
   draft, package and media edits together. (The user pressing the portal's
   own submit button is equivalent.)

Read each store's log and store-reported result. Record GitHub run URL, tag,
archive identity, and the Edge upload and submission operation IDs or the
Chrome item/version and revision state. API acceptance and in-review states
are separate from approval and public distribution. Reconcile failed, skipped,
or ambiguous results before retrying, then retry only the affected store.
An earlier accepted operation can finish after the workflow times out.

For credentials, policy or consent blockers, record the affected store and
required operator action and follow [troubleshooting](references/troubleshooting.md).
Keep credential values out of logs, notes, and handoffs.

## Phase 4 — record the published release (follow-up PR)

Record the downloaded asset URL, readback size/digest, verified tag commit,
and each store's state in the release handoff. Carry pending review and
distribution status forward so a later operator can check or resume it.

When recording publication evidence in the repository, use a fresh branch
and update both dossiers with the date actually observed, exact asset URL,
size, SHA-256 and byte comparison results. Add the release to the Edge
evidence table and run the usual PR gates. The Phase 2 comparison already
establishes GitHub asset identity for Phase 3.
