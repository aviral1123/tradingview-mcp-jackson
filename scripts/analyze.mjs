#!/usr/bin/env node
/**
 * analyze.mjs — single-ticker technical analysis from the live TradingView chart.
 *
 * Reads daily / weekly / 1h bars on ONE shared CDP connection (no per-call
 * subprocess), computes everything FROM THE BARS (EMA 20/50/200, RSI14, ATR14,
 * swing support/resistance, anchored VWAP from the recent low, volume + range
 * stats), restores the chart, and prints a structured read. Advisory only.
 *
 * Usage:
 *   node scripts/analyze.mjs NASDAQ:ONDS              # print analysis (JSON)
 *   node scripts/analyze.mjs NASDAQ:ONDS --screenshot # + annotated chart PNG
 *   node scripts/analyze.mjs NASDAQ:ONDS --screenshot --send  # + send to Telegram
 *
 * --screenshot is SAFE BY DESIGN: it only annotates/captures when the chart is a
 * TRUE single-chart layout. On a multi-chart grid it refuses (with instructions)
 * rather than disturb your panes — the connector's multi-chart render/index
 * handling is unreliable. Switch TradingView to a single chart, then re-run.
 */

import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as pane from '../src/core/pane.js';
import * as drawing from '../src/core/drawing.js';
import * as capture from '../src/core/capture.js';
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const NOTIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.js');
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const esc = (s) => String(s).replace(/'/g, "\\'");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const SHOT = argv.includes('--screenshot');
const SEND = argv.includes('--send');
const sym = argv.find((a) => !a.startsWith('--'));
if (!sym) { console.error('usage: node scripts/analyze.mjs EXCHANGE:TICKER [--screenshot] [--send]'); process.exit(1); }

async function setSymbolFast(s) {
  await evaluateAsync(`(function(){var c=${CHART_API};return new Promise(function(r){c.setSymbol('${esc(s)}',{});setTimeout(r,400);});})()`);
}
async function setTfFast(tf) {
  await evaluate(`(function(){var c=${CHART_API};c.setResolution('${esc(tf)}',{});})()`);
}
// wait until bars are stable across two reads (loading finished)
async function getBars(count, deadlineMs = 8000) {
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

// ---- indicators ----
const ema = (v, n) => { if (v.length < n) return null; const k = 2 / (n + 1); let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; for (let i = n; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; };
function rsi(v, n = 14) { if (v.length < n + 1) return null; let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; } let ag = g / n, al = l / n; for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n; al = (al * (n - 1) + (d < 0 ? -d : 0)) / n; } return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
function atr(b, n = 14) { if (b.length < n + 1) return null; const tr = []; for (let i = 1; i < b.length; i++) { const pc = b[i - 1].close; tr.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - pc), Math.abs(b[i].low - pc))); } let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n; for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a; }
// swing pivots: bar i is a swing high if its high is the max within +/-k
function swings(bars, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < bars.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) { if (bars[j].high > bars[i].high) isH = false; if (bars[j].low < bars[i].low) isL = false; }
    if (isH) hi.push({ price: bars[i].high, i }); if (isL) lo.push({ price: bars[i].low, i });
  }
  return { hi, lo };
}
// cluster nearby levels (within tol%) keeping the most recent
function cluster(levels, tolPct) {
  const out = [];
  for (const L of levels.sort((a, b) => b.i - a.i)) {
    if (!out.some((o) => Math.abs(o.price - L.price) / L.price < tolPct)) out.push(L);
  }
  return out;
}
// anchored VWAP from anchor index to end (typical price * vol)
function avwap(bars, anchorIdx) {
  let pv = 0, vv = 0;
  for (let i = anchorIdx; i < bars.length; i++) { const tp = (bars[i].high + bars[i].low + bars[i].close) / 3; pv += tp * bars[i].volume; vv += bars[i].volume; }
  return vv ? pv / vv : null;
}
const pct = (a, b) => ((a - b) / b * 100);

async function readTf(tf, count) {
  await setTfFast(tf); await sleep(300);
  const bars = await getBars(count);
  const c = bars.map((b) => b.close);
  return { bars, c, e20: ema(c, 20), e50: ema(c, 50), e200: ema(c, 200), rsi: rsi(c, 14) };
}

