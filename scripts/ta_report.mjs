#!/usr/bin/env node
/**
 * ta_report.mjs — render the agentic-ta analysis into a Bloomberg-terminal-style
 * HTML report, and upsert a committed coverage dashboard.
 *
 * Input: a JSON "report payload" file (path as argv[0]). Schema:
 * {
 *   symbol, benchmark, price, date?(ISO),
 *   stance: "one-line stance",
 *   verdict: "BUY" | "WATCHLIST" | "AVOID",
 *   stage: "Stage 2 (early)",                       // optional short tag
 *   scorecard: [ { lens, rating: "PASS"|"WARN"|"FAIL", text } x4 ],
 *   engine: { ...full output of ta_minervini.mjs... },
 *   levels: { resistance:[{level,note}], support:[{level,note}] },
 *   watch: "pullback level to stalk", invalidation: "level that breaks thesis",
 *   flips: ["condition 1", ...],                    // what would make it a buy
 *   catalyst: { bullets:["..."], sources:[{title,url,date}] }
 * }
 *
 * Output:
 *   reports/<SYMBOL>-<YYYY-MM-DD>.html   (the single-ticker terminal report)
 *   reports/index.json                   (ledger — one row per symbol, latest wins)
 *   reports/index.html                   (the committed coverage dashboard)
 *
 * Usage: node scripts/ta_report.mjs /tmp/crwv_payload.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = path.join(ROOT, 'reports');
const LEDGER = path.join(REPORTS, 'index.json');

const payloadPath = process.argv[2];
if (!payloadPath) { console.error('usage: node scripts/ta_report.mjs <payload.json>'); process.exit(1); }
const P = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

fs.mkdirSync(REPORTS, { recursive: true });

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const today = (P.date ? new Date(P.date) : new Date());
const isoDate = today.toISOString().slice(0, 10);
const stamp = today.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const symU = String(P.symbol).toUpperCase().replace(/[^A-Z0-9:._-]/g, '');
const reportFile = `${symU.replace(/[^A-Z0-9]/g, '_')}-${isoDate}.html`;

// ---------- shared terminal CSS ----------
const CSS = `
:root{--bg:#07090c;--panel:#0d1117;--panel2:#0a0e13;--line:#1c2530;--grid:#161d27;
--amber:#f7a600;--amber2:#ffc24b;--txt:#d6deeb;--dim:#7d8a9c;--up:#19d27e;--down:#ff4d4f;--warn:#f7a600;--cyan:#34d3eb;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
font:13px/1.5 "SF Mono",ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;
-webkit-font-smoothing:antialiased;letter-spacing:.2px}
a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px 56px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;
border-bottom:2px solid var(--amber);padding:10px 16px;background:linear-gradient(180deg,#0d1117,#080b0f);
position:sticky;top:0;z-index:5}
.brand{color:var(--amber);font-weight:700;letter-spacing:2px}
.brand .sub{color:var(--dim);font-weight:400;letter-spacing:1px;margin-left:8px}
.tape{color:var(--dim);font-size:12px}
.tape b{color:var(--txt)}
.px{font-size:20px;font-weight:700}
.sec{margin:22px 0 8px;color:var(--amber);font-size:11px;font-weight:700;letter-spacing:2.5px;
text-transform:uppercase;border-bottom:1px solid var(--line);padding-bottom:6px;display:flex;justify-content:space-between}
.sec .meta{color:var(--dim);font-weight:400;letter-spacing:1px}
.grid{display:grid;gap:10px}
.g2{grid-template-columns:1fr 1fr}.g4{grid-template-columns:repeat(4,1fr)}
@media(max-width:760px){.g2,.g4{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:12px 14px}
.kv{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dotted var(--grid)}
.kv:last-child{border-bottom:0}.kv .k{color:var(--dim)}.kv .v{color:var(--txt);font-variant-numeric:tabular-nums;text-align:right}
.up{color:var(--up)}.down{color:var(--down)}.warn{color:var(--warn)}.amber{color:var(--amber)}
.stance{background:linear-gradient(90deg,rgba(247,166,0,.10),rgba(247,166,0,0));border-left:3px solid var(--amber);
padding:12px 16px;margin:14px 0;font-size:14px;color:var(--amber2)}
.chip{display:inline-block;padding:2px 9px;border-radius:3px;font-weight:700;font-size:11px;letter-spacing:1.5px}
.chip.BUY{background:rgba(25,210,126,.16);color:var(--up);border:1px solid rgba(25,210,126,.5)}
.chip.WATCHLIST{background:rgba(247,166,0,.16);color:var(--amber);border:1px solid rgba(247,166,0,.5)}
.chip.AVOID{background:rgba(255,77,79,.16);color:var(--down);border:1px solid rgba(255,77,79,.5)}
.card{background:var(--panel);border:1px solid var(--line);border-top:2px solid var(--rt,#666);border-radius:3px;padding:11px 13px}
.card .lens{color:var(--dim);font-size:11px;letter-spacing:1.5px;text-transform:uppercase}
.card .rate{font-weight:700;letter-spacing:1px;margin:4px 0 6px}
.card .txt{color:var(--txt);font-size:12.5px}
.rt-PASS{--rt:var(--up)}.rt-WARN{--rt:var(--amber)}.rt-FAIL{--rt:var(--down)}
.rate.PASS{color:var(--up)}.rate.WARN{color:var(--amber)}.rate.FAIL{color:var(--down)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--grid)}
th{color:var(--dim);font-weight:600;font-size:11px;letter-spacing:1px;text-transform:uppercase}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
tr:hover td{background:#0b1118}
.crit td:first-child{color:var(--dim)}
.bul{margin:0;padding-left:18px}.bul li{margin:4px 0}
.lvl{font-variant-numeric:tabular-nums}
.foot{color:var(--dim);font-size:11px;margin-top:26px;border-top:1px solid var(--line);padding-top:10px}
.src a{display:inline-block;margin:0 10px 6px 0}
.flips li{color:var(--up)}
`;

// ---------- single-ticker report ----------
function num(n, d = 2) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(d); }
function signCls(n) { return n == null ? '' : (n > 0 ? 'up' : n < 0 ? 'down' : ''); }
function pctStr(n) { return n == null ? '—' : (n > 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }

function critRows(tt) {
  const labels = {
    c1_price_above_150_200: 'Price &gt; 150-day &amp; 200-day MA',
    c2_150_above_200: '150-day MA &gt; 200-day MA',
    c3_200_trending_up: '200-day MA trending up',
    c4_50_above_150_200: '50-day &gt; 150 &amp; 200-day MA',
    c5_price_above_50: 'Price &gt; 50-day MA',
    c6_30pct_above_low: 'Price ≥30% above 52-wk low',
    c7_within_25pct_of_high: 'Price within 25% of 52-wk high',
  };
  const c = tt.criteria || {};
  let rows = Object.keys(labels).map((k, i) =>
    `<tr class="crit"><td>${i + 1}</td><td>${labels[k]}</td><td class="r ${c[k] ? 'up' : 'down'}">${c[k] ? 'PASS' : 'FAIL'}</td></tr>`).join('');
  rows += `<tr class="crit"><td>8</td><td>RS Rating ≥70 vs market</td><td class="r warn">SEE RS</td></tr>`;
  return rows;
}

function reportHtml() {
  const e = P.engine || {}, tt = e.trend_template || {}, m = e.momentum || {}, rs = e.relative_strength || {}, v = e.volume || {};
  const chg = m.chg_1d;
  const scards = (P.scorecard || []).map((s) =>
    `<div class="card rt-${s.rating}"><div class="lens">${esc(s.lens)}</div><div class="rate ${s.rating}">${s.rating === 'PASS' ? '✓ ' : s.rating === 'FAIL' ? '✕ ' : '⚠ '}${s.rating}</div><div class="txt">${esc(s.text)}</div></div>`).join('');
  const resRows = (P.levels?.resistance || []).map((l) => `<div class="kv"><span class="k down">R · ${esc(l.note)}</span><span class="v lvl">${num(l.level)}</span></div>`).join('');
  const supRows = (P.levels?.support || []).map((l) => `<div class="kv"><span class="k up">S · ${esc(l.note)}</span><span class="v lvl">${num(l.level)}</span></div>`).join('');
  const flips = (P.flips || []).map((f) => `<li>${esc(f)}</li>`).join('');
  const cat = (P.catalyst?.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('');
  const src = (P.catalyst?.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank">${esc(s.title)}${s.date ? ' · ' + esc(s.date) : ''}</a>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(symU)} — TV Terminal Technicals</title><style>${CSS}</style></head><body>
<div class="topbar">
  <div class="brand">TV·TERMINAL<span class="sub">EQUITY TECHNICALS</span></div>
  <div class="tape">${esc(symU)} <b>${num(P.price ?? e.price)}</b> <span class="${signCls(chg)}">${pctStr(chg)}</span>
   &nbsp;·&nbsp; vs <b>${esc(P.benchmark || rs.benchmark || 'SPY')}</b> &nbsp;·&nbsp; ${esc(stamp)}</div>
</div>
<div class="wrap">
  <div class="sec" style="margin-top:18px">Verdict <span class="meta">${esc(P.stage || '')}</span></div>
  <div><span class="chip ${esc(P.verdict)}">${esc(P.verdict)}</span></div>
  <div class="stance">${esc(P.stance)}</div>

  <div class="sec">Four-Lens Scorecard</div>
  <div class="grid g4">${scards}</div>

  <div class="sec">Trend Template <span class="meta">${esc(tt.verdict || '')}</span></div>
  <div class="grid g2">
    <div class="panel"><table><thead><tr><th>#</th><th>Criterion (Minervini)</th><th class="r">State</th></tr></thead><tbody>${critRows(tt)}</tbody></table></div>
    <div class="panel">
      <div class="kv"><span class="k">SMA 50 / 150 / 200</span><span class="v">${num(tt.sma50)} / ${num(tt.sma150)} / ${num(tt.sma200)}</span></div>
      <div class="kv"><span class="k">52-week range</span><span class="v">${num(tt.low_52w)} – ${num(tt.high_52w)}</span></div>
      <div class="kv"><span class="k">Above 52-wk low</span><span class="v up">${pctStr(tt.pct_above_52w_low)}</span></div>
      <div class="kv"><span class="k">Below 52-wk high</span><span class="v down">−${num(tt.pct_below_52w_high,1)}%</span></div>
      <div class="kv"><span class="k">200-day rising</span><span class="v ${tt.sma200_trending_up?'up':'down'}">${tt.sma200_trending_up?'YES':'NO'}</span></div>
      <div class="kv"><span class="k">MA stacked 50&gt;150&gt;200</span><span class="v ${tt.ma_stacked_50_150_200?'up':'down'}">${tt.ma_stacked_50_150_200?'YES':'NO'}</span></div>
      <div class="kv"><span class="k">RSI(14) / ATR(14)</span><span class="v">${num(m.rsi14)} / ${num(m.atr14)} (${num(m.atr_pct,1)}%)</span></div>
      <div class="kv"><span class="k">Chg 1d / 5d / 20d</span><span class="v"><span class="${signCls(m.chg_1d)}">${pctStr(m.chg_1d)}</span> · <span class="${signCls(m.chg_5d)}">${pctStr(m.chg_5d)}</span> · <span class="${signCls(m.chg_20d)}">${pctStr(m.chg_20d)}</span></span></div>
    </div>
  </div>

  <div class="sec">Relative Strength <span class="meta">vs ${esc(rs.benchmark || P.benchmark || 'SPY')}</span></div>
  <div class="grid g2"><div class="panel">
    <div class="kv"><span class="k">Excess return 1m / 3m</span><span class="v"><span class="${signCls(rs.excess_return_1m)}">${pctStr(rs.excess_return_1m)}</span> · <span class="${signCls(rs.excess_return_3m)}">${pctStr(rs.excess_return_3m)}</span></span></div>
    <div class="kv"><span class="k">Excess return 6m / 12m</span><span class="v"><span class="${signCls(rs.excess_return_6m)}">${pctStr(rs.excess_return_6m)}</span> · <span class="${signCls(rs.excess_return_12m)}">${pctStr(rs.excess_return_12m)}</span></span></div>
    <div class="kv"><span class="k">RS line / % of 1y range</span><span class="v">${num(rs.rs_line,4)} · ${num(rs.rs_line_pct_of_1y_range,0)}%</span></div>
  </div><div class="panel">
    <div class="kv"><span class="k">RS line above own 50d</span><span class="v ${rs.rs_line_above_own_50d?'up':'down'}">${rs.rs_line_above_own_50d?'YES':'NO'} (Mansfield ${pctStr(rs.mansfield_pct)})</span></div>
    <div class="kv"><span class="k">RS line rising (21d)</span><span class="v ${rs.rs_line_rising_21d?'up':'down'}">${rs.rs_line_rising_21d?'YES':'NO'}</span></div>
    <div class="kv"><span class="k">Read</span><span class="v warn">${rs.rs_line_pct_of_1y_range!=null&&rs.rs_line_pct_of_1y_range<60?'RECOVERING, NOT LEADING':'LEADING'}</span></div>
  </div></div>

  <div class="sec">Volume / Accumulation</div>
  <div class="grid g2"><div class="panel">
    <div class="kv"><span class="k">50d avg volume</span><span class="v">${v.avg_vol_50d?(v.avg_vol_50d/1e6).toFixed(1)+'M':'—'}</span></div>
    <div class="kv"><span class="k">Last vol vs avg</span><span class="v ${v.last_vol_vs_avg>=1.2?'up':v.last_vol_vs_avg<0.8?'down':''}">${num(v.last_vol_vs_avg)}×</span></div>
    <div class="kv"><span class="k">Up/Down vol 25d / 50d</span><span class="v"><span class="${v.up_down_vol_25d>=1?'up':'down'}">${num(v.up_down_vol_25d)}</span> · <span class="${v.up_down_vol_50d>=1?'up':'down'}">${num(v.up_down_vol_50d)}</span></span></div>
    <div class="kv"><span class="k">Distribution days (25d)</span><span class="v ${v.distribution_days_25d>=5?'down':''}">${v.distribution_days_25d ?? '—'} ${v.distribution_days_25d>=5?'⚠ WARNING':''}</span></div>
  </div><div class="panel">
    <table><thead><tr><th>Last 8 bars</th><th class="r">Δ%</th><th class="r">Vol×avg</th></tr></thead><tbody>
    ${(v.recent_action_8d||[]).map(b=>`<tr><td class="r">${num(b.close)}</td><td class="r ${signCls(b.chg_pct)}">${pctStr(b.chg_pct)}</td><td class="r ${b.vol_vs_avg>=1.2?'up':b.vol_vs_avg<0.8?'down':''}">${num(b.vol_vs_avg)}×</td></tr>`).join('')}
    </tbody></table>
  </div></div>

  <div class="sec">Levels &amp; Game Plan</div>
  <div class="grid g2"><div class="panel">${resRows}${supRows}</div>
  <div class="panel">
    <div class="kv"><span class="k amber">Watch (stalk entry)</span><span class="v">${esc(P.watch||'—')}</span></div>
    <div class="kv"><span class="k down">Invalidation</span><span class="v">${esc(P.invalidation||'—')}</span></div>
    <div style="margin-top:8px;color:var(--dim);font-size:11px;letter-spacing:1px">WHAT FLIPS IT TO A BUY</div>
    <ul class="bul flips">${flips}</ul>
  </div></div>

  <div class="sec">Catalyst <span class="meta">Exa news scan</span></div>
  <div class="panel"><ul class="bul">${cat}</ul>
    <div class="src" style="margin-top:8px">${src}</div></div>

  <div class="foot">Generated ${esc(stamp)} by agentic-ta · computed from raw bars, not chart indicators · latest bar may be intraday/partial.<br>
  Technical / price-structure read only — <b>not financial advice.</b></div>
</div></body></html>`;
}

// ---------- coverage dashboard ----------
function dashboardHtml(rows) {
  const counts = rows.reduce((a, r) => (a[r.verdict] = (a[r.verdict] || 0) + 1, a), {});
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : -1));
  const trs = sorted.map((r) => `<tr>
    <td><a href="${esc(r.report)}">${esc(r.symbol)}</a></td>
    <td>${esc(r.date)}</td>
    <td class="r">${num(r.price)}</td>
    <td><span class="chip ${esc(r.verdict)}">${esc(r.verdict)}</span></td>
    <td>${esc(r.stage||'')}</td>
    <td class="r">${r.tt_score!=null?r.tt_score+'/7':'—'}</td>
    <td class="r ${signCls(r.rs_1m)}">${pctStr(r.rs_1m)}</td>
    <td class="r ${r.dist_days>=5?'down':''}">${r.dist_days ?? '—'}</td>
    <td style="color:var(--dim);max-width:340px">${esc(r.stance||'')}</td>
    <td><a href="${esc(r.report)}">view ▸</a></td>
  </tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TV Terminal — Coverage</title><style>${CSS}
.wrap{max-width:1280px}.stat{display:flex;gap:22px;margin:16px 0}
.stat .b{background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:10px 16px;min-width:96px}
.stat .n{font-size:22px;font-weight:700}.stat .l{color:var(--dim);font-size:11px;letter-spacing:1.5px}
</style></head><body>
<div class="topbar"><div class="brand">TV·TERMINAL<span class="sub">COVERAGE · WATCHLIST</span></div>
<div class="tape">${rows.length} symbol(s) tracked &nbsp;·&nbsp; updated ${esc(stamp)}</div></div>
<div class="wrap">
  <div class="stat">
    <div class="b"><div class="n">${rows.length}</div><div class="l">TRACKED</div></div>
    <div class="b"><div class="n up">${counts.BUY||0}</div><div class="l">BUY</div></div>
    <div class="b"><div class="n amber">${counts.WATCHLIST||0}</div><div class="l">WATCHLIST</div></div>
    <div class="b"><div class="n down">${counts.AVOID||0}</div><div class="l">AVOID</div></div>
  </div>
  <div class="sec">Coverage</div>
  <table><thead><tr>
    <th>Symbol</th><th>Last analyzed</th><th class="r">Price</th><th>Verdict</th><th>Stage</th>
    <th class="r">Trend Tmpl</th><th class="r">RS 1m</th><th class="r">Dist d</th><th>Stance</th><th>Report</th>
  </tr></thead><tbody>${trs}</tbody></table>
  <div class="foot">agentic-ta coverage ledger · technical reads only, not financial advice.</div>
</div></body></html>`;
}

// ---------- write report ----------
fs.writeFileSync(path.join(REPORTS, reportFile), reportHtml());

// ---------- upsert ledger + dashboard ----------
let ledger = [];
try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch {}
const e = P.engine || {};
const row = {
  symbol: symU, date: isoDate, price: P.price ?? e.price ?? null,
  verdict: P.verdict, stage: P.stage || '',
  tt_score: e.trend_template?.pass_count ?? null,
  rs_1m: e.relative_strength?.excess_return_1m ?? null,
  dist_days: e.volume?.distribution_days_25d ?? null,
  stance: P.stance || '', report: reportFile,
};
ledger = ledger.filter((r) => r.symbol !== symU);
ledger.push(row);
fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
fs.writeFileSync(path.join(REPORTS, 'index.html'), dashboardHtml(ledger));

console.log(JSON.stringify({ ok: true, report: 'reports/' + reportFile, dashboard: 'reports/index.html', tracked: ledger.length }, null, 2));
