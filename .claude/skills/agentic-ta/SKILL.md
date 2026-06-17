---
name: agentic-ta
description: Deep, multi-lens technical analysis of one ticker — Minervini Trend Template + relative strength vs benchmark + volume/accumulation + the news catalyst — computed from raw bars (NOT the user's chart indicators) and fanned out to subagents. Use when the user asks to "do technical analysis", "analyze <TICKER>", "what does Minervini say about X", or wants a rigorous, opinionated read rather than a quick glance. For a light annotate-and-screenshot pass use chart-analysis instead; for screening many tickers use multi-symbol-scan.
---

# Agentic Technical Analysis

Produce a rigorous, multi-angle read on ONE ticker, judged on its own merits — independent of whatever indicators the user happens to have on their chart.

## Architecture (why it's built this way)

Two hard lessons are baked in — respect them:

1. **The TradingView MCP drives ONE live, stateful chart.** If two workers call `chart_set_symbol` at once they stomp each other (a relative-strength worker flips to SPY while the trend worker still expects the target). So **all chart-bound data + math happens in a single sequential script**, `scripts/ta_minervini.mjs`, which pulls bars for the ticker *and* the benchmark, computes everything, and restores the chart. Subagents then reason over its **compact JSON** — they never touch the chart.
2. **Don't add indicators to the chart to read values.** The built-in "Moving Average" study added via MCP ignores length overrides (`indicator_set_inputs` returns `updated_inputs: {}`) — see `docs/mcp-known-issues.md`. The engine computes SMAs from bars instead. Do not try to set MA lengths via the MCP.

Flow: **gather once (`ta_minervini.mjs`) → fan out interpretation (3 subagents in parallel, catalyst uses Exa) → synthesize (you) → render Bloomberg-style HTML + update committed dashboard (`ta_report.mjs`).**

## Step 1 — Inputs

- **Symbol:** accept a bare ticker (`HOOD`) or `EXCHANGE:TICKER` (`NASDAQ:HOOD`). The engine resolves bare tickers fine.
- **Benchmark for relative strength:** default `SPY`. Use `QQQ` for big-cap tech, or a sector ETF if the user names one.
- If the user gave neither, just use the ticker they named and SPY.

## Step 2 — Run the quant engine (single sequential process)

```
node scripts/ta_minervini.mjs <SYMBOL> [BENCHMARK]
```

It prints ONE compact JSON object: `trend_template` (SMA 50/150/200, 52w range, the 7 Minervini criteria + verdict), `momentum` (RSI14, ATR14, % from SMA50, 1/5/20-day change), `relative_strength` (excess return 1/3/6/12mo, RS line, % of 1y range, Mansfield, rising?), and `volume` (50d avg, up/down volume 25/50d, distribution days, last-8-bars action).

- The engine restores the chart on its own — **no cleanup needed**, and do not switch symbols yourself.
- The latest bar may be intraday/incomplete — treat its volume as partial (the JSON says so). Flag this in the writeup.
- If it errors (no bars / TV not running), run `tv_health_check`; if down, tell the user to launch TradingView and stop.

## Step 3 — Fan out interpretation (3 subagents, one message, parallel)

Spawn these together. **Paste the relevant JSON slice into each prompt.** Instruct every subagent: *"Do NOT call any TradingView MCP tool or change the chart — reason only from the JSON provided."* (The catalyst worker is the exception — it uses web search, still no chart.)

1. **Minervini lens** — give it `trend_template` + `momentum`. Ask for: the 8-criterion Trend Template table with PASS/FAIL each (criterion 8 = RS rating, note it's covered by the RS worker), the **stage** read (Stage 1/2/3/4 via MA structure + slope), and whether this is a proper base/VCP breakout or an extended/counter-trend move. Verdict: buy / watchlist / avoid, with the Minervini reasoning.
2. **RS + volume lens** — give it `relative_strength` + `volume`. Ask: is the move genuine relative strength vs the benchmark or just riding the market? Is the RS line leading (new highs) or merely recovering? Is volume showing accumulation (up/down ratio >1, thrust bars on >120% volume) or distribution (≥5 distribution days)? Call out the incomplete-last-bar caveat.
3. **Catalyst** — web research worker using **Exa**. It must `ToolSearch` for and use `mcp__claude_ai_Exa__web_search_exa` (and `web_fetch_exa` for the few highest-value links). **Hard budget: at most 3 `web_search_exa` calls, reading up to ~30 results total** across them (~10 per search) — do not exceed it. Ask: *why* is the stock moving recently — earnings, guidance, analyst actions, product/regulatory news, sector/flows (e.g. index inclusion)? Durable/fundamental or a one-off squeeze? Return a short summary **with dated source links**, and whether price sits above/below recent analyst targets.

## Step 4 — Synthesize (you, in the main thread)

Combine the three returns into one report:

- **One-line stance** up top (e.g. "strong company, real catalyst, poor entry today — stalk, don't chase").
- **Four-angle scorecard**: Trend Template / Relative Strength / Volume / Catalyst, each PASS/WARN/FAIL with a one-clause reason.
- **Concrete levels** — support/resistance and the specific pullback level to watch for an entry; the invalidation level.
- **What would change the verdict** — the conditions under which it becomes a buy (e.g. base forms, 200-day turns up, RS line new highs).
- Resolve disagreements honestly: the Trend Template can say "wrong stage / avoid" while RS + accumulation + catalyst say "early Stage-2 setup brewing." That tension *is* the insight — surface it, don't average it away.
- Give the user this synthesis in chat, AND proceed to Step 5 to persist it.

## Step 5 — Emit the HTML report + update the coverage dashboard

Assemble a **report payload JSON** (write it to a temp file, e.g. `/tmp/<sym>_payload.json`) and render it:

```
node scripts/ta_report.mjs /tmp/<sym>_payload.json
```

This writes a Bloomberg-terminal-style report to `reports/<SYMBOL>-<DATE>.html` and **upserts the committed dashboard** `reports/index.html` (+ ledger `reports/index.json`) — one row per symbol, latest analysis wins, with verdict, trend-template score, RS, distribution days, and stance.

Payload schema (fill prose from your synthesis, structured data from the engine JSON verbatim):
```
{ symbol, benchmark, price, stance, verdict: "BUY"|"WATCHLIST"|"AVOID", stage,
  scorecard: [ {lens, rating:"PASS"|"WARN"|"FAIL", text} x4 ],   // the 4 lenses
  engine: <paste the ta_minervini.mjs JSON unchanged>,
  levels: { resistance:[{level,note}], support:[{level,note}] },
  watch, invalidation, flips:[...],
  catalyst: { bullets:[...], sources:[{title,url,date}] } }            // from the Exa worker
```

Then `SendUserFile` the new `reports/<SYMBOL>-<DATE>.html` (and `reports/index.html` on first run or when asked) so the user can open them. The `reports/` dir is committed — mention they can `git add reports/` when they want it tracked. Do NOT auto-commit.

## Scope notes

- This is single-ticker depth. To screen many names, use `multi-symbol-scan` (and consider running the engine per-ticker in a loop, or a Workflow for parallel structure).
- Keep raw bar data out of the main thread — that's the engine's job. If you find yourself pasting 200-bar OHLCV dumps into context, stop and use the engine.
