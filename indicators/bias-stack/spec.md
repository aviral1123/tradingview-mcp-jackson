# Bias Stack

**What it shows:** your `rules.json` bias logic, drawn on the price chart. The daily brief
tells you the bias in text; this shows the same logic visually.

- **Pane:** overlay (on price)
- **Plots:** 20 EMA (blue), 50 EMA (orange)
- **Background shading:**
  - green  = `close > 50EMA AND 20EMA > 50EMA AND RSI > 50`  (bullish stack)
  - red    = `close < 50EMA AND 20EMA < 50EMA AND RSI < 50`  (bearish stack)
  - none   = mixed / neutral
- **Marker:** ▲ below the bar where RSI crosses **up** through 50 (the entry trigger)

**Inputs (adjustable from the gear icon):**
| input | default |
|---|---|
| EMA fast | 20 |
| EMA slow | 50 |
| RSI length | 14 |

**Verify on:** any liquid equity — `NASDAQ:NVDA`, `NASDAQ:AMD`. Background should match what
`daily_brief.mjs` reports for that name.

**Build / save:**
```
node scripts/pine_build.mjs bias-stack --symbol NASDAQ:NVDA
node scripts/pine_build.mjs bias-stack --symbol NASDAQ:NVDA --save
```
