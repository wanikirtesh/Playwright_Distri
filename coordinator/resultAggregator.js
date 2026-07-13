const reporters = require('../src/reporters');

function aggregateResults(vmResults, unreachable, totalDuration) {
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

  const successResults = allBrowserResults.filter(r => r.status === 'success');
  const metricResults = allBrowserResults.filter(r => (r.timings && Object.keys(r.timings).length) || (r.counters && Object.keys(r.counters).length));
  const { allKeys: timingKeys, byTest: timingsByTest } = reporters.discoverTimingKeys(metricResults);

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
      label: reporters.humanizeKey(key),
      avg: avg(vals),
      min: vals.length ? Math.min(...vals) : Infinity,
      max: vals.length ? Math.max(...vals) : 0,
      p50: p50(vals),
      p95: p95(vals),
      p99: p99(vals),
      stdDev: stdDev(vals),
    };
  });

  const counterKeys = (() => {
    const seen = new Set();
    const order = [];
    metricResults.forEach(r => {
      Object.keys(r.counters || {}).forEach(k => {
        if (!seen.has(k)) {
          seen.add(k);
          order.push(k);
        }
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
      label: reporters.humanizeKey(key),
      total: sum(vals),
      avg: avg(vals),
      min: vals.length ? Math.min(...vals) : 0,
      max: vals.length ? Math.max(...vals) : 0,
      p50: p50(vals),
      p95: p95(vals),
    };
  });

  const totalBrowsers = allBrowserResults.length;
  const ok = successResults.length;
  const failed = allBrowserResults.filter(r => r.status === 'error').length;
  const durationSec = totalDuration / 1000;
  const successRate = totalBrowsers ? +(ok / totalBrowsers * 100).toFixed(1) : 0;
  const errorRate = totalBrowsers ? +(failed / totalBrowsers * 100).toFixed(1) : 0;
  const transactions = ok * timingKeys.length;
  const browsersPerSec = durationSec > 0 ? +(ok / durationSec).toFixed(2) : 0;
  const transactionsPerSec = durationSec > 0 ? +(transactions / durationSec).toFixed(2) : 0;
  const avgTotalTimeMs = timings[reporters.totalTimingKeyOf(timingKeys)]?.avg || 0;
  const avgConcurrency = durationSec > 0 && avgTotalTimeMs > 0
    ? +((ok * avgTotalTimeMs / 1000) / durationSec).toFixed(2)
    : 0;

  const totalBytes = counters.bytesReceived?.total || 0;
  const totalRequests = counters.requestCount?.total || 0;
  const failedReq = counters.failedRequests?.total || 0;
  const bytesPerSec = durationSec > 0 ? Math.round(totalBytes / durationSec) : 0;
  const requestsPerSec = durationSec > 0 ? +(totalRequests / durationSec).toFixed(2) : 0;
  const httpErrorRate = totalRequests ? +(failedReq / totalRequests * 100).toFixed(2) : 0;

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
      totalBytes,
      bytesPerSec,
      totalRequests,
      requestsPerSec,
      failedRequests: failedReq,
      httpErrorRate,
      durationMs: totalDuration,
      durationSec: +durationSec.toFixed(2),
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

module.exports = {
  aggregateResults,
};
