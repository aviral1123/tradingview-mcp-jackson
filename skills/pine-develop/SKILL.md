---
name: pine-develop
description: Full Pine Script development loop — write code, compile, fix errors, iterate. Use when building a new indicator or strategy in TradingView.
---

# Pine Script Development Loop

You are developing a Pine Script indicator or strategy in TradingView. Follow this loop precisely.

## Step 1: Understand the Goal

If not already clear, ask the user:
- What type? (indicator, strategy, library)
- What does it do? (entry/exit logic, overlay, oscillator, etc.)
- Overlay or separate pane?
- Any specific inputs or visual elements?

## Step 2: Pull Current Source (if modifying)

Indicators live in `indicators/<name>/source.pine` — read that directly.
To read whatever is currently loaded in the live TradingView Pine editor instead, use the
`pine_get_source` MCP tool (or `node src/cli/index.js pine get`).

If creating new: make `indicators/<name>/` with a `source.pine` + `spec.md`
(see `indicators/README.md` for the contract).

## Step 3: Write the Pine Script

Write the complete script to `indicators/<name>/source.pine`. Every script MUST include:
- `//@version=6` header
- Proper `indicator()` or `strategy()` declaration
- All user inputs with `input.*()` functions and groups
- Clear comments for each logical section

For strategies, include:
- `strategy.entry()` and `strategy.exit()` calls
- Position sizing via `strategy()` declaration
- Default commission and slippage settings

## Step 4: Build and Compile

```bash
node scripts/pine_build.mjs <name>
```

This injects `indicators/<name>/source.pine` into the Pine Editor, compiles, and reports any
errors. Add `--symbol <SYM>` to switch the chart first; `--save` to save to your account.

## Step 5: Fix Errors

If errors are reported:
1. Read the error messages (line number + description)
2. Edit `indicators/<name>/source.pine` — fix the specific lines
3. Build again: `node scripts/pine_build.mjs <name>`
4. Repeat until 0 errors

Common Pine Script errors:
- **"Mismatched input"** — usually indentation (Pine uses 4-space indentation, not braces)
- **"Could not find function or function reference"** — typo in function name or wrong version
- **"Undeclared identifier"** — variable used before declaration
- **"Cannot call X with argument type Y"** — wrong parameter type

## Step 6: Verify on Chart

After clean compilation:
1. `capture_screenshot` — take a screenshot to verify it looks right
2. `data_get_strategy_results` — if it's a strategy, check performance
3. Show the user the results

## Step 7: Iterate

If the user wants changes:
1. Edit `indicators/<name>/source.pine`
2. Build + compile: `node scripts/pine_build.mjs <name> --screenshot`
3. Check the screenshot to verify

IMPORTANT: Always compile after every change. Never claim "done" without a clean compile.
