#!/usr/bin/env node
/**
 * pine_build.mjs — generic Pine Script indicator build runner.
 *
 * Reads indicators/<name>/source.pine, injects it into the live TradingView Pine
 * editor over ONE shared CDP connection (the daily_brief.mjs pattern — reuses the
 * connector's own src/core modules, so it gets the 127.0.0.1 fix for free), compiles,
 * reports errors, and can save the indicator to your TradingView account.
 *
 * Adding a new indicator = drop a new indicators/<name>/ folder (spec.md + source.pine).
 * The runner never changes. See indicators/README.md for the contract.
 *
 * Advisory only: this builds and saves indicators. It never trades or touches an exchange.
 *
 * Usage:
 *   node scripts/pine_build.mjs <name>                       # inject + compile + report
 *   node scripts/pine_build.mjs <name> --symbol NASDAQ:NVDA  # switch symbol first
 *   node scripts/pine_build.mjs <name> --save                # + save to TV account
 *   node scripts/pine_build.mjs <name> --screenshot          # + capture to screenshots/
 *   node scripts/pine_build.mjs <name> --dry                 # print plan, no CDP connection
 */

/**
 * Parse argv (everything after `node pine_build.mjs`) into an options object.
 * Pure — no I/O. Throws on malformed input so the caller controls exit behavior.
 */
export function parseArgs(argv) {
  const opts = { name: null, symbol: null, save: false, screenshot: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--symbol') {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) throw new Error('--symbol requires a value (e.g. --symbol NASDAQ:NVDA)');
      opts.symbol = v;
    } else if (a === '--save') {
      opts.save = true;
    } else if (a === '--screenshot') {
      opts.screenshot = true;
    } else if (a === '--dry') {
      opts.dry = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else if (opts.name == null) {
      opts.name = a;
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
  }
  if (opts.name == null) throw new Error('Missing indicator name. Usage: pine_build.mjs <name> [--symbol S] [--save] [--screenshot] [--dry]');
  return opts;
}

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '..');

/**
 * Resolve an indicator name to its source.pine path, rejecting any path traversal.
 * Does NOT check existence — that's the caller's job (so it can report a clean
 * "not found" with the resolved path). Throws before any I/O on an illegal name.
 */
export function resolveIndicatorPath(name, root = REPO_ROOT) {
  const indicatorsDir = path.join(root, 'indicators');
  const resolved = path.resolve(indicatorsDir, name, 'source.pine');
  if (resolved !== path.join(indicatorsDir, name, 'source.pine') ||
      !resolved.startsWith(indicatorsDir + path.sep)) {
    throw new Error(`Illegal indicator name (path traversal not allowed): ${name}`);
  }
  return resolved;
}

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

