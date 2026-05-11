#!/usr/bin/env node
/**
 * PLAYWRIGHT DISTRIBUTED COORDINATOR
 *
 * Usage:
 *   node coordinator/coordinator.js --config=config.json
 *
 * Or inline:
 *   node coordinator/coordinator.js \
 *     --vms="localhost:3001,192.168.1.10:3001" \
 *     --browsers=3 \
 *     --query="Playwright"
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Parse CLI args ──────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

// ─── Load config ─────────────────────────────────────────────────────────────
let config = {};
if (args.config && fs.existsSync(args.config)) {
  config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  console.log(`Loaded config from ${args.config}`);
}

// ─── Load script source to send to agents ────────────────────────────────────
const LIB_SOURCE    = fs.readFileSync(path.join(__dirname, '../src/lib.js'),       'utf8');
//const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, '../src/runScript.js'), 'utf8');
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, '../src/loginScript.js'), 'utf8');
// Concatenate lib + script so helpers are in scope when the agent compiles them
const BUNDLED_SCRIPT = `${LIB_SOURCE}\n${SCRIPT_SOURCE}`;

// CLI overrides config
const CONFIG = {
  vms: args.vms
    ? args.vms.split(',').map((v, i) => {
        const [host, port] = v.split(':');
        return { id: `vm-${i + 1}`, host: host.trim(), port: parseInt(port || '3001'), browsers: parseInt(args.browsers || '2') };
      })
    : config.vms || [{ id: 'local', host: 'localhost', port: 3001, browsers: 2 }],

  searchQuery: args.query || config.searchQuery || 'Playwright',
  targetUrl:   args.url   || config.targetUrl   || 'https://www.google.com',
  headless:    args.headless !== 'false' && config.headless !== false,
  ignoreHTTPSErrors: args.ignoreHTTPSErrors !== 'false' && config.ignoreHTTPSErrors !== false,
  reportFile:  args.report || config.reportFile  || `reports/report-${Date.now()}.json`,
  timeout:     parseInt(args.timeout || config.timeout || '60000'),
  iterations:  parseInt(args.iterations || config.iterations || '1'),

  // Barrier (rendezvous) server — agents POST /barrier?label=X to sync up
  barrierHost:    args['barrier-host']    || config.barrierHost    || 'localhost',
  barrierPort:    parseInt(args['barrier-port']    || config.barrierPort    || '4000'),
  barrierTimeout: parseInt(args['barrier-timeout'] || config.barrierTimeout || '90000'),
};

const log  = (msg) => console.log(`\x1b[36m[COORDINATOR]\x1b[0m ${msg}`);
const ok   = (msg) => console.log(`\x1b[32m[✓]\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const err  = (msg) => console.log(`\x1b[31m[✗]\x1b[0m ${msg}`);

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function httpPost(host, port, pathname, body, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: host,
      port,
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout
    };
    const req = http.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`Invalid JSON from ${host}:${port}: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout waiting for ${host}:${port}${pathname} response after ${timeout}ms`));
    });
    req.write(data);
    req.end();
  });
}

function httpGet(host, port, pathname, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const options = { hostname: host, port, path: pathname, method: 'GET', timeout };
    const req = http.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── Barrier (rendezvous) server ─────────────────────────────────────────────
// Agents POST /barrier with { label, timeoutMs?, browserId? }. The server
// blocks the response until either:
//   - `expected` browsers have arrived for this label  (full quorum), or
//   - the per-label deadline elapses                    (fail-open timeout).
// All currently-pending requests are then released together with the same
// `releaseAt` epoch (millisecond-aligned). Late arrivals (after release) get
// an immediate response with `late: true` so they proceed without blocking.
let BARRIER_EXPECTED = 0;
const barrierState = new Map(); // label -> state

function ensureBarrier(label, expected, timeoutMs) {
  let s = barrierState.get(label);
  if (!s) {
    s = {
      label,
      arrivals: 0,
      expected,
      pending: [],
      deadlineAt: null,
      released: false,
      releaseAt: null,
      timer: null,
      timedOut: false,
    };
    barrierState.set(label, s);
  }
  if (expected > s.expected) s.expected = expected;
  if (!s.deadlineAt) {
    s.deadlineAt = Date.now() + timeoutMs;
    s.timer = setTimeout(() => releaseBarrier(label, true), timeoutMs);
  }
  return s;
}

function respondBarrier(res, s, browserId, late) {
  const body = JSON.stringify({
    label:     s.label,
    arrivals:  s.arrivals,
    expected:  s.expected,
    timedOut:  s.timedOut,
    late,
    releaseAt: s.releaseAt,
    browserId,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

function releaseBarrier(label, timedOut = false) {
  const s = barrierState.get(label);
  if (!s || s.released) return;
  s.released  = true;
  s.timedOut  = timedOut;
  s.releaseAt = Date.now() + 50; // small grace so all clients see a future timestamp
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  log(`barrier "${label}" ${timedOut ? 'TIMED OUT' : 'released'} — ${s.arrivals}/${s.expected} arrived`);
  s.pending.forEach(({ res, browserId }) => respondBarrier(res, s, browserId, false));
  s.pending = [];
}

const barrierServer = http.createServer((req, res) => {
  // CORS / preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST' || !req.url.startsWith('/barrier')) {
    res.writeHead(404); res.end(); return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
    const label     = payload.label || 'default';
    const browserId = payload.browserId || '?';
    const timeoutMs = Math.max(100, payload.timeoutMs || CONFIG.barrierTimeout);

    const s = ensureBarrier(label, BARRIER_EXPECTED, timeoutMs);
    if (s.released) {
      // Late arrival — proceed immediately, run is already moving on
      respondBarrier(res, s, browserId, true);
      return;
    }
    s.arrivals++;
    s.pending.push({ res, browserId });
    // Drop the connection cleanly if the client gives up (don't leak resolvers)
    res.on('close', () => {
      if (!s.released) {
        s.pending = s.pending.filter(p => p.res !== res);
      }
    });
    if (s.arrivals >= s.expected) releaseBarrier(label, false);
  });
  req.on('error', () => { try { res.writeHead(500); res.end(); } catch {} });
});

function startBarrierServer() {
  return new Promise((resolve, reject) => {
    barrierServer.once('error', reject);
    barrierServer.listen(CONFIG.barrierPort, () => {
      log(`Barrier server listening on http://${CONFIG.barrierHost}:${CONFIG.barrierPort}/barrier  (expected=${BARRIER_EXPECTED}, timeout=${CONFIG.barrierTimeout}ms)`);
      resolve();
    });
  });
}
function stopBarrierServer() {
  // Force-release any still-pending barriers so this never hangs shutdown
  for (const label of barrierState.keys()) releaseBarrier(label, true);
  return new Promise(resolve => barrierServer.close(() => resolve()));
}

// ─── Health check all VMs ─────────────────────────────────────────────────────
async function checkVMs() {
  log(`Checking connectivity to ${CONFIG.vms.length} VM(s)...`);
  const results = await Promise.allSettled(
    CONFIG.vms.map(vm => httpGet(vm.host, vm.port, '/health'))
  );

  const reachable = [];
  const unreachable = [];

  results.forEach((r, i) => {
    const vm = CONFIG.vms[i];
    if (r.status === 'fulfilled') {
      ok(`${vm.id} (${vm.host}:${vm.port}) - reachable`);
      reachable.push(vm);
    } else {
      err(`${vm.id} (${vm.host}:${vm.port}) - UNREACHABLE: ${r.reason?.message}`);
      unreachable.push(vm);
    }
  });

  return { reachable, unreachable };
}

// ─── Run tests on all reachable VMs ──────────────────────────────────────────
async function runOnAllVMs(reachableVMs) {
  log(`\nDispatching to ${reachableVMs.length} VM(s)...`);
  log(`Query: "${CONFIG.searchQuery}" | URL: ${CONFIG.targetUrl} | Headless: ${CONFIG.headless}`);
  console.log('');

  const startTime = Date.now();

  const vmResults = await Promise.allSettled(
    reachableVMs.map(async vm => {
      log(`→ Dispatching to ${vm.id} (${vm.host}:${vm.port}) — ${vm.browsers} browser(s)`);
      const response = await httpPost(
        vm.host, vm.port, '/run-sync',
        {
          browsers: vm.browsers,
          searchQuery: CONFIG.searchQuery,
          targetUrl: CONFIG.targetUrl,
          headless: CONFIG.headless,
          ignoreHTTPSErrors: CONFIG.ignoreHTTPSErrors,
          script: BUNDLED_SCRIPT,
          barrierUrl:     `http://${CONFIG.barrierHost}:${CONFIG.barrierPort}/barrier`,
          barrierTimeout: CONFIG.barrierTimeout
        },
        CONFIG.timeout
      );
      ok(`${vm.id} completed — ${response.results?.length || 0} results`);
      return { vm, response };
    })
  );

  const totalDuration = Date.now() - startTime;
  return { vmResults, totalDuration };
}

// ─── Aggregate & Report ───────────────────────────────────────────────────────
// Convert a camelCase / snake_case key into a Title Case label
function humanizeKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Discover every timing key that appears on at least one successful result.
// `totalTime` (if present) is always placed last; everything else preserves
// first-seen order across results.
function discoverTimingKeys(successResults) {
  const seen = new Set();
  const order = [];
  successResults.forEach(r => {
    Object.keys(r.timings || {}).forEach(k => {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    });
  });
  const total = order.filter(k => k === 'totalTime');
  const rest  = order.filter(k => k !== 'totalTime');
  return [...rest, ...total];
}

// Pick the "total" key — prefer explicit `totalTime`, else last in order.
function totalTimingKeyOf(timingKeys) {
  if (!timingKeys.length) return null;
  return timingKeys.includes('totalTime') ? 'totalTime' : timingKeys[timingKeys.length - 1];
}

// Format byte count as human-readable (B / KB / MB / GB).
function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function aggregateResults(vmResults, unreachable, totalDuration = 0) {
  const allBrowserResults = [];
  const vmSummaries = [];

  vmResults.forEach(settled => {
    if (settled.status === 'fulfilled') {
      const { vm, response } = settled.value;
      const results = response.results || [];

      const vmTimings = results
        .filter(r => r.status === 'success')
        .map(r => r.timings.totalTime || 0);

      vmSummaries.push({
        vmId: vm.id,
        host: `${vm.host}:${vm.port}`,
        status: 'success',
        browsersRun: results.length,
        browsersSucceeded: results.filter(r => r.status === 'success').length,
        avgTotalTime: vmTimings.length ? Math.round(vmTimings.reduce((a, b) => a + b, 0) / vmTimings.length) : null,
        minTotalTime: vmTimings.length ? Math.min(...vmTimings) : null,
        maxTotalTime: vmTimings.length ? Math.max(...vmTimings) : null,
      });

      allBrowserResults.push(...results.map(r => ({ ...r, vmId: vm.id, vmHost: `${vm.host}:${vm.port}` })));
    } else {
      const vm = settled.reason?.vm || {};
      vmSummaries.push({ vmId: vm.id || '?', status: 'error', error: settled.reason?.message });
    }
  });

  unreachable.forEach(vm => {
    vmSummaries.push({ vmId: vm.id, host: `${vm.host}:${vm.port}`, status: 'unreachable' });
  });

  // Discover all timing keys dynamically and aggregate stats per key
  const successResults = allBrowserResults.filter(r => r.status === 'success');
  const timingKeys = discoverTimingKeys(successResults);

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const p95 = arr => pct(arr, 0.95);
  const p50 = arr => pct(arr, 0.50);
  const p99 = arr => pct(arr, 0.99);
  const stdDev = arr => {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
    return Math.round(Math.sqrt(v));
  };

  const timings = {};
  timingKeys.forEach(key => {
    const vals = successResults
      .map(r => r.timings?.[key])
      .filter(v => typeof v === 'number');
    timings[key] = {
      label: humanizeKey(key),
      avg: avg(vals),
      min: vals.length ? Math.min(...vals) : Infinity,
      max: vals.length ? Math.max(...vals) : 0,
      p50: p50(vals),
      p95: p95(vals),
      p99: p99(vals),
      stdDev: stdDev(vals),
    };
  });

  // ─── Discover & aggregate arbitrary counters (data metrics) ──────────────
  // e.g. bytesReceived, requestCount, failedRequests, itemsScraped …
  const counterKeys = (() => {
    const seen = new Set(); const order = [];
    successResults.forEach(r => {
      Object.keys(r.counters || {}).forEach(k => {
        if (!seen.has(k)) { seen.add(k); order.push(k); }
      });
    });
    return order;
  })();

  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const counters = {};
  counterKeys.forEach(key => {
    const vals = successResults
      .map(r => r.counters?.[key])
      .filter(v => typeof v === 'number');
    counters[key] = {
      label: humanizeKey(key),
      total: sum(vals),
      avg:   avg(vals),
      min:   vals.length ? Math.min(...vals) : 0,
      max:   vals.length ? Math.max(...vals) : 0,
      p50:   p50(vals),
      p95:   p95(vals),
    };
  });

  // ─── KPIs ────────────────────────────────────────────────────────────────
  const totalBrowsers = allBrowserResults.length;
  const ok = successResults.length;
  const failed = allBrowserResults.filter(r => r.status === 'error').length;
  const durationSec = totalDuration / 1000;
  const successRate = totalBrowsers ? +(ok / totalBrowsers * 100).toFixed(1) : 0;
  const errorRate   = totalBrowsers ? +(failed / totalBrowsers * 100).toFixed(1) : 0;
  // Transactions = each timed step on each successful browser
  const transactions = ok * timingKeys.length;
  const browsersPerSec     = durationSec > 0 ? +(ok / durationSec).toFixed(2) : 0;
  const transactionsPerSec = durationSec > 0 ? +(transactions / durationSec).toFixed(2) : 0;
  // Avg concurrency: how many browsers were effectively running in parallel
  const avgTotalTimeMs = timings[totalTimingKeyOf(timingKeys)]?.avg || 0;
  const avgConcurrency = durationSec > 0 && avgTotalTimeMs > 0
    ? +((ok * avgTotalTimeMs / 1000) / durationSec).toFixed(2)
    : 0;

  // Data-related KPIs (only meaningful when network tracking is in use)
  const totalBytes        = counters.bytesReceived?.total || 0;
  const totalRequests     = counters.requestCount?.total  || 0;
  const failedReq         = counters.failedRequests?.total || 0;
  const bytesPerSec       = durationSec > 0 ? Math.round(totalBytes / durationSec) : 0;
  const requestsPerSec    = durationSec > 0 ? +(totalRequests / durationSec).toFixed(2) : 0;
  const httpErrorRate     = totalRequests ? +(failedReq / totalRequests * 100).toFixed(2) : 0;

  return {
    summary: {
      totalVMs: vmSummaries.length,
      reachableVMs: vmSummaries.filter(v => v.status === 'success').length,
      totalBrowsers,
      successfulBrowsers: ok,
      failedBrowsers: failed,
      successRate,
      errorRate,
      transactions,
      transactionsPerSec,
      browsersPerSec,
      avgConcurrency,
      // Data KPIs
      totalBytes,
      bytesPerSec,
      totalRequests,
      requestsPerSec,
      failedRequests: failedReq,
      httpErrorRate,
      durationMs: totalDuration,
      durationSec: +durationSec.toFixed(2),
      searchQuery: CONFIG.searchQuery,
      targetUrl: CONFIG.targetUrl,
      timestamp: new Date().toISOString(),
    },
    timingKeys,
    timings,
    counterKeys,
    counters,
    vmSummaries,
    browserResults: allBrowserResults,
  };
}

// ─── Pretty Print ─────────────────────────────────────────────────────────────
function printReport(report) {
  const { summary, timings, timingKeys, counters, counterKeys, vmSummaries, browserResults } = report;

  console.log('\n' + '═'.repeat(60));
  console.log('  DISTRIBUTED PLAYWRIGHT PERFORMANCE REPORT');
  console.log('═'.repeat(60));
  console.log(`  Query    : "${summary.searchQuery}"`);
  console.log(`  URL      : ${summary.targetUrl}`);
  console.log(`  Time     : ${summary.timestamp}`);
  console.log(`  VMs      : ${summary.reachableVMs}/${summary.totalVMs} reachable`);
  console.log(`  Browsers : ${summary.successfulBrowsers}/${summary.totalBrowsers} succeeded`);
  console.log('─'.repeat(60));

  console.log('\n  KEY PERFORMANCE METRICS\n');
  console.log(`  Success Rate          : ${summary.successRate}%`);
  console.log(`  Error Rate            : ${summary.errorRate}%`);
  console.log(`  Total Duration        : ${summary.durationSec}s`);
  console.log(`  Browser Throughput    : ${summary.browsersPerSec} browsers/sec`);
  console.log(`  Transaction Throughput: ${summary.transactionsPerSec} tx/sec  (${summary.transactions} total tx)`);
  console.log(`  Avg Concurrency       : ${summary.avgConcurrency}`);
  if (summary.totalBytes || summary.totalRequests) {
    console.log(`  Data Received         : ${formatBytes(summary.totalBytes)}  (${summary.totalRequests} reqs)`);
    console.log(`  Data Throughput       : ${formatBytes(summary.bytesPerSec)}/s`);
    console.log(`  Request Throughput    : ${summary.requestsPerSec} req/sec`);
    console.log(`  HTTP Error Rate       : ${summary.httpErrorRate}%  (${summary.failedRequests} failed)`);
  }
  console.log('─'.repeat(60));

  console.log('\n  TIMING BREAKDOWN (ms)\n');
  console.log(`  ${'Metric'.padEnd(22)} ${'Avg'.padStart(7)} ${'Min'.padStart(7)} ${'Max'.padStart(7)} ${'P50'.padStart(7)} ${'P95'.padStart(7)} ${'P99'.padStart(7)} ${'σ'.padStart(7)}`);
  console.log('  ' + '─'.repeat(72));

  timingKeys.forEach(key => {
    const t = timings[key];
    const isBold = key === 'totalTime';
    const prefix = isBold ? '\x1b[1m' : '';
    const reset  = isBold ? '\x1b[0m' : '';
    const label  = (isBold ? 'TOTAL' : t.label).slice(0, 22);
    const cells  = [t.avg, t.min === Infinity ? '-' : t.min, t.max || '-', t.p50, t.p95, t.p99, t.stdDev]
      .map(v => String(v).padStart(7)).join(' ');
    console.log(`${prefix}  ${label.padEnd(22)} ${cells}${reset}`);
  });

  if (counterKeys && counterKeys.length) {
    console.log('\n  DATA COUNTERS\n');
    console.log(`  ${'Metric'.padEnd(22)} ${'Total'.padStart(12)} ${'Avg'.padStart(10)} ${'Min'.padStart(10)} ${'Max'.padStart(10)}`);
    console.log('  ' + '─'.repeat(68));
    counterKeys.forEach(key => {
      const c = counters[key];
      const isBytes = /bytes/i.test(key);
      const fmt = v => isBytes ? formatBytes(v) : String(v);
      console.log(`  ${c.label.slice(0,22).padEnd(22)} ${fmt(c.total).padStart(12)} ${fmt(c.avg).padStart(10)} ${fmt(c.min).padStart(10)} ${fmt(c.max).padStart(10)}`);
    });
  }

  console.log('\n  VM SUMMARIES\n');
  vmSummaries.forEach(vm => {
    const status = vm.status === 'success' ? '\x1b[32m✓\x1b[0m' : vm.status === 'unreachable' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m!\x1b[0m';
    const info = vm.status === 'success'
      ? `browsers: ${vm.browsersSucceeded}/${vm.browsersRun} ok | avg: ${vm.avgTotalTime}ms | min: ${vm.minTotalTime}ms | max: ${vm.maxTotalTime}ms`
      : vm.status === 'unreachable' ? 'UNREACHABLE' : `ERROR: ${vm.error}`;
    console.log(`  ${status} ${(vm.vmId || '?').padEnd(15)} ${vm.host || ''}`);
    console.log(`    ${info}`);
  });

  console.log('\n  PER-BROWSER RESULTS\n');
  browserResults.forEach(r => {
    const icon = r.status === 'success' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    if (r.status === 'success') {
      console.log(`  ${icon} [${r.vmId}] ${r.browserId}`);
      const parts = timingKeys.map(k => `${timings[k].label}: ${r.timings?.[k] ?? '-'}ms`);
      console.log(`     ${parts.join(' | ')}`);
      if (r.topResults?.length) console.log(`     Top result: "${r.topResults[0]}"`);
    } else {
      console.log(`  ${icon} [${r.vmId}] ${r.browserId} — ${r.error}`);
    }
  });

  // ── Cumulative iteration summary table (only when N > 1) ──────────────────
  if (report.iterationReports && report.iterationReports.length > 1) {
    const iters = report.iterationReports;
    const totalKey = timingKeys.includes('totalTime') ? 'totalTime' : timingKeys[timingKeys.length - 1];

    console.log('\n  CUMULATIVE ITERATION SUMMARY\n');
    const hdr = ['Iter', 'OK/Total', 'Success%', 'AvgTotal', 'Min', 'Max', 'P95', 'Duration'];
    console.log('  ' + hdr.map((h, i) => i === 0 ? h.padEnd(6) : h.padStart(10)).join(''));
    console.log('  ' + '─'.repeat(86));

    let cumOk = 0, cumTotal = 0;
    iters.forEach((ir, idx) => {
      const s = ir.summary;
      const t = totalKey && ir.timings[totalKey];
      cumOk    += s.successfulBrowsers;
      cumTotal += s.totalBrowsers;
      const cumRate = cumTotal ? (cumOk / cumTotal * 100).toFixed(1) : '0.0';
      const row = [
        String(idx + 1).padEnd(6),
        (`${s.successfulBrowsers}/${s.totalBrowsers}`).padStart(10),
        (`${s.successRate}%`).padStart(10),
        (t ? `${t.avg}ms` : '—').padStart(10),
        (t ? `${t.min === Infinity ? '-' : t.min + 'ms'}` : '—').padStart(10),
        (t ? `${t.max}ms` : '—').padStart(10),
        (t ? `${t.p95}ms` : '—').padStart(10),
        (`${s.durationSec}s`).padStart(10),
      ];
      console.log('  ' + row.join(''));
    });

    // Cumulative totals row
    const totalKey2 = timingKeys.includes('totalTime') ? 'totalTime' : timingKeys[timingKeys.length - 1];
    const allAvg = totalKey2 ? timings[totalKey2]?.avg : 0;
    const allMin = totalKey2 ? (timings[totalKey2]?.min === Infinity ? '-' : timings[totalKey2]?.min) : '—';
    const allMax = totalKey2 ? timings[totalKey2]?.max : '—';
    const allP95 = totalKey2 ? timings[totalKey2]?.p95 : '—';
    const cumRate = cumTotal ? (cumOk / cumTotal * 100).toFixed(1) : '0.0';
    console.log('  ' + '─'.repeat(86));
    console.log('\x1b[1m  ' + [
      'ALL'.padEnd(6),
      (`${cumOk}/${cumTotal}`).padStart(10),
      (`${cumRate}%`).padStart(10),
      (`${allAvg}ms`).padStart(10),
      (String(allMin) + 'ms').padStart(10),
      (`${allMax}ms`).padStart(10),
      (`${allP95}ms`).padStart(10),
      (`${(report.totalDuration/1000).toFixed(2)}s`).padStart(10),
    ].join('') + '\x1b[0m');
  }

  console.log('\n' + '═'.repeat(60) + '\n');
}

// ─── Single iteration runner ─────────────────────────────────────────────────
async function runIteration(reachable, unreachable, iterNum) {
  log(`\n── Iteration ${iterNum}/${CONFIG.iterations} ──────────────────────────────────────────`);

  // Reset barrier state so each iteration gets a fresh rendezvous
  barrierState.clear();
  BARRIER_EXPECTED = reachable.reduce((sum, vm) => sum + (vm.browsers || 0), 0);

  const { vmResults, totalDuration } = await runOnAllVMs(reachable);
  log(`Iteration ${iterNum} completed in ${totalDuration}ms`);

  const report = aggregateResults(vmResults, unreachable, totalDuration);
  report.totalDuration = totalDuration;
  report.iteration = iterNum;
  return report;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[1m PLAYWRIGHT DISTRIBUTED PERFORMANCE COORDINATOR\x1b[0m\n');
  log(`VMs configured: ${CONFIG.vms.map(v => `${v.id}(${v.host}:${v.port} x${v.browsers})`).join(', ')}`);
  log(`Iterations: ${CONFIG.iterations}`);

  // Step 1: Health check
  const { reachable, unreachable } = await checkVMs();
  if (reachable.length === 0) {
    err('No VMs reachable. Make sure agents are running: node agent/agent.js');
    process.exit(1);
  }

  // Step 1b: Start barrier server (stays up for all iterations)
  BARRIER_EXPECTED = reachable.reduce((sum, vm) => sum + (vm.browsers || 0), 0);
  await startBarrierServer();

  // Step 2: Run N iterations sequentially
  const iterationReports = [];
  const overallStart = Date.now();

  for (let i = 1; i <= CONFIG.iterations; i++) {
    const iterReport = await runIteration(reachable, unreachable, i);
    iterationReports.push(iterReport);

    // Print a compact per-iteration summary
    const s = iterReport.summary;
    const totalKey = iterReport.timingKeys.includes('totalTime') ? 'totalTime' : iterReport.timingKeys[iterReport.timingKeys.length - 1];
    const avgTotal = totalKey ? iterReport.timings[totalKey]?.avg : 0;
    log(`  Iteration ${i}: ${s.successfulBrowsers}/${s.totalBrowsers} ok | avg total: ${avgTotal}ms | duration: ${s.durationSec}s`);
  }

  // Step 2b: Stop barrier server
  await stopBarrierServer();

  const overallDuration = Date.now() - overallStart;

  // Step 3: Merge all iterations into one combined report
  const allBrowserResults = iterationReports.flatMap((r, idx) =>
    r.browserResults.map(b => ({ ...b, iteration: idx + 1 }))
  );

  // Re-aggregate across all iterations with one entry per reachable VM.
  // This keeps summary.totalVMs stable instead of multiplying by iteration count.
  const combinedVmResults = reachable.map(vm => ({
    status: 'fulfilled',
    value: {
      vm,
      response: {
        results: allBrowserResults.filter(b => b.vmId === vm.id),
      },
    },
  }));

  const combinedReport = aggregateResults(
    combinedVmResults,
    unreachable,
    overallDuration
  );
  combinedReport.totalDuration = overallDuration;
  combinedReport.iterations = CONFIG.iterations;
  combinedReport.iterationReports = iterationReports;
  // Override browserResults to include iteration tag
  combinedReport.browserResults = allBrowserResults;

  // Step 4: Print combined report
  console.log(`\n\x1b[1m COMBINED REPORT — ${CONFIG.iterations} iteration(s) | ${overallDuration}ms total\x1b[0m`);
  printReport(combinedReport);

  // Step 5: Save JSON report
  const reportPath = CONFIG.reportFile;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(combinedReport, null, 2));
  ok(`Report saved: ${reportPath}`);

  // Step 6: Save HTML report
  const htmlPath = reportPath.replace('.json', '.html');
  fs.writeFileSync(htmlPath, generateHTML(combinedReport));
  ok(`HTML report: ${htmlPath}`);
}

// ─── HTML Report Generator ────────────────────────────────────────────────────
function generateHTML(report) {
  const { summary, timings, timingKeys, counters, counterKeys, vmSummaries, browserResults } = report;

  const totalTimingKey = timingKeys.includes('totalTime') ? 'totalTime' : timingKeys[timingKeys.length - 1];
  const headerAvgTotal = totalTimingKey ? timings[totalTimingKey].avg : 0;

  // Per-browser table — TRANSPOSED:
  //   rows    = timing keys (+ status / error rows)
  //   columns = browsers
  // This scales well as the script adds more `timed(...)` calls.
  const browserHeaderCells = browserResults.map(r => `
        <th class="browser-col ${r.status}">
          <div class="bh-id">${r.browserId}</div>
          <div class="bh-vm">${r.vmId}</div>
          ${r.iteration != null ? `<div class="bh-iter">iter ${r.iteration}</div>` : ''}
          <div class="bh-status"><span class="badge ${r.status}">${r.status}</span></div>
        </th>`).join('');

  const timingDataRows = timingKeys.map(k => {
    const isTotal = k === totalTimingKey;
    const cells = browserResults.map(r => {
      if (r.status !== 'success') return `<td class="muted">—</td>`;
      const v = r.timings?.[k];
      const val = typeof v === 'number' ? `${v}ms` : '—';
      return `<td>${isTotal ? `<strong>${val}</strong>` : val}</td>`;
    }).join('');
    const aggSummary = `avg ${timings[k].avg}ms · p95 ${timings[k].p95}ms · p99 ${timings[k].p99}ms · σ ${timings[k].stdDev}`;
    return `
      <tr class="${isTotal ? 'total-row' : ''}">
        <th class="metric-col" scope="row">
          <div class="metric-label">${timings[k].label}</div>
          <div class="metric-agg">${aggSummary}</div>
        </th>
        ${cells}
      </tr>`;
  }).join('');

  const errorRow = browserResults.some(r => r.status !== 'success') ? `
      <tr class="error-row">
        <th class="metric-col" scope="row"><div class="metric-label">Error</div></th>
        ${browserResults.map(r => r.status !== 'success'
          ? `<td class="err">${r.error || '—'}</td>`
          : `<td class="muted">—</td>`).join('')}
      </tr>` : '';

  // Counter rows (data metrics) — appear below timings, above errors
  const counterDataRows = (counterKeys || []).map(k => {
    const c = counters[k];
    const isBytes = /bytes/i.test(k);
    const fmt = v => typeof v === 'number' ? (isBytes ? formatBytes(v) : String(v)) : '—';
    const cells = browserResults.map(r => {
      if (r.status !== 'success') return `<td class="muted">—</td>`;
      return `<td>${fmt(r.counters?.[k])}</td>`;
    }).join('');
    return `
      <tr class="counter-row">
        <th class="metric-col" scope="row">
          <div class="metric-label">${c.label}</div>
          <div class="metric-agg">total ${fmt(c.total)} · avg ${fmt(c.avg)}</div>
        </th>
        ${cells}
      </tr>`;
  }).join('');

  const vmCards = vmSummaries.map(vm => `
    <div class="vm-card ${vm.status}">
      <div class="vm-header">
        <span class="vm-id">${vm.vmId}</span>
        <span class="vm-host">${vm.host || ''}</span>
        <span class="status-dot ${vm.status}"></span>
      </div>
      ${vm.status === 'success' ? `
        <div class="vm-stats">
          <div class="stat"><div class="stat-val">${vm.browsersSucceeded}/${vm.browsersRun}</div><div class="stat-lbl">Browsers OK</div></div>
          <div class="stat"><div class="stat-val">${vm.avgTotalTime}ms</div><div class="stat-lbl">Avg Total</div></div>
          <div class="stat"><div class="stat-val">${vm.minTotalTime}ms</div><div class="stat-lbl">Best</div></div>
          <div class="stat"><div class="stat-val">${vm.maxTotalTime}ms</div><div class="stat-lbl">Worst</div></div>
        </div>` : `<div class="vm-error">${vm.status.toUpperCase()}${vm.error ? ': ' + vm.error : ''}</div>`}
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Playwright Distributed Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0b0f; --surface: #12141a; --surface2: #1a1d26;
    --border: #252836; --accent: #00e5ff; --accent2: #7c3aed;
    --success: #22c55e; --error: #ef4444; --warn: #f59e0b;
    --text: #e2e8f0; --muted: #64748b;
    --font-mono: 'JetBrains Mono', monospace;
    --font-sans: 'Syne', sans-serif;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--font-sans); min-height: 100vh; }

  .header { padding: 3rem 2rem 2rem; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, #0a0b0f 0%, #12101f 100%); }
  .header-inner { max-width: 1200px; margin: 0 auto; }
  .logo { font-size: 0.7rem; font-family: var(--font-mono); color: var(--accent); letter-spacing: 4px; text-transform: uppercase; margin-bottom: 0.75rem; }
  h1 { font-size: clamp(1.8rem, 4vw, 3rem); font-weight: 800; line-height: 1.1; }
  h1 span { color: var(--accent); }
  .meta { margin-top: 1rem; display: flex; gap: 2rem; flex-wrap: wrap; font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); }
  .meta b { color: var(--text); }

  .main { max-width: 1200px; margin: 0 auto; padding: 2rem; }
  section { margin-bottom: 3rem; }
  h2 { font-size: 0.65rem; font-family: var(--font-mono); letter-spacing: 4px; text-transform: uppercase; color: var(--muted); margin-bottom: 1.25rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }

  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
  .kpi-val { font-size: 2rem; font-weight: 800; font-family: var(--font-mono); color: var(--accent); line-height: 1; }
  .kpi-lbl { font-size: 0.7rem; color: var(--muted); margin-top: 0.4rem; text-transform: uppercase; letter-spacing: 1px; }

  .timing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
  .timing-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
  .timing-label { font-size: 0.7rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 0.75rem; }
  .timing-avg { font-size: 2.5rem; font-weight: 800; font-family: var(--font-mono); color: var(--text); line-height: 1; }
  .timing-avg span { font-size: 1rem; color: var(--muted); }
  .timing-sub { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin-top: 0.75rem; }
  .timing-sub-item { text-align: center; }
  .timing-sub-val { font-size: 0.85rem; font-family: var(--font-mono); font-weight: 700; }
  .timing-sub-lbl { font-size: 0.6rem; color: var(--muted); text-transform: uppercase; }

  .vm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
  .vm-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
  .vm-card.unreachable { border-color: var(--error); opacity: 0.7; }
  .vm-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
  .vm-id { font-weight: 700; font-family: var(--font-mono); }
  .vm-host { font-size: 0.7rem; color: var(--muted); flex: 1; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-dot.success { background: var(--success); box-shadow: 0 0 6px var(--success); }
  .status-dot.unreachable, .status-dot.error { background: var(--error); }
  .vm-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
  .stat { background: var(--surface2); border-radius: 8px; padding: 0.6rem; text-align: center; }
  .stat-val { font-size: 1.1rem; font-weight: 700; font-family: var(--font-mono); color: var(--accent); }
  .stat-lbl { font-size: 0.6rem; color: var(--muted); text-transform: uppercase; margin-top: 2px; }
  .vm-error { color: var(--error); font-size: 0.8rem; font-family: var(--font-mono); }

  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th { text-align: left; padding: 0.6rem 0.8rem; font-family: var(--font-mono); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); border-bottom: 1px solid var(--border); }
  td { padding: 0.7rem 0.8rem; border-bottom: 1px solid var(--border); font-family: var(--font-mono); font-size: 0.8rem; }
  tr:hover td { background: var(--surface2); }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; }
  .badge.success { background: #14532d; color: #4ade80; }
  .badge.error { background: #450a0a; color: #f87171; }

  /* Transposed results table: metrics as rows, browsers as columns */
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
  .results-table { min-width: 100%; }
  .results-table th, .results-table td { white-space: nowrap; text-align: right; }
  .results-table thead th { position: sticky; top: 0; background: var(--surface); z-index: 2; vertical-align: bottom; }
  .results-table th.metric-col { position: sticky; left: 0; background: var(--surface); text-align: left; z-index: 3; min-width: 220px; border-right: 1px solid var(--border); }
  .results-table thead th.metric-col { z-index: 4; }
  .results-table tbody tr:hover th.metric-col { background: var(--surface2); }
  .metric-label { color: var(--text); font-size: 0.78rem; font-weight: 700; text-transform: none; letter-spacing: 0; }
  .metric-agg   { color: var(--muted); font-size: 0.65rem; margin-top: 2px; text-transform: none; letter-spacing: 0; }
  .browser-col .bh-id     { color: var(--text); font-size: 0.75rem; font-weight: 700; text-transform: none; letter-spacing: 0; }
  .browser-col .bh-vm     { color: var(--muted); font-size: 0.65rem; margin-top: 2px; }
  .browser-col .bh-iter   { color: var(--accent2); font-size: 0.62rem; margin-top: 2px; font-weight: 700; }
  .browser-col .bh-status { margin-top: 4px; }
  .iter-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem; }
  .iter-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }
  .iter-card-title { font-size: 0.65rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 0.5rem; }
  .iter-card-val { font-size: 1.5rem; font-weight: 800; font-family: var(--font-mono); color: var(--accent); line-height: 1; }
  .iter-card-sub { font-size: 0.7rem; color: var(--muted); margin-top: 4px; font-family: var(--font-mono); }
  .results-table tr.total-row td,
  .results-table tr.total-row th.metric-col { background: var(--surface2); }
  .results-table tr.total-row td strong { color: var(--accent); }
  .results-table tr.counter-row td,
  .results-table tr.counter-row th.metric-col { color: var(--text); }
  .results-table tr.counter-row th.metric-col { border-top: 1px solid var(--border); }
  .results-table tr.error-row td.err { color: var(--error); white-space: normal; max-width: 240px; }
  .results-table td.muted { color: var(--muted); }
