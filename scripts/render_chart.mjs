#!/usr/bin/env node
/**
 * render_chart.mjs — render an annotated daily candlestick chart from DATA,
 * with ZERO dependency on the TradingView chart layout. It reads OHLCV via the
 * data layer (which works even when the live canvas is frozen), draws a
 * self-contained SVG (candles + EMA20/50 + support/resistance + anchored VWAP),
 * and rasterises it to PNG via headless Google Chrome. Optionally sends to Telegram.
 *
 * This exists because the connector's multi-chart screenshot path is unreliable
 * (frozen panes, scrambled indexing). This path is layout-independent.
 *
 * Usage:
 *   node scripts/render_chart.mjs NASDAQ:LRCX            # write PNG
 *   node scripts/render_chart.mjs NASDAQ:LRCX --send     # + send to Telegram
 */

import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NOTIFY = path.join(__dirname, 'notify.js');
const SHOTS = path.join(ROOT, 'screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const esc = (s) => String(s).replace(/'/g, "\\'");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const SEND = argv.includes('--send');
const sym = argv.find((a) => !a.startsWith('--'));
if (!sym) { console.error('usage: node scripts/render_chart.mjs EXCHANGE:TICKER [--send]'); process.exit(1); }

async function setSymbolFast(s) {
  await evaluateAsync(`(function(){var c=${CHART_API};return new Promise(function(r){c.setSymbol('${esc(s)}',{});setTimeout(r,400);});})()`);
}
async function setTfFast(tf) { await evaluate(`(function(){var c=${CHART_API};c.setResolution('${esc(tf)}',{});})()`); }

// ---- indicators ----
function emaSeries(v, n) {
  const out = new Array(v.length).fill(null); if (v.length < n) return out;
  const k = 2 / (n + 1); let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; out[n - 1] = e;
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; } return out;
}
function atr(b, n = 14) { if (b.length < n + 1) return null; const tr = []; for (let i = 1; i < b.length; i++) { const pc = b[i - 1].close; tr.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - pc), Math.abs(b[i].low - pc))); } let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n; for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a; }
function swings(bars, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < bars.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) { if (bars[j].high > bars[i].high) isH = false; if (bars[j].low < bars[i].low) isL = false; }
    if (isH) hi.push({ price: bars[i].high, i }); if (isL) lo.push({ price: bars[i].low, i });
  }
  return { hi, lo };
}
function cluster(levels, tol) { const out = []; for (const L of levels.sort((a, b) => b.i - a.i)) if (!out.some((o) => Math.abs(o.price - L.price) / L.price < tol)) out.push(L); return out; }
function avwap(bars, a0) { let pv = 0, vv = 0; for (let i = a0; i < bars.length; i++) { const tp = (bars[i].high + bars[i].low + bars[i].close) / 3; pv += tp * bars[i].volume; vv += bars[i].volume; } return vv ? pv / vv : null; }