async function main() {
  let orig = null, origTf = null;
  try { const st = await chart.getState(); orig = st.symbol; origTf = st.resolution; } catch {}
  await setSymbolFast(sym); await sleep(500);

  const D = await readTf('D', 300);
  const bars = D.bars;
  const last = bars[bars.length - 1];
  const px = last.close;
  const a = atr(bars, 14);

  // levels
  const sw = swings(bars, 3);
  const resAll = cluster(sw.hi.filter((s) => s.price > px), 0.02).sort((a, b) => a.price - b.price);
  const supAll = cluster(sw.lo.filter((s) => s.price < px), 0.02).sort((a, b) => b.price - a.price);
  const res = resAll.slice(0, 3), sup = supAll.slice(0, 3);
  const recent = bars.slice(-60);
  const lowIdx = bars.length - 60 + recent.reduce((mi, b, i, arr) => (b.low < arr[mi].low ? i : mi), 0);
  const vwapLow = avwap(bars, Math.max(0, lowIdx));
  const hi20 = Math.max(...bars.slice(-20).map((b) => b.high));
  const lo20 = Math.min(...bars.slice(-20).map((b) => b.low));
  const hi60 = Math.max(...bars.slice(-60).map((b) => b.high));
  const lo60 = Math.min(...bars.slice(-60).map((b) => b.low));
  const avgVol20 = bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20;

  const W = await readTf('W', 200);
  const H1 = await readTf('60', 300);

  // restore
  try { if (origTf) await setTfFast(origTf); if (orig) { await setSymbolFast(orig); await sleep(600); } } catch {}

  const f = (n) => (n == null ? 'NA' : n.toFixed(2));
  const out = {
    symbol: sym, price: px,
    daily: { ema20: f(D.e20), ema50: f(D.e50), ema200: f(D.e200), rsi14: f(D.rsi), atr14: f(a),
      pctFrom_ema50: f(pct(px, D.e50)) + '%', stop_2atr: f(px - 2 * a) + ' / ' + f(px + 2 * a),
      chg_1d: f(pct(px, bars[bars.length - 2].close)) + '%', chg_5d: f(pct(px, bars[bars.length - 6].close)) + '%', chg_20d: f(pct(px, bars[bars.length - 21].close)) + '%' },
    weekly: { ema20: f(W.e20), ema50: f(W.e50), rsi14: f(W.rsi) },
    hour1: { ema20: f(H1.e20), ema50: f(H1.e50), rsi14: f(H1.rsi) },
    levels: { resistance: res.map((r) => +r.price.toFixed(2)), support: sup.map((s) => +s.price.toFixed(2)),
      avwap_from_recent_low: f(vwapLow), hi20: +hi20.toFixed(2), lo20: +lo20.toFixed(2), hi60: +hi60.toFixed(2), lo60: +lo60.toFixed(2) },
    volume: { last: last.volume, avg20: Math.round(avgVol20), vs_avg: f(last.volume / avgVol20) + 'x' },
    bars_available: bars.length,
  };
  console.log(JSON.stringify(out, null, 2));

  if (SHOT) await screenshot(sym, out, orig, origTf);
}