</style>
</head>
<body>
<div class="header">
  <div class="header-inner">
    <div class="logo">Playwright Distributed Testing</div>
    <h1>Performance <span>Report</span></h1>
    <div class="meta">
      <div><b>Query</b> "${summary.searchQuery}"</div>
      <div><b>Target</b> ${summary.targetUrl}</div>
      <div><b>Time</b> ${summary.timestamp}</div>
      <div><b>Duration</b> ${report.totalDuration}ms total</div>
    </div>
  </div>
</div>

<div class="main">
  <section>
    <h2>Overview</h2>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-val">${summary.totalVMs}</div><div class="kpi-lbl">VMs Configured</div></div>
      <div class="kpi"><div class="kpi-val">${summary.reachableVMs}</div><div class="kpi-lbl">VMs Reached</div></div>
      <div class="kpi"><div class="kpi-val">${summary.totalBrowsers}</div><div class="kpi-lbl">Total Browsers</div></div>
      <div class="kpi"><div class="kpi-val">${summary.successfulBrowsers}</div><div class="kpi-lbl">Successful</div></div>
      <div class="kpi"><div class="kpi-val" style="color:var(--${summary.failedBrowsers > 0 ? 'error' : 'success'})">${summary.failedBrowsers}</div><div class="kpi-lbl">Failed</div></div>
      <div class="kpi"><div class="kpi-val">${headerAvgTotal}<span style="font-size:0.9rem;color:var(--muted)">ms</span></div><div class="kpi-lbl">Avg Total Time</div></div>
    </div>
  </section>

  <section>
    <h2>Key Performance Metrics</h2>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-val" style="color:var(--${summary.successRate >= 95 ? 'success' : summary.successRate >= 80 ? 'warn' : 'error'})">${summary.successRate}<span style="font-size:0.9rem;color:var(--muted)">%</span></div><div class="kpi-lbl">Success Rate</div></div>
      <div class="kpi"><div class="kpi-val" style="color:var(--${summary.errorRate === 0 ? 'success' : 'error'})">${summary.errorRate}<span style="font-size:0.9rem;color:var(--muted)">%</span></div><div class="kpi-lbl">Error Rate</div></div>
      <div class="kpi"><div class="kpi-val">${summary.browsersPerSec}<span style="font-size:0.9rem;color:var(--muted)">/s</span></div><div class="kpi-lbl">Browser Throughput</div></div>
      <div class="kpi"><div class="kpi-val">${summary.transactionsPerSec}<span style="font-size:0.9rem;color:var(--muted)">/s</span></div><div class="kpi-lbl">Transaction Throughput</div></div>
      <div class="kpi"><div class="kpi-val">${summary.transactions}</div><div class="kpi-lbl">Total Transactions</div></div>
      <div class="kpi"><div class="kpi-val">${summary.avgConcurrency}</div><div class="kpi-lbl">Avg Concurrency</div></div>
      <div class="kpi"><div class="kpi-val">${summary.durationSec}<span style="font-size:0.9rem;color:var(--muted)">s</span></div><div class="kpi-lbl">Total Duration</div></div>
      ${summary.totalBytes || summary.totalRequests ? `
      <div class="kpi"><div class="kpi-val">${formatBytes(summary.totalBytes)}</div><div class="kpi-lbl">Data Received</div></div>
      <div class="kpi"><div class="kpi-val">${formatBytes(summary.bytesPerSec)}<span style="font-size:0.9rem;color:var(--muted)">/s</span></div><div class="kpi-lbl">Data Throughput</div></div>
      <div class="kpi"><div class="kpi-val">${summary.totalRequests}</div><div class="kpi-lbl">Total Requests</div></div>
      <div class="kpi"><div class="kpi-val">${summary.requestsPerSec}<span style="font-size:0.9rem;color:var(--muted)">/s</span></div><div class="kpi-lbl">Request Throughput</div></div>
      <div class="kpi"><div class="kpi-val" style="color:var(--${summary.httpErrorRate === 0 ? 'success' : 'error'})">${summary.httpErrorRate}<span style="font-size:0.9rem;color:var(--muted)">%</span></div><div class="kpi-lbl">HTTP Error Rate</div></div>
      ` : ''}
    </div>
  </section>

  <section>
    <h2>Timing Breakdown</h2>
    <div class="timing-grid">
      ${timingKeys.map(k => {
        const t = timings[k];
        return `
      <div class="timing-card">
        <div class="timing-label">${t.label}</div>
        <div class="timing-avg">${t.avg}<span>ms avg</span></div>
        <div class="timing-sub">
          <div class="timing-sub-item"><div class="timing-sub-val" style="color:var(--success)">${t.min === Infinity ? '—' : t.min + 'ms'}</div><div class="timing-sub-lbl">Min</div></div>
          <div class="timing-sub-item"><div class="timing-sub-val">${t.p50}ms</div><div class="timing-sub-lbl">P50</div></div>
          <div class="timing-sub-item"><div class="timing-sub-val" style="color:var(--warn)">${t.p95}ms</div><div class="timing-sub-lbl">P95</div></div>
          <div class="timing-sub-item"><div class="timing-sub-val" style="color:var(--error)">${t.p99}ms</div><div class="timing-sub-lbl">P99</div></div>
          <div class="timing-sub-item"><div class="timing-sub-val" style="color:var(--error)">${t.max || '—'}ms</div><div class="timing-sub-lbl">Max</div></div>
          <div class="timing-sub-item"><div class="timing-sub-val">±${t.stdDev}ms</div><div class="timing-sub-lbl">σ</div></div>
        </div>
      </div>`;
      }).join('')}
    </div>
  </section>

  ${counterKeys && counterKeys.length ? `
  <section>
    <h2>Data Counters (per browser)</h2>
    <div class="timing-grid">
      ${counterKeys.map(k => {
        const c = counters[k];
        const isBytes = /bytes/i.test(k);
        const fmt = v => isBytes ? formatBytes(v) : String(v);
        return `
      <div class="timing-card">
        <div class="timing-label">${c.label}</div>
        <div class="timing-avg">${fmt(c.total)}<span>total</span></div>
        <div class="timing-sub">
          <div class="timing-sub-item"><div class="timing-sub-val">${fmt(c.avg)}</div><div class="timing-sub-lbl">Avg</div></div>
          <div class="timing-sub-item"><div class="timing-sub-val" style="color:var(--success)">${fmt(c.min)}</div><div class="timing-sub-lbl">Min</div></div>
          <div class="timing-sub-item"><div class="timing-sub-val" style="color:var(--error)">${fmt(c.max)}</div><div class="timing-sub-lbl">Max</div></div>
        </div>
      </div>`;
      }).join('')}
    </div>
  </section>` : ''}

  ${report.iterationReports && report.iterationReports.length > 1 ? (() => {
    const iters = report.iterationReports;
    const totalKey = timingKeys.includes('totalTime') ? 'totalTime' : timingKeys[timingKeys.length - 1];
    let cumOk = 0, cumTotal = 0;
    const rows = iters.map((ir, idx) => {
      const s = ir.summary;
      const t = totalKey && ir.timings[totalKey];
      cumOk    += s.successfulBrowsers;
      cumTotal += s.totalBrowsers;
      const cumRate = cumTotal ? (cumOk / cumTotal * 100).toFixed(1) : '0.0';
      const color = s.successRate >= 95 ? 'success' : s.successRate >= 80 ? 'warn' : 'error';
      return `<tr>
        <td><strong>${idx + 1}</strong></td>
        <td style="color:var(--${color})">${s.successfulBrowsers}/${s.totalBrowsers}</td>
        <td style="color:var(--${color})">${s.successRate}%</td>
        <td>${t ? t.avg + 'ms' : '—'}</td>
        <td>${t ? (t.min === Infinity ? '—' : t.min + 'ms') : '—'}</td>
        <td>${t ? t.max + 'ms' : '—'}</td>
        <td>${t ? t.p95 + 'ms' : '—'}</td>
        <td style="color:var(--muted)">${cumOk}/${cumTotal} (${cumRate}%)</td>
        <td>${s.durationSec}s</td>
      </tr>`;
    });
    const allT  = totalKey ? timings[totalKey] : null;
    const allColor = summary.successRate >= 95 ? 'success' : summary.successRate >= 80 ? 'warn' : 'error';
    rows.push(`<tr style="font-weight:700;background:var(--surface2)">
      <td>ALL</td>
      <td style="color:var(--${allColor})">${summary.successfulBrowsers}/${summary.totalBrowsers}</td>
      <td style="color:var(--${allColor})">${summary.successRate}%</td>
      <td style="color:var(--accent)">${allT ? allT.avg + 'ms' : '—'}</td>
      <td>${allT ? (allT.min === Infinity ? '—' : allT.min + 'ms') : '—'}</td>
      <td>${allT ? allT.max + 'ms' : '—'}</td>
      <td>${allT ? allT.p95 + 'ms' : '—'}</td>
      <td style="color:var(--muted)">—</td>
      <td>${(report.totalDuration / 1000).toFixed(2)}s</td>
    </tr>`);
    return `
  <section>
    <h2>Cumulative Iteration Summary</h2>
    <div class="table-wrap">
      <table class="results-table" style="font-size:0.82rem">
        <thead><tr>
          <th class="metric-col" style="min-width:60px">Iter</th>
          <th>OK / Total</th><th>Success %</th>
          <th>Avg Total</th><th>Min</th><th>Max</th><th>P95</th>
          <th>Cumulative OK</th><th>Duration</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>
  </section>`;
  })() : ''}

  <section>
    <h2>VM Summaries</h2>
    <div class="vm-grid">${vmCards}</div>
  </section>

  <section>
    <h2>Per-Browser Results</h2>
    <div class="table-wrap">
      <table class="results-table">
        <thead>
          <tr>
            <th class="metric-col">Metric</th>
            ${browserHeaderCells}
          </tr>
        </thead>
        <tbody>
          ${timingDataRows}
          ${counterDataRows}
          ${errorRow}
        </tbody>
      </table>
    </div>
  </section>
</div>
</body>
</html>`;
}

main().catch(e => { err(e.message); process.exit(1); });