function buildSVG(symbol, bars, opts) {
  const W = 1240, H = 680, padL = 12, padR = 84, padT = 38, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const N = Math.min(opts.visible || 130, bars.length);
  const vb = bars.slice(-N);
  const closes = bars.map((b) => b.close);
  const e20 = emaSeries(closes, 20).slice(-N);
  const e50 = emaSeries(closes, 50).slice(-N);

  const levelPrices = [...opts.res, ...opts.sup, opts.avwap].filter((x) => x != null);
  let lo = Math.min(...vb.map((b) => b.low), ...levelPrices);
  let hi = Math.max(...vb.map((b) => b.high), ...levelPrices);
  const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
  const y = (p) => padT + plotH * (1 - (p - lo) / (hi - lo));
  const barW = plotW / N;
  const xc = (i) => padL + i * barW + barW / 2;
  const bw = Math.max(1.2, barW * 0.6);
  const fmt = (p) => p.toFixed(2);

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Roboto,sans-serif">`;
  s += `<rect width="${W}" height="${H}" fill="#0b0f17"/>`;
  // horizontal gridlines + price axis
  const gridN = 6;
  for (let g = 0; g <= gridN; g++) {
    const p = lo + (hi - lo) * (g / gridN); const yy = y(p);
    s += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="#1b2330" stroke-width="1"/>`;
    s += `<text x="${padL + plotW + 6}" y="${(yy + 4).toFixed(1)}" fill="#6b7280" font-size="12">${fmt(p)}</text>`;
  }
  // candles
  for (let i = 0; i < vb.length; i++) {
    const b = vb[i]; const up = b.close >= b.open; const col = up ? '#26a69a' : '#ef5350';
    const x = xc(i);
    s += `<line x1="${x.toFixed(1)}" y1="${y(b.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(b.low).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const yo = y(b.open), ycl = y(b.close); const top = Math.min(yo, ycl); const hgt = Math.max(1, Math.abs(yo - ycl));
    s += `<rect x="${(x - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"/>`;
  }
  // EMA polylines
  const poly = (arr, col) => {
    const pts = arr.map((v, i) => (v == null ? null : `${xc(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" opacity="0.9"/>`;
  };
  s += poly(e20, '#f59e0b') + poly(e50, '#3b82f6');
  // level lines + labels
  const levelLine = (p, col, dash, label) => {
    const yy = y(p);
    s += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${col}" stroke-width="${dash ? 1 : 2}"${dash ? ' stroke-dasharray="6 4"' : ''} opacity="0.95"/>`;
    s += `<rect x="${padL + plotW}" y="${(yy - 9).toFixed(1)}" width="${padR}" height="18" fill="${col}"/>`;
    s += `<text x="${padL + plotW + 4}" y="${(yy + 4).toFixed(1)}" fill="#0b0f17" font-size="12" font-weight="700">${fmt(p)}</text>`;
    if (label) s += `<text x="${padL + 8}" y="${(yy - 5).toFixed(1)}" fill="${col}" font-size="13" font-weight="700">${label}</text>`;
  };
  opts.res.forEach((p, i) => levelLine(p, '#ef4444', i !== 0, i === 0 ? `R ${fmt(p)}` : ''));
  opts.sup.forEach((p, i) => levelLine(p, '#10b981', i !== 0, i === 0 ? `S ${fmt(p)}` : ''));
  if (opts.avwap != null) levelLine(opts.avwap, '#a855f7', true, `AVWAP ${fmt(opts.avwap)}`);
  // title
  const last = bars[bars.length - 1];
  const chg = ((last.close - bars[bars.length - 2].close) / bars[bars.length - 2].close * 100);
  s += `<text x="${padL}" y="24" fill="#e5e7eb" font-size="17" font-weight="700">${symbol.replace(/^[A-Z]+:/, '')}  ·  D  ·  ${fmt(last.close)}  <tspan fill="${chg >= 0 ? '#26a69a' : '#ef5350'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</tspan></text>`;
  s += `<text x="${padL + 360}" y="24" fill="#f59e0b" font-size="12">EMA20</text><text x="${padL + 415}" y="24" fill="#3b82f6" font-size="12">EMA50</text>`;
  s += `</svg>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#0b0f17}</style></head><body>${s}</body></html>`;
}

async function main() {
  let orig = null, origTf = null;
  try { const st = await chart.getState(); orig = st.symbol; origTf = st.resolution; } catch {}
  // data read only (works even if the live canvas is frozen); restore after
  await setSymbolFast(sym); await setTfFast('D'); await sleep(1100);
  let bars = [];
  try { bars = (await data.getOhlcv({ count: 220, summary: false })).bars || []; } catch {}
  try { if (orig) { await setSymbolFast(orig); if (origTf) await setTfFast(origTf); } } catch {}
  if (bars.length < 60) { console.error(`only ${bars.length} bars for ${sym}`); return 1; }

  const px = bars[bars.length - 1].close;
  const sw = swings(bars, 3);
  const res = cluster(sw.hi.filter((s) => s.price > px), 0.02).sort((a, b) => a.price - b.price).slice(0, 3).map((r) => r.price);
  const sup = cluster(sw.lo.filter((s) => s.price < px), 0.02).sort((a, b) => b.price - a.price).slice(0, 3).map((s) => s.price);
  const recent = bars.slice(-60);
  const a0 = bars.length - 60 + recent.reduce((mi, b, i, arr) => (b.low < arr[mi].low ? i : mi), 0);
  const av = avwap(bars, Math.max(0, a0));
  // if price is at highs there may be no swing resistance — use the 20-day high
  if (!res.length) res.push(Math.max(...bars.slice(-20).map((b) => b.high)));

  const html = buildSVG(sym, bars, { res, sup, avwap: av, visible: 130 });
  const safe = sym.replace(/[^A-Za-z0-9]/g, '_');
  const htmlPath = path.join(SHOTS, `render-${safe}.html`);
  const pngPath = path.join(SHOTS, `render-${safe}.png`);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(htmlPath, html);
  try { fs.rmSync(pngPath, { force: true }); } catch {}

  const r = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    '--user-data-dir=/tmp/tv-render-profile', `--screenshot=${pngPath}`, '--window-size=1240,680',
    `file://${htmlPath}`,
  ], { encoding: 'utf8', timeout: 60000 });

  if (!fs.existsSync(pngPath)) { console.error('Chrome render failed:', (r.stderr || '').slice(-300)); return 1; }
  console.log(`[rendered] ${pngPath}`);

  if (SEND) {
    execFileSync(process.execPath, [NOTIFY, '--photo', pngPath, `📊 *${sym.replace(/^[A-Z]+:/, '')}* — daily (self-rendered: candles, EMA20/50, levels)`], { encoding: 'utf8' });
    console.log('[sent to Telegram]');
  }
  return 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error('render failed:', e.message); }
finally { try { await disconnect(); } catch {} }
process.exit(code);