/** Pull the indicator() title out of the Pine source, for the saved-script name. */
export function indicatorTitle(source) {
  const m = source.match(/(?:indicator|strategy)\s*\(\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

/** The planned build steps, as plain strings — shared by --dry output and the live run. */
function planSteps(opts, srcPath, exists) {
  const steps = [];
  if (opts.symbol) steps.push(`set symbol → ${opts.symbol} (fast path, bypasses waitForChartReady)`);
  steps.push('create a fresh indicator script (never reuse/clobber what is open)');
  steps.push(`inject source from ${path.relative(REPO_ROOT, srcPath)}${exists ? '' : '  ⚠️ MISSING'}`);
  steps.push('compile + verify it was actually added to the chart');
  if (opts.save) steps.push('save to TradingView account (prefix "AT · ")');
  if (opts.screenshot) steps.push('capture screenshot → screenshots/');
  return steps;
}

/**
 * Decide the outcome of a smartCompile() result. Pure — unit-testable without CDP.
 * - compile errors        → not ok (report the markers)
 * - study_added === false → not ok (compiled but never reached the chart: a read-only/
 *                           published script was open, or the wrong button got clicked).
 *                           Surfaced loudly so the runner never reports false success.
 * - otherwise             → ok (study_added true = verified; null = count unverifiable)
 */
export function interpretCompile(result) {
  const r = result || {};
  if (r.has_errors) return { ok: false, reason: 'errors', errors: r.errors || [] };
  if (r.study_added === false) return { ok: false, reason: 'not_added', button: r.button_clicked || 'unknown' };
  return { ok: true, verified: r.study_added === true };
}

/** Screenshot basename WITHOUT extension — captureScreenshot() appends `.png` itself. */
export function screenshotName(name, stamp) {
  return `pine_build_${name}_${stamp}`;
}

/** Number of studies currently on the chart (null if unreadable). Uses `evaluate`. */
function studyCount(evaluate) {
  return evaluate(`(function(){try{var c=${CHART_API};if(c&&typeof c.getAllStudies==='function')return c.getAllStudies().length;}catch(e){}return null;})()`);
}

/**
 * Click the editor's "Add to chart" button with a LENIENT matcher. TradingView renders
 * its label duplicated ("Add to chartAdd to chart"), so exact-text matching misses it.
 * Matches any visible button whose text contains "add to chart" (also catches
 * "Save and add to chart"). Returns the matched label, or null if none found.
 */
function clickAddToChart(evaluate) {
  return evaluate(`(function(){
    var btns=document.querySelectorAll('button');
    for(var i=0;i<btns.length;i++){
      var b=btns[i];
      if(b.offsetParent===null) continue;
      if((b.textContent||'').trim().toLowerCase().indexOf('add to chart')!==-1){ b.click(); return 'add to chart'; }
    }
    return null;
  })()`);
}

async function main(argv) {
  const fs = await import('node:fs');

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`✗ ${e.message}\n`);
    return 1;
  }

  let srcPath;
  try {
    srcPath = resolveIndicatorPath(opts.name);
  } catch (e) {
    process.stderr.write(`✗ ${e.message}\n`);
    return 1;
  }

  const exists = fs.existsSync(srcPath);

  // --dry: print the plan, open NO connection (must work with TradingView closed).
  if (opts.dry) {
    process.stdout.write(`🟡 dry run — ${opts.name}\n`);
    process.stdout.write(`   source: ${srcPath}${exists ? '' : '  ⚠️ MISSING'}\n`);
    planSteps(opts, srcPath, exists).forEach((s, i) => process.stdout.write(`   ${i + 1}. ${s}\n`));
    process.stdout.write(`   (dry run — nothing was sent to TradingView)\n`);
    return 0;
  }

  // Real run needs the source to exist — fail fast BEFORE touching CDP.
  if (!exists) {
    process.stderr.write(`✗ Indicator not found: ${opts.name}\n  looked for: ${srcPath}\n`);
    return 1;
  }
  const source = fs.readFileSync(srcPath, 'utf8');

  // Live path — load CDP + core only now (so --dry / errors never connect).
  const { evaluate, evaluateAsync, disconnect } = await import('../src/connection.js');
  const pine = await import('../src/core/pine.js');
  const capture = await import('../src/core/capture.js');

  try {
    if (opts.symbol) {
      await evaluateAsync(`(function(){var c=${CHART_API};return new Promise(function(r){c.setSymbol(${JSON.stringify(opts.symbol)},{});setTimeout(r,800);});})()`);
    }

    // Always build into a FRESH editable script, so we never reuse or clobber whatever
    // (possibly read-only / published) script happens to be open in the editor.
    await pine.newScript({ type: 'indicator' });
    await pine.setSource({ source });

    // Add to chart with the lenient matcher, then VERIFY the study count rose — this is
    // the ground truth, not which button was clicked.
    const before = await studyCount(evaluate);
    const clicked = await clickAddToChart(evaluate);
    await new Promise((r) => setTimeout(r, 2500));
    const after = await studyCount(evaluate);
    const { errors } = await pine.getErrors();
    const outcome = interpretCompile({
      has_errors: errors.length > 0,
      errors,
      button_clicked: clicked || 'none',
      study_added: (before != null && after != null) ? after > before : null,
    });

    if (!outcome.ok && outcome.reason === 'errors') {
      process.stderr.write(`❌ ${outcome.errors.length} compile error(s):\n`);
      for (const e of outcome.errors) process.stderr.write(`  line ${e.line}: ${e.message}\n`);
      return 1;
    }
    if (!outcome.ok && outcome.reason === 'not_added') {
      process.stderr.write(`✗ ${opts.name} compiled clean but was NOT added to the chart (button: ${outcome.button}).\n`);
      process.stderr.write(`  The Pine editor likely has a read-only / published script open. Open a blank indicator script and retry.\n`);
      return 1;
    }
    process.stdout.write(`✅ ${opts.name} compiled clean and added to chart${outcome.verified ? '' : ' (study count unverified)'}\n`);

    if (opts.save) {
      const title = indicatorTitle(source) || opts.name;
      const saveName = `AT · ${title}`;
      await saveTo(saveName, evaluateAsync, pine);
      process.stdout.write(`💾 saved as "${saveName}"\n`);
    }

    if (opts.screenshot) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = screenshotName(opts.name, stamp);
      await capture.captureScreenshot({ region: 'full', filename });
      process.stdout.write(`📸 screenshots/${filename}.png\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(`✗ build failed: ${e.message}\n`);
    return 1;
  } finally {
    try { await disconnect(); } catch { /* ignore */ }
  }
}

/**
 * Save the current script under `name`. New scripts pop a name dialog; we fill the
 * name input (React-controlled, so use the native setter + input event) before the
 * connector's save() clicks the dialog's Save button. See the prior
 * "Fix pine_save dialog handling" commit for the dialog selector lineage.
 */
async function saveTo(name, evaluateAsync, pine) {
  await pine.ensurePineEditorOpen();
  // Trigger the save dialog, then fill the name field if one appears.
  await evaluateAsync(`(function(){return new Promise(function(resolve){
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,ctrlKey:true,bubbles:true}));
    setTimeout(function(){
      var input=document.querySelector('[role="dialog"] input, [class*="dialog"] input, [class*="modal"] input');
      if(input){
        var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        setter.call(input, ${JSON.stringify(name)});
        input.dispatchEvent(new Event('input',{bubbles:true}));
      }
      resolve(!!input);
    },700);
  });})()`);
  await pine.save();
}

// Run only when invoked directly (so tests can import parseArgs/resolveIndicatorPath safely).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
