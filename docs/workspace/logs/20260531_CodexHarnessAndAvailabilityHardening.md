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

## Commands and key outputs

- `git status --short --branch` in the generated Codex cwd:
  - Failed with `fatal: not a git repository`, which established the provided cwd was not the actual repo.
- `find /Users/haitaoxu/AI_Workspace /Users/haitaoxu/Documents/Codex ...`:
  - Located `/Users/haitaoxu/AI_Workspace/x-spam-blocker`.
- `npm test` after adding RED tests:
  - Failed as intended: stale fixture, startup version mismatch, duplicate visible card not marked, delayed tweet text not re-evaluated.
- `npm test` after implementation:
  - `6/6 tests passed`.

## Validation checkpoints

- PASS: Regression harness executes without external services or browser login.
- PASS: Existing sample intent is preserved: Chinese batch-spam samples are marked; normal short replies are not.
- PASS: X SPA delayed rendering boundary is covered by a regression test.
- PASS: Duplicate visible spam-card boundary is covered by a regression test.
- PASS: Blocked-list collector injection is covered by a regression test.

## Not verified

- Not verified in the user's logged-in daily Chrome or real X account. The prior session established that this agent cannot directly operate the user's normal logged-in Chrome/Tampermonkey surface from this environment.
- Not verified against a fresh live X DOM snapshot. The harness uses local DOM fixtures and fake DOM behavior focused on the script's intended selectors and state transitions.
- Not published publicly yet. GitHub public visibility, GreasyFork/OpenUserJS release, and X announcement remain separate release steps.

## Rollback

- Code rollback: `git revert <this-session-commit>` after commit, or reset to `7a18710` only if the owner explicitly authorizes history/destructive rollback.
- Runtime rollback: reinstall the previous `x-spam-blocker.user.js` from commit `7a18710`, or switch Tampermonkey back to the older script copy if already installed.
