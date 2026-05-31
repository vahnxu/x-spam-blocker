# X Spam Blocker — Codex harness and availability hardening

- Date: 2026-05-31
- Agent: Codex / GPT-5
- Scope: improve the local regression harness first, then harden only the X Chinese batch-spam account/message userscript path.
- Target repo: `/Users/haitaoxu/AI_Workspace/x-spam-blocker`
- Harness cwd note: `/Users/haitaoxu/Documents/Codex/2026-05-31/repo-harness-claude-code-x` was an empty Codex harness shell (`work/`, `outputs/`) and not the actual git repo.
- Rollback reference before this session's changes: `7a18710` on `main`.

## Changed files

- `package.json`
  - Added a zero-dependency `npm test` command.
- `test/run-regression.js`
  - Added a Node-based fake DOM harness that loads the current `x-spam-blocker.user.js`.
  - Regression checks cover fixture freshness, version log parity, Chinese spam detection, duplicate visible cards, delayed tweet text re-evaluation, and blocked-list collector injection.
- `test/fixture.html`
  - Replaced stale embedded v0.4 script with a direct `../x-spam-blocker.user.js` reference.
- `x-spam-blocker.user.js`
  - Bumped userscript version to `0.6.0`.
  - Replaced one-shot `xspamSeen` gating with `xspamSignature` so X SPA delayed text can be re-evaluated.
  - Used a compact content hash for `xspamSignature` instead of storing full tweet text in `dataset`.
  - Marked every visible duplicate occurrence of the same spam handle, while deduplicating only auto-block requests.
  - Added handle-level blocked-state fanout for duplicate visible cards.
  - Bounded duplicate-card DOM tracking to the most recent 500 handles and pruned disconnected cells.
  - Prevented duplicate status panels on reinjection and made startup logs use the metadata version constant.
- `README.md`
  - Documented the regression harness, what intent it verifies, and current availability hardening points.

## 2026-05-31 live-X follow-up

- `x-spam-blocker.user.js`
  - Bumped userscript version through `0.6.3`.
  - Added city-matrix and contact-cue scoring for Chinese batch spam that does not use auto-generated handles.
  - Expanded city coverage with live X samples from second/lower-tier city burst posts.
  - Skipped nested candidate cells when an outer tweet/user cell is already the scoring surface, preventing duplicate badge/button overlays.
- `test/run-regression.js`
  - Added regressions for:
    - city-burst + `点击即可联系` spam with a non-auto-looking handle;
    - lower-tier city-burst spam with obfuscated escort wording;
    - X `article` / `cellInnerDiv` nesting where only one visible marker should be injected.
- `package.json`
  - Bumped package version to `0.6.3`.
- `README.md`
  - Added the new city-matrix/contact-cue and nested-card hardening points.

## Commands and key outputs

- `git status --short --branch` in the generated Codex cwd:
  - Failed with `fatal: not a git repository`, which established the provided cwd was not the actual repo.
- `find /Users/haitaoxu/AI_Workspace /Users/haitaoxu/Documents/Codex ...`:
  - Located `/Users/haitaoxu/AI_Workspace/x-spam-blocker`.
- `npm test` after adding RED tests:
  - Failed as intended: stale fixture, startup version mismatch, duplicate visible card not marked, delayed tweet text not re-evaluated.
- `npm test` after implementation:
  - `6/6 tests passed`.
- `npm test` after live-X follow-up:
  - `9/9 tests passed`.
- `node --check x-spam-blocker.user.js`:
  - PASS, no syntax errors.
- `git diff --check`:
  - PASS, no whitespace errors.
- Real Chrome / X validation:
  - First attempt accidentally hit `Chrome-Debug` (`--user-data-dir=.../Chrome-Debug`) and X login onboarding; treated as failed validation, no login attempted.
  - Corrected to the user's normal Chrome `Default` profile through the Codex Chrome Extension.
  - Tampermonkey script storage readback showed `sourceVersion=0.6.3` and `metaVersion=0.6.3`.
  - Live X search for `约炮`: `v0.6.3` startup logs present, panel present, 5 visible articles, 4 marked nodes, duplicate badge articles = 0.
  - Screenshot evidence: `/Users/haitaoxu/Documents/Codex/2026-05-31/repo-harness-claude-code-x/outputs/x-real-chrome-v063-final.png`.

## Validation checkpoints

- PASS: Regression harness executes without external services or browser login.
- PASS: Existing sample intent is preserved: Chinese batch-spam samples are marked; normal short replies are not.
- PASS: X SPA delayed rendering boundary is covered by a regression test.
- PASS: Duplicate visible spam-card boundary is covered by a regression test.
- PASS: Blocked-list collector injection is covered by a regression test.
- PASS: City-matrix/contact-cue spam without auto-generated handle shape is covered by regression tests.
- PASS: X nested card DOM does not create duplicate visible markers.
- PASS: Real logged-in normal Chrome profile shows `v0.6.3` running on X with visible red marker and manual block button.

## Not verified

- Automatic blocking mode remains intentionally not exercised against the live account; live verification used safe `mark` mode only.
- Not published publicly yet. GitHub public visibility, GreasyFork/OpenUserJS release, and X announcement remain separate release steps.

## Rollback

- Code rollback: `git revert <this-session-commit>` after commit, or reset to `7a18710` only if the owner explicitly authorizes history/destructive rollback.
- Runtime rollback: reinstall the previous `x-spam-blocker.user.js` from commit `7a18710`, or switch Tampermonkey back to the older script copy if already installed.
