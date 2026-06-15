# Generic Pine Script Indicator Build Scaffold (instances: Bias Stack + ZCT OI Filter)

> Source idea: the Koroush AK / @Tradesdontlie article "How to Use Claude to Build TradingView Indicators."
> We already did the article's Part 1 (Claude ↔ TradingView over CDP). This plan builds the article's
> Part 2/3 — authoring, compiling, iterating, and permanently saving custom Pine indicators — but as a
> **reusable scaffold**, not a one-off, so new indicators are a folder-drop rather than a rewrite.

## Problem
The article's actual deliverable — building a custom Pine Script indicator with Claude, compiling it, iterating, and saving it permanently — was never built. There are **zero `.pine` files** in the repo and no reusable way to produce one. What exists is partial and partly broken: a freeform `pine-develop` skill, the MCP `pine_*` tools (good), and two helper scripts `scripts/pine_push.js` / `scripts/pine_pull.js` that **hardcode `localhost:9222`** — the same IPv6/IPv4 bug already fixed in `src/`, so they likely fail on this Mac. There is no declarative "define an indicator once, regenerate/save it" path, so every indicator would be hand-built from scratch through chat. The article's own example (OI momentum) also doesn't apply to the user's actual watchlist: open interest does not exist on US equities (NVDA, AMD, …).

## Users
Just the owner (Aviral), personal use. Single-machine (macOS), TradingView Desktop Premium, advisory-only workflow. No external/team consumers. Secondary "user" is future-Aviral adding more indicators without touching the plumbing.

## Success criteria
One week after shipping:
- `node scripts/pine_build.mjs bias-stack --symbol NASDAQ:NVDA --save` injects, compiles clean (0 errors), and the indicator is saved in TradingView "My Scripts" — repeatable, not a one-time manual dance.
- "Bias Stack" renders on equities and visually matches `daily_brief.mjs` logic (background green when the bullish stack holds, red when bearish, ▲ where RSI crosses 50).
- Adding the **second** indicator (ZCT OI filter) required **only** a new `indicators/<name>/` folder + a `--symbol BINANCE:BTCUSDT.P` run — **zero edits to `pine_build.mjs`**. (This is the proof the scaffold is generic, not just asserted.)
- The legacy `localhost`-bug scripts are gone and nothing references them.

## Acceptance criteria
- [ ] `indicators/` directory exists with `README.md` documenting the "add an indicator" contract (folder = `spec.md` + `source.pine`).
- [ ] `indicators/bias-stack/source.pine` is Pine v6, `overlay=true`, with adjustable `input.int` for emaFast(20)/emaSlow(50)/rsiLen(14), plots EMA20+EMA50, `bgcolor` shaded by the bias rule (`close>e50 and e20>e50 and rsi>50` → bull; inverse → bear; else neutral), and a `plotshape` triangle on `ta.crossover(rsi,50)`.
- [ ] `indicators/bias-stack/spec.md` records: what it shows, inputs+defaults, pane (overlay), verify-symbols.
- [ ] `scripts/pine_build.mjs <name>` resolves `indicators/<name>/source.pine`, opens the Pine editor, sets source, compiles via the connector's own `src/core/pine.js`, and prints any errors as `line: message`; exits non-zero on compile errors.
- [ ] The runner reuses `src/core/pine.js`, `src/core/chart.js`, `src/connection.js` on a single CDP connection (the `daily_brief.mjs` pattern) and uses `127.0.0.1` — it does **not** use `chrome-remote-interface` or hardcode `localhost`.
- [ ] Flags work: `--symbol <SYM>` switches symbol first; `--save` saves to TV account; `--screenshot` captures to `screenshots/pine_build_<name>_<ISO-timestamp>.png`; `--dry` prints intended actions without touching TV (no CDP connection opened).
- [ ] Saved-script names carry the `AT · ` namespace prefix (on-chart `indicator()` title stays clean, e.g. "Bias Stack").
- [ ] `indicators/zct-oi-filter/` exists and builds clean on `BINANCE:BTCUSDT.P` (OI line × close, 60/240 EMAs, shaded fill 85% transparency, adjustable lengths) **with no change to `pine_build.mjs`**.
- [ ] `scripts/pine_push.js` and `scripts/pine_pull.js` are deleted and `skills/pine-develop/SKILL.md` points at `pine_build.mjs` (+ `pine_get_source` for pulling current editor source).
- [ ] Tests pass (see below): runner unit tests, source lint, offline `pine.check()` returns `compiled: true` for each `source.pine`, and the advisory-only guard.

### Test list (for downstream TDD)
- Unit: arg parser maps `<name>`/`--symbol`/`--save`/`--screenshot`/`--dry` correctly; unknown indicator name → clear error, non-zero exit; name→path resolution rejects path traversal (`../`).
- Source lint (per `indicators/*/source.pine`): contains `//@version=6`, an `indicator(` declaration, at least one `input.` (adjustable), and (bias-stack only) the bias condition + `ta.crossover`.
- Offline compile: feed each `source.pine` through `src/core/pine.js` `check()` (REST call to `pine-facade.tradingview.com/pine-facade/translate_light` — runs the actual Pine compiler, no live TV session required) → assert `compiled: true`, `error_count: 0`. Do NOT use `analyze()` for this test — `analyze()` only checks array bounds and will report 0 errors even for scripts with nonexistent Pine v6 functions.
- Advisory-only guard: assert `scripts/pine_build.mjs` imports no exchange/trade modules and contains no `place-order`/`bitget`/`createHmac` references.
- Manual smoke (documented, needs live TV): build bias-stack on NVDA, eyeball shading + trigger marker, `--save`, confirm it appears in My Scripts; repeat for zct-oi-filter on BTCUSDT.P.

