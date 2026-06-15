# ZCT OI Filter

The article's open-interest momentum indicator. Included as the **second** instance to
prove the scaffold is generic — it was added with zero changes to `scripts/pine_build.mjs`.

- **Pane:** separate (below price)
- **Plots:** dollar-denominated open interest (yellow), 60-EMA (blue), 240-EMA (green)
- **Fill:** between the two EMAs — green when fast > slow, red when fast < slow, ~85% transparency

**Inputs (adjustable):**
| input | default |
|---|---|
| Fast EMA | 60 |
| Slow EMA | 240 |

**Requires open interest.** `_OI` data exists on crypto perps / futures, NOT on US equities.
On a no-OI symbol the OI plot is `na` (blank), not an error.

**Verify on:** `BINANCE:BTCUSDT.P`.

**Build / save:**
```
node scripts/pine_build.mjs zct-oi-filter --symbol BINANCE:BTCUSDT.P
node scripts/pine_build.mjs zct-oi-filter --symbol BINANCE:BTCUSDT.P --save
```
