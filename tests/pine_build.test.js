/**
 * pine_build.mjs tests — generic Pine indicator build scaffold.
 * Unit + static tests (no live TradingView). Run: node --test tests/pine_build.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveIndicatorPath, interpretCompile, screenshotName } from '../scripts/pine_build.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { check } from '../src/core/pine.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(REPO_ROOT, 'scripts', 'pine_build.mjs');
const indicatorSrc = (name) => readFileSync(join(REPO_ROOT, 'indicators', name, 'source.pine'), 'utf8');

function runRunner(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [RUNNER, ...args], { encoding: 'utf-8', timeout: 10000, ...opts });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status ?? 1 };
  }
}

describe('pine_build — parseArgs', () => {
  it('parses a bare indicator name with defaults', () => {
    const r = parseArgs(['bias-stack']);
    assert.deepEqual(r, { name: 'bias-stack', symbol: null, save: false, screenshot: false, dry: false });
  });

  it('parses --symbol with its value', () => {
    const r = parseArgs(['bias-stack', '--symbol', 'NASDAQ:NVDA']);
    assert.equal(r.name, 'bias-stack');
    assert.equal(r.symbol, 'NASDAQ:NVDA');
  });

  it('parses boolean flags --save --screenshot --dry', () => {
    const r = parseArgs(['bias-stack', '--save', '--screenshot', '--dry']);
    assert.equal(r.save, true);
    assert.equal(r.screenshot, true);
    assert.equal(r.dry, true);
  });

  it('parses all flags combined', () => {
    const r = parseArgs(['bias-stack', '--symbol', 'NASDAQ:NVDA', '--save', '--screenshot', '--dry']);
    assert.deepEqual(r, { name: 'bias-stack', symbol: 'NASDAQ:NVDA', save: true, screenshot: true, dry: true });
  });

  it('throws on --symbol with no value', () => {
    assert.throws(() => parseArgs(['bias-stack', '--symbol']), /--symbol/);
  });

  it('throws when no indicator name is given', () => {
    assert.throws(() => parseArgs(['--save']), /indicator name/i);
  });
});

describe('pine_build — interpretCompile (live-compile outcome, pure)', () => {
  it('flags compile errors as not-ok', () => {
    const o = interpretCompile({ has_errors: true, errors: [{ line: 3, message: 'boom' }] });
    assert.equal(o.ok, false);
    assert.equal(o.reason, 'errors');
    assert.equal(o.errors.length, 1);
  });
  it('treats compiled-but-not-added as a LOUD failure (no false success)', () => {
    const o = interpretCompile({ has_errors: false, study_added: false, button_clicked: 'Pine Save' });
    assert.equal(o.ok, false);
    assert.equal(o.reason, 'not_added');
    assert.equal(o.button, 'Pine Save');
  });
  it('passes when the study was verifiably added', () => {
    const o = interpretCompile({ has_errors: false, study_added: true });
    assert.equal(o.ok, true);
    assert.equal(o.verified, true);
  });
  it('passes but marks unverified when the study count is unknown (null)', () => {
    const o = interpretCompile({ has_errors: false, study_added: null });
    assert.equal(o.ok, true);
    assert.equal(o.verified, false);
  });
});

describe('pine_build — screenshotName (no double extension)', () => {
  it('returns a basename with no .png suffix (captureScreenshot adds it)', () => {
    const n = screenshotName('bias-stack', '2026-06-15T03-45-28-455Z');
    assert.equal(n, 'pine_build_bias-stack_2026-06-15T03-45-28-455Z');
    assert.doesNotMatch(n, /\.png$/);
  });
});

describe('pine_build — resolveIndicatorPath', () => {
  it('resolves a valid name to indicators/<name>/source.pine', () => {
    const p = resolveIndicatorPath('bias-stack', REPO_ROOT);
    assert.equal(p, join(REPO_ROOT, 'indicators', 'bias-stack', 'source.pine'));
  });

  it('rejects ../ traversal before any I/O', () => {
    assert.throws(() => resolveIndicatorPath('../../../etc/passwd', REPO_ROOT), /traversal|illegal/i);
  });

  it('rejects nested traversal', () => {
    assert.throws(() => resolveIndicatorPath('foo/../../../secret', REPO_ROOT), /traversal|illegal/i);
  });

  it('keeps the resolved path inside indicators/', () => {
    const p = resolveIndicatorPath('bias-stack', REPO_ROOT);
    assert.ok(p.startsWith(join(REPO_ROOT, 'indicators') + '/'), `resolved path escaped indicators/: ${p}`);
  });
});

describe('pine_build — main (no live TV needed)', () => {
  it('unknown indicator name exits non-zero with the resolved path', () => {
    const { exitCode, stderr } = runRunner(['nonexistent-indicator']);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /nonexistent-indicator/);
    assert.match(stderr, /not found|no such/i);
    assert.match(stderr, /indicators[/\\]nonexistent-indicator[/\\]source\.pine/);
  });

  it('path traversal name exits non-zero and reads nothing', () => {
    const { exitCode, stderr } = runRunner(['../../../etc/passwd']);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /traversal|illegal/i);
  });

  it('--dry exits 0, prints a plan, and opens no CDP connection (works with TV closed)', () => {
    const start = Date.now();
    const { exitCode, stdout } = runRunner(['bias-stack', '--symbol', 'NASDAQ:NVDA', '--save', '--dry']);
    const elapsed = Date.now() - start;
    assert.equal(exitCode, 0);
    assert.match(stdout, /dry run|dry-run|plan/i);
    assert.match(stdout, /NASDAQ:NVDA/);
    assert.ok(elapsed < 3000, `--dry took ${elapsed}ms (should be <3s — it must not connect)`);
  });
});

describe('pine_build — bias-stack source lint (static)', () => {
  const src = indicatorSrc('bias-stack');
  it('is Pine v6', () => assert.equal(src.split('\n').map((l) => l.trim()).find((l) => l !== ''), '//@version=6'));
  it('declares an overlay indicator (not a strategy)', () => {
    assert.match(src, /indicator\(/);
    assert.match(src, /overlay\s*=\s*true/);
    assert.doesNotMatch(src, /^\s*strategy\(/m);
  });
  it('has adjustable EMA/RSI inputs with the right defaults', () => {
    assert.match(src, /input\.int\(\s*20\b/);
    assert.match(src, /input\.int\(\s*50\b/);
    assert.match(src, /input\.int\(\s*14\b/);
  });
  it('has the bias shading, RSI-50 trigger, and trigger marker', () => {
    assert.match(src, /bgcolor\(/);
    assert.match(src, /ta\.crossover\(/);
    assert.match(src, /plotshape\(/);
  });
  it('contains no strategy/trade calls (advisory only)', () => {
    assert.doesNotMatch(src, /strategy\.(entry|close|order|exit)/);
  });
});

describe('pine_build — zct-oi-filter source lint (static)', () => {
  const src = indicatorSrc('zct-oi-filter');
  it('is Pine v6 with an indicator declaration', () => {
    assert.equal(src.split('\n').map((l) => l.trim()).find((l) => l !== ''), '//@version=6');
    assert.match(src, /indicator\(/);
  });
  it('fetches open interest via request.security with the _OI suffix', () => {
    assert.match(src, /request\.security\(/);
    assert.match(src, /_OI/);
  });
  it('has two EMA length inputs (60 / 240) and a shaded fill', () => {
    assert.match(src, /input\.int\(\s*60\b/);
    assert.match(src, /input\.int\(\s*240\b/);
    assert.match(src, /fill\(|bgcolor\(/);
  });
  it('contains no strategy/trade calls', () => {
    assert.doesNotMatch(src, /strategy\.(entry|close|order|exit)/);
  });
});

describe('pine_build — offline compile via TradingView (REST, needs network)', () => {
  for (const name of ['bias-stack', 'zct-oi-filter']) {
    it(`${name} compiles clean`, async (t) => {
      let r;
      try {
        r = await check({ source: indicatorSrc(name) });
      } catch (e) {
        t.skip(`pine-facade unreachable: ${e.message}`);
        return;
      }
      if (!r.compiled && r.errors) for (const e of r.errors) console.error(`  line ${e.line}: ${e.message}`);
      assert.equal(r.compiled, true);
      assert.equal(r.error_count, 0);
    });
  }
});

describe('pine_build — advisory-only guard (static analysis of the runner)', () => {
  const runner = readFileSync(RUNNER, 'utf8');
  it('contains no exchange/trade signatures', () => {
    assert.doesNotMatch(runner, /place-order/);
    assert.doesNotMatch(runner, /bitget/i);
    assert.doesNotMatch(runner, /createHmac|createSign/);
  });
  it('imports no exchange/order/scalper module', () => {
    assert.doesNotMatch(runner, /import[^\n]*scalper-run/);
    assert.doesNotMatch(runner, /import[^\n]*exchange/i);
  });
  it('uses src/connection.js, not chrome-remote-interface directly', () => {
    assert.doesNotMatch(runner, /chrome-remote-interface/);
    assert.match(runner, /\.\.\/src\/connection\.js/);
  });
});

describe('pine_build — legacy scripts removed', () => {
  it('pine_push.js and pine_pull.js are deleted', () => {
    assert.equal(existsSync(join(REPO_ROOT, 'scripts', 'pine_push.js')), false);
    assert.equal(existsSync(join(REPO_ROOT, 'scripts', 'pine_pull.js')), false);
  });
  it('the pine-develop skill points at pine_build.mjs, not the legacy scripts', () => {
    const skill = readFileSync(join(REPO_ROOT, 'skills', 'pine-develop', 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /pine_push\.js|pine_pull\.js/);
    assert.match(skill, /pine_build\.mjs/);
  });
});

describe('pine_build — indicators/README contract', () => {
  const readme = readFileSync(join(REPO_ROOT, 'indicators', 'README.md'), 'utf8');
  it('documents the folder contract and the runner', () => {
    assert.match(readme, /spec\.md/);
    assert.match(readme, /source\.pine/);
    assert.match(readme, /pine_build\.mjs/);
    assert.match(readme, /add a new indicator/i);
  });
});
