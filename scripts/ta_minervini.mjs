#!/usr/bin/env node
/**
 * ta_minervini.mjs — multi-lens technical-analysis QUANT ENGINE for one ticker.
 *
 * Computes, FROM THE BARS (not the user's chart indicators):
 *   1. Minervini Trend Template  — SMA 50/150/200, 52-week range, the 7 price criteria
 *   2. Relative Strength vs a benchmark (default SPY) — excess return 1/3/6/12mo,
 *      RS line (ratio), % of its 1y range, Mansfield RS, RS-line rising?
 *   3. Volume / accumulation — 50d avg vol, up/down volume ratio, distribution days,
 *      the recent rally-leg bar-by-bar
 *   4. Momentum/context — RSI14, ATR14, % from SMA50, 1/5/20-day change
 *
 * WHY A SCRIPT (not MCP indicator calls): the TradingView MCP drives ONE live,
 * stateful chart. Doing the data pull + math here, in a single sequential process
 * that restores the chart at the end, avoids the multi-chart race you'd hit if
 * parallel subagents each called chart_set_symbol. It also returns COMPACT JSON,
 * so the 250-bar payloads never reach the agent's context.
 *
 * Usage:
 *   node scripts/ta_minervini.mjs NASDAQ:HOOD            # benchmark defaults to SPY
 *   node scripts/ta_minervini.mjs HOOD QQQ              # custom benchmark
 *
 * Output: a single JSON object on stdout. Advisory only — not financial advice.
 */

import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const esc = (s) => String(s).replace(/'/g, "\\'");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const sym = argv[0];
const benchSym = argv[1] || 'SPY';
if (!sym) { console.error('usage: node scripts/ta_minervini.mjs EXCHANGE:TICKER [BENCHMARK]'); process.exit(1); }

async function setSymbolFast(s) {
  await evaluateAsync(`(function(){var c=${CHART_API};return new Promise(function(r){c.setSymbol('${esc(s)}',{});setTimeout(r,400);});})()`);
}
async function setTfFast(tf) {
  await evaluate(`(function(){var c=${CHART_API};c.setResolution('${esc(tf)}',{});})()`);
}
// wait until bars are stable across two reads (loading finished)
async function getBars(count, deadlineMs = 9000) {
  const deadline = Date.now() + deadlineMs;
  let lastSig = null, last = [];
  while (Date.now() < deadline) {
    let bars = null;
    try { bars = (await data.getOhlcv({ count, summary: false })).bars; } catch {}
    if (bars && bars.length) {
      last = bars;
      const b = bars[bars.length - 1];
      const sig = `${b.time}:${b.close}`;
      if (sig === lastSig) return bars;
      lastSig = sig;
    }
    await sleep(220);
  }
  return last;
}

// ---- indicators (computed from bars) ----
const sma = (v, n) => (v.length < n ? null : v.slice(v.length - n).reduce((a, b) => a + b, 0) / n);
const smaAt = (v, n, back) => (v.length < n + back ? null : v.slice(v.length - n - back, v.length - back).reduce((a, b) => a + b, 0) / n);
function rsi(v, n = 14) { if (v.length < n + 1) return null; let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; } let ag = g / n, al = l / n; for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n; al = (al * (n - 1) + (d < 0 ? -d : 0)) / n; } return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
function atr(b, n = 14) { if (b.length < n + 1) return null; const tr = []; for (let i = 1; i < b.length; i++) { const pc = b[i - 1].close; tr.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - pc), Math.abs(b[i].low - pc))); } let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n; for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a; }
const pct = (a, b) => ((a - b) / b * 100);
const r2 = (n) => (n == null ? null : +n.toFixed(2));
const r1 = (n) => (n == null ? null : +n.toFixed(1));

