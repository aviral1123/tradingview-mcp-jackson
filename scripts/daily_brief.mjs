#!/usr/bin/env node
/**
 * daily_brief.mjs — deterministic daily watchlist brief.
 *
 * Reads rules.json, walks the watchlist on a SINGLE shared CDP connection
 * (imports the connector's own core modules — one connection for all 50 names,
 * which is ~6x faster than spawning a `tv` subprocess per symbol, especially
 * under launchd), computes the four strategy indicators (EMA20, EMA50, RSI14,
 * ATR14) FROM THE BARS — so it never touches the data-window's single-EMA quirk —
 * applies the bias/entry rules mechanically, and sends a digest via notify.js.
 *
 * Advisory only: reads charts and reports what YOUR rules say. Never trades.
 *
 * Usage:
 *   node scripts/daily_brief.mjs           # compute + send via notify.js
 *   node scripts/daily_brief.mjs --dry     # compute + print, do NOT send
 *   node scripts/daily_brief.mjs --limit 8 # only first 8 watchlist names (testing)
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';

// We bypass chart.setSymbol/setTimeframe on purpose: their waitForChartReady()
// compares the full "EXCHANGE:TICKER" against a DOM legend that shows only the
// ticker, so the match never succeeds and it burns the full 10s timeout on every
// call. We set the symbol directly and use our own (correct) readiness check below.
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const esc = (s) => String(s).replace(/'/g, "\\'");
async function setSymbolFast(symbol) {
  await evaluateAsync(`(function(){var c=${CHART_API};return new Promise(function(r){c.setSymbol('${esc(symbol)}',{});setTimeout(r,400);});})()`);
}
async function setTimeframeFast(tf) {
  await evaluate(`(function(){var c=${CHART_API};c.setResolution('${esc(tf)}',{});})()`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NOTIFY = path.join(__dirname, 'notify.js');
const NODE = process.execPath;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const limitIdx = argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);

// Correct readiness check: poll the bars until the last bar is STABLE across two
// reads (loading finished) AND its close differs from the previous symbol's close
// (so we never compute on the prior symbol's stale bars). Returns the fresh bars.
async function waitBars(prevClose, deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  let lastSig = null, lastBars = [];
  while (Date.now() < deadline) {
    let bars = null;
    try { bars = (await data.getOhlcv({ count: 200, summary: false })).bars; } catch { /* still loading */ }
    if (bars && bars.length >= 51) {
      lastBars = bars;
      const last = bars[bars.length - 1];
      const sig = `${last.time}:${last.close}`;
      const fresh = prevClose == null || last.close !== prevClose;
      if (fresh && sig === lastSig) return bars; // stable + not stale-previous
      lastSig = sig;
    }
    await sleep(220);
  }
  return lastBars; // best effort on timeout (rare; e.g. new close == prev close)
}

function notify(text) {
  try { execFileSync(NODE, [NOTIFY], { input: text, encoding: 'utf8' }); } catch { /* best effort */ }
}

