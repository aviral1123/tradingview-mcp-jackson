# indicators/ — the build scaffold

Each indicator is a self-contained folder. The runner `scripts/pine_build.mjs` injects it
into the live TradingView Pine editor, compiles it, and (optionally) saves it to your account.
**Adding an indicator never touches the runner.**

## The contract

Every indicator is a sub-folder with exactly two files:

```
indicators/
  <indicator-name>/
    spec.md       # human-readable: what it shows, inputs+defaults, pane, verify-symbol
    source.pine   # the Pine v6 source — the versioned source of truth
```

`<indicator-name>` is kebab-case, no spaces. It maps directly to the build command.

## How to add a new indicator

1. `mkdir indicators/<new-name>`
2. Write `indicators/<new-name>/source.pine` — Pine v6 (`//@version=6`, an `indicator(...)`
   declaration, adjustable `input.*` for any tunable). Build it incrementally — one feature,
   compile, eyeball, next.
3. Write `indicators/<new-name>/spec.md` from the pattern in the existing folders.
4. Compile + render it:
   ```
   node scripts/pine_build.mjs <new-name> --symbol <SYMBOL>
   ```
5. Happy with it? Save it to TradingView:
   ```
   node scripts/pine_build.mjs <new-name> --symbol <SYMBOL> --save
   ```

That's it. The runner resolved `indicators/<new-name>/source.pine` by convention — no code changed.

## Runner flags

| flag | effect |
|---|---|
| `--symbol <SYM>` | switch the chart to `<SYM>` before injecting (e.g. `NASDAQ:NVDA`) |
| `--save` | save to your TradingView account as `AT · <indicator title>` |
| `--screenshot` | capture to `screenshots/pine_build_<name>_<timestamp>.png` |
| `--dry` | print the planned steps and exit — opens no connection (works with TradingView closed) |

## Current indicators

- **bias-stack** — equities overlay that draws `rules.json` bias logic. Verify on `NASDAQ:NVDA`.
- **zct-oi-filter** — the article's open-interest momentum filter. Verify on `BINANCE:BTCUSDT.P`.

## Rules

- Advisory only. These build and save **indicators**. Nothing here trades or touches an exchange.
- `source.pine` is the source of truth (versioned in git). TradingView "My Scripts" is the saved output.