async function main() {
  // remember the chart so we can restore it
  let orig = null, origTf = null;
  try { const st = await chart.getState(); orig = st.symbol; origTf = st.resolution; } catch {}

  // --- target daily bars ---
  await setSymbolFast(sym); await sleep(500); await setTfFast('D'); await sleep(300);
  const bars = await getBars(300);
  if (!bars.length) { try { await disconnect(); } catch {} console.error('no bars for ' + sym); process.exit(2); }
  const c = bars.map((b) => b.close);
  const vol = bars.map((b) => b.volume);
  const n = c.length;
  const px = c[n - 1];

  // --- benchmark daily bars (for relative strength) ---
  let bench = [];
  try { await setSymbolFast(benchSym); await sleep(500); bench = await getBars(300); } catch {}

  // restore chart immediately after data pull
  try { if (orig) { await setSymbolFast(orig); await sleep(400); } if (origTf) await setTfFast(origTf); } catch {}

  // ---- 1. Minervini Trend Template ----
  const s50 = sma(c, 50), s150 = sma(c, 150), s200 = sma(c, 200);
  const s200_20ago = smaAt(c, 200, 20), s150_20ago = smaAt(c, 150, 20);
  const win = Math.min(252, bars.length);
  const hi52 = Math.max(...bars.slice(bars.length - win).map((b) => b.high));
  const lo52 = Math.min(...bars.slice(bars.length - win).map((b) => b.low));
  const T = {
    c1_price_above_150_200: s150 != null && s200 != null && px > s150 && px > s200,
    c2_150_above_200: s150 != null && s200 != null && s150 > s200,
    c3_200_trending_up: s200 != null && s200_20ago != null && s200 > s200_20ago,
    c4_50_above_150_200: s50 != null && s150 != null && s200 != null && s50 > s150 && s50 > s200,
    c5_price_above_50: s50 != null && px > s50,
    c6_30pct_above_low: px >= lo52 * 1.3,
    c7_within_25pct_of_high: px >= hi52 * 0.75,
  };
  const passCount = Object.values(T).filter(Boolean).length;

  // ---- 2. Relative Strength vs benchmark ----
  let rs = null;
  if (bench.length > 20) {
    // align by timestamp
    const bMap = new Map(bench.map((b) => [b.time, b.close]));
    const tc = [], bc = [];
    for (const b of bars) { if (bMap.has(b.time)) { tc.push(b.close); bc.push(bMap.get(b.time)); } }
    const m = tc.length;
    if (m > 20) {
      const ratio = tc.map((v, i) => v / bc[i]);
      const rNow = ratio[m - 1];
      const rMax = Math.max(...ratio), rMin = Math.min(...ratio);
      const excess = (d) => (d < m ? r1((((tc[m - 1] / tc[m - 1 - d]) / (bc[m - 1] / bc[m - 1 - d])) - 1) * 100) : null);
      const rSma50 = ratio.length >= 50 ? ratio.slice(m - 50).reduce((a, b) => a + b, 0) / 50 : null;
      rs = {
        benchmark: benchSym,
        excess_return_1m: excess(21), excess_return_3m: excess(63),
        excess_return_6m: excess(126), excess_return_12m: excess(Math.min(252, m - 1)),
        rs_line: +rNow.toFixed(4),
        rs_line_pct_of_1y_range: rMax > rMin ? r1((rNow - rMin) / (rMax - rMin) * 100) : null,
        rs_line_above_own_50d: rSma50 != null ? rNow > rSma50 : null,
        mansfield_pct: rSma50 != null ? r1((rNow / rSma50 - 1) * 100) : null,
        rs_line_rising_21d: m > 22 ? rNow > ratio[m - 22] : null,
      };
    }
  }

  // ---- 3. Volume / accumulation ----
  const avg50 = vol.length >= 50 ? vol.slice(n - 50).reduce((a, b) => a + b, 0) / 50 : null;
  const udv = (days) => { let up = 0, dn = 0; for (let i = Math.max(1, n - days); i < n; i++) { if (c[i] >= c[i - 1]) up += vol[i]; else dn += vol[i]; } return dn ? +(up / dn).toFixed(2) : null; };
  let dist = 0; for (let i = Math.max(1, n - 25); i < n; i++) { if (c[i] < c[i - 1] * 0.998 && vol[i] > vol[i - 1]) dist++; }
  // recent action: last 8 bars with per-bar change and volume vs the 50d average
  // (shows whether the recent thrust has real volume behind it — accumulation footprint)
  const recentAction = [];
  for (let i = Math.max(1, n - 8); i < n; i++) {
    recentAction.push({ close: r2(c[i]), chg_pct: r1(pct(c[i], c[i - 1])), vol_vs_avg: avg50 ? r2(vol[i] / avg50) : null });
  }

  const out = {
    symbol: sym, benchmark: benchSym, price: r2(px), bars_available: bars.length,
    note: 'Latest bar may be intraday/incomplete — treat its volume as partial.',
    trend_template: {
      sma50: r2(s50), sma150: r2(s150), sma200: r2(s200),
      high_52w: r2(hi52), low_52w: r2(lo52),
      pct_above_52w_low: r1(pct(px, lo52)), pct_below_52w_high: r1((hi52 - px) / hi52 * 100),
      sma200_trending_up: T.c3_200_trending_up, ma_stacked_50_150_200: T.c4_50_above_150_200,
      criteria: T, pass_count: passCount, total_criteria: 7,
      verdict: passCount === 7 ? 'PASS (Stage 2 candidate)' : `FAIL (${passCount}/7) — not a Minervini buy per template`,
    },
    momentum: {
      rsi14: r2(rsi(c, 14)), atr14: r2(atr(bars, 14)),
      atr_pct: r1(atr(bars, 14) / px * 100),
      pct_above_sma50: s50 ? r1(pct(px, s50)) : null,
      chg_1d: r1(pct(px, c[n - 2])), chg_5d: n > 6 ? r1(pct(px, c[n - 6])) : null, chg_20d: n > 21 ? r1(pct(px, c[n - 21])) : null,
    },
    relative_strength: rs,
    volume: {
      avg_vol_50d: avg50 ? Math.round(avg50) : null, last_vol: vol[n - 1],
      last_vol_vs_avg: avg50 ? r2(vol[n - 1] / avg50) : null,
      up_down_vol_25d: udv(25), up_down_vol_50d: udv(50),
      distribution_days_25d: dist,
      recent_action_8d: recentAction,
    },
  };
  console.log(JSON.stringify(out, null, 2));
}

let code = 0;
try { await main(); } catch (e) { console.error('ta_minervini failed:', e.message); code = 1; }
finally { try { await disconnect(); } catch {} process.exit(code); }