// ---- indicator math (validated against TradingView to the cent) ----
function ema(vals, len) {
  if (vals.length < len) return null;
  const k = 2 / (len + 1);
  let e = vals.slice(0, len).reduce((a, b) => a + b, 0) / len; // SMA seed
  for (let i = len; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
function rsi(vals, len = 14) {
  if (vals.length < len + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = vals[i] - vals[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / len, al = l / len;
  for (let i = len + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    ag = (ag * (len - 1) + (d > 0 ? d : 0)) / len;
    al = (al * (len - 1) + (d < 0 ? -d : 0)) / len;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function atr(bars, len = 14) {
  if (bars.length < len + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  let a = tr.slice(0, len).reduce((x, y) => x + y, 0) / len;
  for (let i = len; i < tr.length; i++) a = (a * (len - 1) + tr[i]) / len;
  return a;
}

// ---- load rules + watchlist ----
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
const watchlist = rules.watchlist.slice(0, LIMIT);
const TF = rules.default_timeframe || 'D';
const f2 = (n) => (n == null ? 'NA' : n.toFixed(2));

async function main() {
  // preflight: is TradingView Desktop reachable over CDP?
  let originalSymbol = null, originalTf = null;
  try {
    const st = await withTimeout(chart.getState(), 12000, 'CDP preflight');
    originalSymbol = st.symbol;
    originalTf = st.resolution;
  } catch (e) {
    const text = `⚠️ Daily brief skipped — TradingView Desktop is not reachable (is the app open with the debug port?).\n(${String(e.message || e).slice(0, 80)})`;
    if (DRY) console.log(text); else notify(text);
    return 1;
  }

  // make sure we're on the strategy timeframe (symbol switches preserve it, so set once)
  try { await setTimeframeFast(TF); await sleep(700); } catch { /* ignore */ }

  // seed the freshness check with the chart's current last close
  let prevClose = null;
  try { const b = (await data.getOhlcv({ count: 2 })).bars; prevClose = b[b.length - 1].close; } catch { /* ignore */ }

  const rows = [];
  const failed = [];
  for (const sym of watchlist) {
    const short = sym.replace(/^[A-Z]+:/, '');
    try {
      await setSymbolFast(sym);
      const bars = await waitBars(prevClose);
      if (bars.length < 51) { failed.push(`${short} (only ${bars.length} bars)`); continue; }
      const closes = bars.map((b) => b.close);
      const px = closes[closes.length - 1];
      prevClose = px; // chart is now on this symbol — next freshness check compares to it
      const e20 = ema(closes, 20), e50 = ema(closes, 50), r = rsi(closes, 14), a = atr(bars, 14);
      if ([px, e20, e50, r, a].some((v) => v == null)) { failed.push(short); continue; }

      let bias;
      if (px > e50 && e20 > e50 && r > 50) bias = 'BULLISH';
      else if (px < e50 && e20 < e50 && r < 50) bias = 'BEARISH';
      else if (px < e50 && r < 50) bias = 'bearish-unconfirmed';
      else if (px > e50 && r > 50) bias = 'bullish-unconfirmed';
      else bias = 'NEUTRAL';

      rows.push({
        short, px, e20, e50, rsi: r, atr: a, bias,
        strength: (px - e50) / e50,
        nearTrigger: Math.abs(r - 50) <= 3,
        overbought: r > 70, oversold: r < 30,
      });
    } catch (e) {
      failed.push(`${short} (${String(e.message || e).slice(0, 40)})`);
    }
  }

  // restore the chart (settle before the process exits so the CDP command flushes)
  if (originalSymbol) {
    try {
      if (originalTf) await setTimeframeFast(originalTf);
      await setSymbolFast(originalSymbol);
      await sleep(800);
    } catch { /* ignore */ }
  }

  // ---- build digest ----
  const bull = rows.filter((x) => x.bias === 'BULLISH').sort((a, b) => b.strength - a.strength);
  const bear = rows.filter((x) => x.bias === 'BEARISH').sort((a, b) => a.strength - b.strength);
  const trans = rows.filter((x) => x.bias === 'bearish-unconfirmed' || x.bias === 'bullish-unconfirmed');
  const near = rows.filter((x) => x.nearTrigger);
  const N = 6;

  const line = (x) => `• ${x.short} — ${f2(x.px)} | 20:${f2(x.e20)} 50:${f2(x.e50)} | RSI ${x.rsi.toFixed(1)}` +
    (x.overbought ? ' (overbought)' : x.oversold ? ' (oversold)' : '');

  const today = new Date().toISOString().slice(0, 10);
  let msg = `🗞️ *Daily Brief — ${today}* (${rows.length} names, your rules)\n\n`;
  msg += `*TONE:* ${bull.length} bullish · ${bear.length} bearish · ${rows.length - bull.length - bear.length} mixed/neutral\n\n`;
  msg += `*✅ BULLISH — full stack (price > 20 EMA > 50 EMA, RSI > 50):*\n`;
  msg += (bull.length ? bull.slice(0, N).map(line).join('\n') : '• none') + '\n\n';
  msg += `*🔻 BEARISH — full structure (price < 50 EMA, 20 EMA < 50 EMA, RSI < 50):*\n`;
  msg += (bear.length ? bear.slice(0, N).map(line).join('\n') : '• none') + '\n\n';
  if (trans.length) {
    msg += `*⚠️ TRANSITIONING (momentum one way, EMAs not yet crossed — not a confirmed signal):*\n`;
    msg += trans.map((x) => `• ${x.short} (${x.bias.startsWith('bear') ? 'bearish' : 'bullish'} momentum)`).join('\n') + '\n\n';
  }
  msg += `*🎯 NEAR THE TRIGGER (RSI within 3 of 50 — closest to a fresh entry):*\n`;
  msg += (near.length ? near.map((x) => `• ${x.short} — RSI ${x.rsi.toFixed(1)}, px ${x.px > x.e50 ? 'above' : 'below'} 50 EMA`).join('\n') : '• none') + '\n\n';
  msg += `*Reminder:* a clear bias is NOT a fresh entry. Your trigger is RSI crossing 50 — leaders already past it are mid-trend (overbought = extended). Watch the "near the trigger" names for new signals.\n`;
  if (failed.length) msg += `\n_Skipped: ${failed.join(', ')}_\n`;
  msg += `\n_Advisory only — YOUR rules vs live data, not financial advice. You place every trade._`;

  if (DRY) {
    console.log(msg);
    console.log(`\n[dry-run — not sent. ${rows.length} read, ${failed.length} skipped]`);
  } else {
    execFileSync(NODE, [NOTIFY], { input: msg, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
    console.log(`[brief sent — ${rows.length} read, ${failed.length} skipped]`);
  }
  return 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error('brief failed:', e.message); }
finally { try { await disconnect(); } catch { /* ignore */ } }
process.exit(code);