## Non-goals
- Not doing: a Pine code generator / declarative DSL (the "spec → emitted Pine" approach was explicitly rejected — `source.pine` is hand-written, the spec is human docs).
- Not doing: any trading, order placement, or exchange API interaction. This builds and saves indicators only. The advisory-only guard test enforces it.
- Not doing: `strategy()` scripts, backtesting, or `data_get_strategy_results` — these are read-only `indicator()` overlays/panes.
- Not doing: an auto-fix/LLM-in-the-loop compiler — the compile→fix loop is the human/Claude editing `source.pine` and re-running, incrementally (one feature per step, per the article).
- Not doing: a rewrite of the `pine-develop` skill — only a repoint of its script references.
- Not doing: multi-machine / cloud / scheduled indicator builds — local, on-demand, single machine.

## Architecture sketch
```
indicators/
  README.md                # the "add an indicator" contract (never changes)
  bias-stack/
    spec.md                # human-readable spec
    source.pine            # Pine v6 source of truth (versioned in git)
  zct-oi-filter/
    spec.md
    source.pine
scripts/
  pine_build.mjs           # NEW runner — reuses src/core/{pine,chart}.js + src/connection.js
  pine_push.js  (DELETE)   # legacy, localhost bug
  pine_pull.js  (DELETE)   # legacy, redundant with pine_get_source
skills/pine-develop/SKILL.md   # EDIT: repoint to pine_build.mjs
```
Data flow (mirrors `daily_brief.mjs`): `pine_build.mjs` opens one CDP connection via `src/connection.js` (127.0.0.1), then for `--symbol`: uses the same `setSymbolFast` workaround as `daily_brief.mjs` (direct `chart.setSymbol()` + `setTimeout(400)`) because `chart.setSymbol`'s built-in `waitForChartReady()` compares `EXCHANGE:TICKER` against a DOM legend that shows only the ticker — it always times out (10s); do NOT use `chart.setSymbol` directly. Then `pine.ensurePineEditorOpen` → `pine.setSource(source.pine)` → `pine.smartCompile()` → `pine.getErrors()`; on `--save` → fill the script-name input field in the first-save dialog (see Risks) then `pine.save()`; on `--screenshot` → `capture`. `--dry` must not open a CDP connection at all — it should resolve the indicator path and print the planned sequence, then exit 0. No new state; `source.pine` files are the source of truth, TradingView "My Scripts" is the saved output. Build incrementally per the article (EMAs → bias → shade → trigger → inputs → save), compiling/eyeballing each step.

## Risks & unknowns
- **Pine v6 API correctness** — the offline `check()` REST call validates syntax and Pine v6 API names (e.g., `ta.ema`, `bgcolor`, `plotshape`) without a live TV session. But `request.security(...,"_OI")` symbol-resolution errors only surface at runtime on a live chart. Mitigation: `check()` catches the bulk of API errors; live smoke on the correct symbol catches the rest; build one feature at a time.
- **`pine_save` first-save name injection** — `pine.save()` dispatches Ctrl+S and clicks a "Save" button in any visible dialog. But for a brand-new script that has never been saved to TradingView, the first-save dialog includes a name text input field. The runner must: (1) before calling `pine.save()`, locate the name input via `document.querySelector('input[data-name="script-name"], input[placeholder*="name"], .dialog input[type="text"]')` and set its value to `AT · <title>`; (2) then dispatch Ctrl+S (or click the dialog's Save button). Without this step, `--save` will either hang waiting for user input or save under TradingView's auto-generated name. Mitigation: implement a `saveTo(name)` helper in the runner that pre-fills the dialog input before delegating to `pine.save()`. Git history shows a prior "Fix pine_save dialog handling" commit — consult it before implementing.
- **Injection preconditions** — Pine editor must be open and the chart in a true single-chart layout (the connector's multi-chart paths are unreliable, per `analyze.mjs`). Runner should ensure the editor is open and surface a clear message if layout is multi-chart.
- **OI symbol availability** — `_OI` needs a perp/futures symbol; on a no-OI symbol the ZCT plot is `na` (blank), not an error — the smoke step must verify on `BINANCE:BTCUSDT.P` specifically.
- **Deleting legacy scripts** — safe (recoverable via git), but must grep the repo for references first (skill, README, docs) and repoint them so nothing breaks.

## Open questions
- Saved-name convention: `AT · <title>` chosen — confirm the separator/prefix renders acceptably in TradingView's save dialog and My Scripts list.
- `pine.smartCompile()` error reporting: verified by inspection of `src/core/pine.js` — `smartCompile()` reads Monaco markers via the same `getModelMarkers()` path as `getErrors()`, so it reports errors correctly for `indicator()` scripts. No fallback to `compile()` + `getErrors()` needed.
- Should `indicators/README.md` include a copy-paste "new indicator" checklist, or is the folder convention self-evident? (Lean: include the checklist — it's the extensibility contract.)
