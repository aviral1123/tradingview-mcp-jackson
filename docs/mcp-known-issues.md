# MCP Known Issues / Follow-ups

Running log of TradingView MCP limitations found in real use. Each entry: symptom, repro, root-cause hypothesis, proposed fix.

---

## 1. Cannot set `length` (or other inputs) on built-in studies added via `chart_manage_indicator`

**Found:** 2026-06-17, during Minervini Trend Template analysis on HOOD (needed 50/150/200-day SMAs).

**Symptom:**
Adding the built-in **"Moving Average"** study and then trying to change its period has no effect. All three MA instances (intended 50/150/200) report the identical default 9-day value (`MA: 91.72`).

**Repro:**
1. `chart_manage_indicator` add `"Moving Average"` with `inputs: '{"length": 50}'`
   → study added, but the `inputs` override at add-time is **ignored** (stays 9-day default).
2. `indicator_set_inputs` on the returned `entity_id` with `'{"length": 50}'`
   → returns `success: true` but `updated_inputs: {}` (empty — nothing actually changed).
3. `data_get_study_values` → MA still 9-day default.
4. `data_get_indicator` on the entity → `"inputs": []` (the study exposes **no** input descriptors at all).

**Root-cause hypothesis:**
The built-in "Moving Average" study object surfaced through CDP has an empty/unreadable `inputs` metainfo, so:
- the server can't map the friendly key `"length"` to the real input id (likely something like `in_0` / `length` on the study's `_metaInfo.inputs`), and
- `indicator_set_inputs` silently no-ops because it finds no matching input id (hence `updated_inputs: {}`).

Likely the server reads inputs from the wrong place, or this particular study variant ("Moving Average" simple) stores its inputs differently than the ones that DO work. Note: **RSI and ATR added the same way returned correct values** (RSI 70.75, ATR 6.62) — so the add path works; it's specifically input introspection/override on this MA study that fails.

**Impact:**
Can't use the MCP to produce multi-period SMAs (50/150/200), the backbone of stage analysis / Minervini Trend Template. Worked around by pulling raw `data_get_ohlcv` bars and computing the averages locally — same TradingView data, just averaged client-side.

**Proposed fix (to investigate later):**
- Inspect the real study `_metaInfo.inputs` for the built-in MA via `ui_evaluate` to find the actual input id.
- Fix `indicator_set_inputs` to resolve friendly names (`length`, `source`) → real input ids, and to **fail loudly** (return the unmatched keys) instead of returning `success: true` with `updated_inputs: {}`.
- Make `data_get_indicator` populate `inputs` for built-in studies (currently `[]`).
- Verify `chart_manage_indicator`'s add-time `inputs` argument is actually applied.
- Add a regression test: add MA length=50, assert read-back value ≠ 9-day value.
