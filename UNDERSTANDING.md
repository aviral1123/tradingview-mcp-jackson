# Understanding Session — tradingview-mcp-jackson

Running checklist. ✅ = you've demonstrated you get it, 🔲 = not yet.

## Stage 1 — What this project IS (the base + the foundational fix) ✅ MASTERED
- ✅ 1.1 It's a fork of Lewis Jackson's TradingView MCP server (Zero One Systems community)
- ✅ 1.2 What an MCP server is and why a chart needs one
- ✅ 1.3 The CDP bridge: Claude ↔ MCP (stdio) ↔ CDP :9222 ↔ TradingView Desktop (Electron)
- ✅ 1.4 The `localhost` → `127.0.0.1` bug (IPv6 ::1 vs IPv4) — why nothing worked until this fix

## Stage 2 — Your strategy layer (rules.json) ✅ MASTERED
- ✅ 2.1 The 50-name AI watchlist + daily timeframe
- ✅ 2.2 The 4 indicators (EMA20, EMA50, RSI14, ATR14) and what each does
- ✅ 2.3 Bias / entry / exit / risk rules + bias≠trigger distinction
- ✅ 2.4 Why it's framed "advisory only"

## Stage 3 — The brief pipeline (the payoff you built) ✅ MASTERED
- ✅ 3.1 notify.js — channel-agnostic sender (Telegram → Gmail → terminal)
- ✅ 3.2 daily_brief.mjs — the clever bits (one shared connection, compute-from-bars, freshness check)
- ✅ 3.3 analyze.mjs / render_chart.mjs — single-ticker deep read + layout-independent chart PNG
- ✅ 3.4 The launchd schedule (Mon–Fri 8:45am) — currently loaded & verified

## Stage 4 — The contradiction you should know about (scalper-run.js) ✅ MASTERED
- ✅ 4.1 scalper-run.js is a REAL live trading bot (BitGet, XRP/USDT, market orders) — placed 1 real order 2026-04-07
- ✅ 4.2 It contradicts the "advisory only / never trades" framing everywhere else
- ✅ 4.3 Current safety state: BitGet keys NOT in .env, but code + trade log are present
- ✅ 4.4 The two-meanings-of-"CDP" trap (Chrome DevTools Protocol vs Coinbase Developer Platform)

## Stage 5 — Current state & what matters ✅ MASTERED
- ✅ 5.1 Inversion: all advisory work is UNCOMMITTED; only base repo + live scalper are in git history
- ✅ 5.2 Only the launchd 8:45am brief runs; nothing trades on a schedule
- ✅ 5.3 Secrets clean (.env never committed, token not in history); priority = commit advisory work, then resolve scalper

---
## ✅ SESSION COMPLETE — all 5 stages mastered (2026-06-14)

### Punch list (priority order)
1. Commit the advisory work (127.0.0.1 fix, rules.json, scripts/*, plist) — currently one `rm` from gone.
2. Decide scalper-run.js fate: delete, or isolate + relabel, and fix docs that claim "never trades".
3. Cosmetic: fix "BTC Scalper" label (trades XRP) + Coinbase-vs-BitGet / two-meanings-of-CDP confusion.
4. Hygiene: keep Telegram bot token out of screenshots/pastes; revoke via @BotFather /revoke if leaked.