// Annotated chart screenshot — SAFE BY DESIGN: only runs on a true single-chart
// layout, never touches a multi-chart grid (that path is unreliable in this
// connector). Draws the computed levels, captures, optionally sends, then fully
// restores the chart (removes its drawings + any indicators it added, resets symbol).
async function screenshot(symbol, out, orig, origTf) {
  let nPanes = 1;
  try { const pl = await pane.list(); nPanes = (pl.panes || []).length || pl.chart_count || 1; } catch {}
  if (nPanes > 1) {
    console.log(`\n[screenshot skipped] Detected ${nPanes} chart panes. To protect your grid, --screenshot only runs on a TRUE single-chart layout (one pane). On this connector a collapsed grid still keeps its panes, so switch to a layout that genuinely has one chart (e.g. a fresh single-chart tab), then re-run with --screenshot. Note: collapsing the grid view is not enough.`);
    if (SEND) { try { execFileSync(process.execPath, [NOTIFY], { input: telegramText(symbol, out), encoding: 'utf8' }); console.log('[analysis text sent to Telegram]'); } catch {} }
    return;
  }

  const drawn = [], added = [];
  try {
    await setSymbolFast(symbol); await setTfFast('D'); await sleep(1300);
    // anchor drawings to the live last-bar time so labels stay on-screen for any date
    let lastT = Math.floor(Date.now() / 1000);
    try { const b = (await data.getOhlcv({ count: 2 })).bars; lastT = b[b.length - 1].time; } catch {}
    const labelT = lastT - 20 * 86400;

    // add EMA 20/50 for context, but only if the chart isn't already carrying a pair
    try {
      const studies = (await chart.getState()).studies || [];
      if (studies.filter((s) => /Moving Average Exponential/.test(s.name)).length < 2) {
        for (const length of [20, 50]) {
          const r = await chart.manageIndicator({ action: 'add', indicator: 'Moving Average Exponential', inputs: JSON.stringify({ length }) });
          if (r && r.entity_id) added.push(r.entity_id);
        }
      }
    } catch {}

    const line = async (price, color, dashed) => {
      const r = await drawing.drawShape({ shape: 'horizontal_line', point: { time: lastT, price }, overrides: JSON.stringify({ linecolor: color, linewidth: dashed ? 1 : 2, ...(dashed ? { linestyle: 2 } : {}) }) });
      if (r && r.entity_id) drawn.push(r.entity_id);
    };
    const label = async (price, text, color) => {
      const r = await drawing.drawShape({ shape: 'text', point: { time: labelT, price }, text, overrides: JSON.stringify({ color, fontsize: 14, bold: true }) });
      if (r && r.entity_id) drawn.push(r.entity_id);
    };

    const L = out.levels;
    for (let i = 0; i < (L.resistance || []).length; i++) await line(L.resistance[i], '#ef4444', i !== 0);
    for (let i = 0; i < (L.support || []).length; i++) await line(L.support[i], '#10b981', i !== 0);
    if (L.resistance && L.resistance[0] != null) await label(L.resistance[0] * 1.012, `Resistance ${L.resistance[0]}`, '#ef4444');
    if (L.support && L.support[0] != null) await label(L.support[0] * 0.988, `Support ${L.support[0]}`, '#10b981');
    await sleep(900);

    const shot = await capture.captureScreenshot({ region: 'chart', filename: `analyze-${symbol.replace(/[^A-Za-z0-9]/g, '_')}` });
    console.log(`\n[screenshot] ${shot.file_path}`);
    if (SEND && shot.file_path) {
      execFileSync(process.execPath, [NOTIFY, '--photo', shot.file_path, `📊 *${symbol.replace(/^[A-Z]+:/, '')}* — daily, levels marked. Read below 👇`], { encoding: 'utf8' });
      execFileSync(process.execPath, [NOTIFY], { input: telegramText(symbol, out), encoding: 'utf8' });
      console.log('[sent chart + analysis to Telegram]');
    }
  } catch (e) {
    console.error('screenshot failed:', e.message);
  } finally {
    for (const id of drawn) { try { await drawing.removeOne({ entity_id: id }); } catch {} }
    for (const id of added) { try { await chart.manageIndicator({ action: 'remove', indicator: 'Moving Average Exponential', entity_id: id }); } catch {} }
    try { await setSymbolFast(orig); if (origTf) await setTfFast(origTf); await sleep(600); } catch {}
  }
}

function telegramText(symbol, out) {
  const d = out.daily, w = out.weekly, h = out.hour1, L = out.levels;
  return `📊 *${symbol.replace(/^[A-Z]+:/, '')}* — daily (your rules)
Price *${Number(out.price).toFixed(2)}*

*Trend:*
• Weekly: ema20 ${w.ema20} / ema50 ${w.ema50} (RSI ${w.rsi14})
• Daily: ema20 ${d.ema20} / ema50 ${d.ema50} / 200 ${d.ema200} (RSI ${d.rsi14})
• 1h: ema20 ${h.ema20} / ema50 ${h.ema50} (RSI ${h.rsi14})

*Levels:*
• Resistance: ${(L.resistance || []).join(' · ') || 'n/a'}
• Support: ${(L.support || []).join(' · ') || 'n/a'}
• Anchored VWAP (recent low): ${L.avwap_from_recent_low}
• 20-day range: ${L.lo20} - ${L.hi20}

*Risk:* ATR(14) ${d.atr14} · 2xATR stop band ${d.stop_2atr}
Changes: 1d ${d.chg_1d} · 5d ${d.chg_5d} · 20d ${d.chg_20d}

_Advisory only — your rules vs live data, not financial advice. You place every trade._`;
}

let code = 0;
try { await main(); } catch (e) { console.error('analyze failed:', e.message); code = 1; }
finally { try { await disconnect(); } catch {} }
process.exit(code);
