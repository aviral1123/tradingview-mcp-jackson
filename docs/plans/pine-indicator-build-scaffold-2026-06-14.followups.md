# Follow-ups — Pine indicator build scaffold

Open items deferred from the 2026-06-14/15 work. Branch: `feat/pine-indicator-build-scaffold`
(commits `db9bc0d` scaffold, `acac512` runner hardening, `4986b27` bias-stack v2).
Status as of 2026-06-15: scaffold + Bias Stack done and saved to TradingView account ("Bias Stack" v2).

## 1. Push the branch / open a PR
- `git push -u origin feat/pine-indicator-build-scaffold`, then `gh pr create` if wanted.
- Nothing pushed yet; all three commits are local only.

## 2. Commit the `127.0.0.1` fix (it's a dependency of this branch)
- `src/connection.js`, `src/core/tab.js`, `src/core/health.js` are still **uncommitted** in the working tree.
- The scaffold's live path (and the whole MCP connection) depends on this fix — a fresh checkout of this
  branch alone would NOT have working CDP without it.
- It's a separate logical change, so commit it on its own (don't fold into the scaffold commits).

## 3. Make the runner's `--save` reliable (currently it is NOT)
The build/render path works; `--save` does not reliably reach the chart or save. Manual save works
(what we did: user creates a blank editable script → `pine_set_source` → Save). What the fix must handle,
learned live on 2026-06-15:

- **"Save and add to chart" confirmation.** Clicking "Add to chart" on a script with unsaved changes pops
  *"Cannot add a script with unsaved changes to chart. Do you want to save them?"* with `No` /
  `Save and add to chart`. The runner never clicks through it, so the add stalls. Adding a NEW script to
  chart inherently requires saving it first.
- **Read-only-script reversion.** The desktop app's programmatic `pine_new`/`newScript` sometimes leaves a
  read-only *published* script open (e.g. a Zeiierman script the user added). You can't save over it →
  "Request error". The user's **manual** "New → Indicator" reliably gives an editable script; the API one
  does not on this build. Fix needs to either detect read-only state and bail with guidance, or find a
  reliable programmatic "new editable script".
- **"Add to chart" button text is duplicated** — `textContent` is `"Add to chartAdd to chart"`, so exact-text
  matching misses it. The runner already uses a lenient `indexOf('add to chart')` matcher (keep that).
- **Saved-script name prefix doesn't stick.** Filling the save dialog's name input (React-controlled) with
  `"AT · Bias Stack"` reverted to the `indicator()` title `"Bias Stack"`. Either find a robust way to set the
  name, or drop the `AT ·` prefix convention (plain title is arguably cleaner).
- The `interpretCompile` `study_added === false` gate should probably become a non-fatal warning for `--save`
  (saving is independent of a fresh chart add) — was started then reverted to keep the branch green; redo
  with tests.

When done: add tests for the new save flow's pure parts, then re-smoke on a live chart.
