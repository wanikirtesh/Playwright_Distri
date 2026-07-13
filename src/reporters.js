/**
 * REPORTER MODULE
 * Handles report aggregation, formatting, and generation (console & HTML)
 */

// Convert a camelCase / snake_case key into a Title Case label
function humanizeKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Parse timing key to extract test name if prefixed (format: "testName.stepName")
 * Returns { testName, stepName } or { testName: null, stepName: key }
 */
function parseTimingKey(key) {
  const parts = key.split('.');
  if (parts.length > 1) {
    const testName = parts[0];
    const stepName = parts.slice(1).join('.');
    return { testName, stepName };
  }
  return { testName: null, stepName: key };
}

// Discover every timing key that appears on at least one browser result.
// Returns { allKeys: [...], byTest: { 'login': [...], null: [...] } }
function discoverTimingKeys(results) {
  const seen = new Set();
  const order = [];
  results.forEach(r => {
    Object.keys(r.timings || {}).forEach(k => {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    });
  });
  
  // Separate total keys (no test prefix or from last test) from others
  const byTest = {};
  order.forEach(k => {
    const { testName, stepName } = parseTimingKey(k);
    const groupKey = testName || null;
    if (!byTest[groupKey]) byTest[groupKey] = [];
    byTest[groupKey].push({ key: k, stepName });
  });
  
  // Sort: keys with test prefix first (by test name), then unprefixed
  const allKeys = [];
  const testNames = Object.keys(byTest).filter(t => t !== null).sort();
  testNames.forEach(t => byTest[t].forEach(item => allKeys.push(item.key)));
  if (byTest[null]) byTest[null].forEach(item => allKeys.push(item.key));
  
  return { allKeys, byTest };
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

  // Keep success-only set for success-rate KPIs.
  const successResults = allBrowserResults.filter(r => r.status === 'success');
  // Build metric matrix from any browser that reported numeric metrics,
  // including failed browsers that completed partial steps.
  const metricResults = allBrowserResults.filter(r => (r.timings && Object.keys(r.timings).length) || (r.counters && Object.keys(r.counters).length));
  const { allKeys: timingKeys, byTest: timingsByTest } = discoverTimingKeys(metricResults);

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
    const vals = metricResults
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
    metricResults.forEach(r => {
      Object.keys(r.counters || {}).forEach(k => {
        if (!seen.has(k)) { seen.add(k); order.push(k); }
      });
    });
    return order;
  })();

  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const counters = {};
  counterKeys.forEach(key => {
    const vals = metricResults
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
      targetUrl: undefined,   // Will be set by caller
      timestamp: new Date().toISOString(),
    },
    timingKeys,
    timingsByTest,
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

  let lastTestName = null;
  timingKeys.forEach(key => {
    const { testName, stepName } = parseTimingKey(key);
    
    // Print test header when switching tests
    if (testName !== lastTestName) {
      if (testName && lastTestName !== null) console.log('  ' + '─'.repeat(72));
      if (testName) console.log(`  [TEST: ${testName}]`);
      lastTestName = testName;
    }
    
    const t = timings[key];
    const isBold = stepName === 'totalTime' || key === 'totalTime';
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
    console.log(`  ${icon} [${r.vmId}] ${r.browserId}${r.status === 'success' ? '' : ` — ${r.error}`}`);
    const parts = timingKeys
      .filter(k => typeof r.timings?.[k] === 'number')
      .map(k => {
        const { testName, stepName } = parseTimingKey(k);
        const label = testName ? `${testName}.${timings[k].label}` : timings[k].label;
        return `${label}: ${r.timings[k]}ms`;
      });
    if (parts.length) console.log(`     ${parts.join(' | ')}`);
    if (r.topResults?.length) console.log(`     Top result: "${r.topResults[0]}"`);
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

// ─── HTML Report Generator ────────────────────────────────────────────────────
function generateHTML(report) {
  const { summary, timings, timingKeys, counters, counterKeys, vmSummaries, browserResults } = report;

  const totalTimingKey = timingKeys.includes('totalTime') ? 'totalTime' : timingKeys[timingKeys.length - 1];
  const headerAvgTotal = totalTimingKey ? timings[totalTimingKey].avg : 0;

  const browserHeaderCells = browserResults.map(r => `
        <th class="browser-col ${r.status}">
          <div class="bh-id">${r.browserId}</div>
          <div class="bh-vm">${r.vmId}</div>
          ${r.iteration != null ? `<div class="bh-iter">iter ${r.iteration}</div>` : ''}
          <div class="bh-status"><span class="badge ${r.status}">${r.status}</span></div>
        </th>`).join('');

  const timingDataRows = timingKeys.map((k, idx) => {
    const { testName, stepName } = parseTimingKey(k);
    const isTotal = stepName === 'totalTime' || k === totalTimingKey;
    
    // Add test header row if switching tests
    const prevKey = idx > 0 ? timingKeys[idx - 1] : null;
    const prevTestName = prevKey ? parseTimingKey(prevKey).testName : null;
    const testHeaderRow = testName && testName !== prevTestName ? `
      <tr class="test-header">
        <th class="metric-col test-name" colspan="100">
          <div class="test-name-label">${testName.toUpperCase()}</div>
        </th>
      </tr>` : '';
    
    const cells = browserResults.map(r => {
      const v = r.timings?.[k];
      const val = typeof v === 'number' ? `${v}ms` : '—';
      return `<td class="${typeof v === 'number' ? '' : 'muted'}">${isTotal && typeof v === 'number' ? `<strong>${val}</strong>` : val}</td>`;
    }).join('');
    const aggSummary = `avg ${timings[k].avg}ms · p95 ${timings[k].p95}ms · p99 ${timings[k].p99}ms · σ ${timings[k].stdDev}`;
    const metricLabel = testName ? `${testName}.${timings[k].label}` : timings[k].label;
    
    return testHeaderRow + `
      <tr class="${isTotal ? 'total-row' : ''}">
        <th class="metric-col" scope="row">
          <div class="metric-label">${metricLabel}</div>
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

  const counterDataRows = (counterKeys || []).map(k => {
    const c = counters[k];
    const isBytes = /bytes/i.test(k);
    const fmt = v => typeof v === 'number' ? (isBytes ? formatBytes(v) : String(v)) : '—';
    const cells = browserResults.map(r => {
      const v = r.counters?.[k];
      return `<td class="${typeof v === 'number' ? '' : 'muted'}">${fmt(v)}</td>`;
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

  .timing-table-wrap { background: var(--surface); }
  .timing-table th, .timing-table td { text-align: right; white-space: nowrap; }
  .timing-table th:first-child, .timing-table td:first-child { text-align: left; }
  .timing-table .metric-col { min-width: 260px; }
  .timing-table .timing-kind { min-width: 90px; text-align: center; color: var(--muted); }
  .timing-table tr.total-row td,
  .timing-table tr.total-row th { background: var(--surface2); font-weight: 700; }
  .timing-table tr.barrier-row td,
  .timing-table tr.barrier-row th { background: rgba(0, 229, 255, 0.06); color: #b7f8ff; }
  .timing-table tr.barrier-row td { font-size: 0.73rem; }
  .timing-table tr.barrier-row .metric-label { font-size: 0.68rem; letter-spacing: 0.4px; }
  .timing-table tr.barrier-row .metric-agg { font-size: 0.58rem; opacity: 0.9; }
  .timing-table tr.barrier-row .timing-kind { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 1px; color: #8fe8f5; }

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
    <div class="table-wrap timing-table-wrap">
      <table class="timing-table">
        <thead>
          <tr>
            <th class="metric-col">Metric</th>
            <th>Avg</th>
            <th>Min</th>
            <th>Max</th>
            <th>P50</th>
            <th>P95</th>
            <th>P99</th>
            <th>Std Dev</th>
            <th class="timing-kind">Type</th>
          </tr>
        </thead>
        <tbody>
          ${timingKeys.map(k => {
            const t = timings[k];
            const isTotal = k === totalTimingKey;
            const isBarrier = /^barrier_/i.test(k);
            const kind = isTotal ? 'Total' : isBarrier ? 'Barrier' : 'Step';
            return `
          <tr class="${isTotal ? 'total-row' : ''} ${isBarrier ? 'barrier-row' : ''}">
            <th class="metric-col" scope="row">
              <div class="metric-label">${t.label}</div>
              <div class="metric-agg">${isBarrier ? 'Sync wait across browsers/VMs' : 'Measured execution duration'}</div>
            </th>
            <td>${t.avg}ms</td>
            <td>${t.min === Infinity ? '—' : t.min + 'ms'}</td>
            <td>${t.max || '—'}ms</td>
            <td>${t.p50}ms</td>
            <td>${t.p95}ms</td>
            <td>${t.p99}ms</td>
            <td>±${t.stdDev}ms</td>
            <td class="timing-kind">${kind}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
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

module.exports = {
  humanizeKey,
  discoverTimingKeys,
  totalTimingKeyOf,
  formatBytes,
  aggregateResults,
  printReport,
  generateHTML,
};
