// ─── Shared helpers shipped with every script ────────────────────────────────
// NOTE: This file is concatenated with the user script by the coordinator and
// evaluated inside `new Function('module','exports','require', ...)` on the
// agent. So `module.exports`, `exports`, and `require` are all available to
// the compiled bundle — but only the bottom user script should call
// `module.exports = runScript` to be picked up by the agent.

/**
 * Time an async interaction and store the duration on result.timings[key].
 *   await timed(result, 'navigation', () => page.goto(url), browserId);
 * Returns whatever fn() returns.
 */
async function timed(result, key, fn, browserId) {
  result.timings = result.timings || {};
  const start = Date.now();
  try {
    return await fn();
  } finally {
    result.timings[key] = Date.now() - start;
    const tag = browserId ? `[${browserId}] ` : '';
    console.log(`[${new Date().toISOString()}] [SCRIPT] ${tag}${key}: ${result.timings[key]}ms`);
  }
}

/** Sum a list of timing keys into result.timings[targetKey]. */
function sumTimings(result, keys, targetKey = 'totalTime') {
  result.timings = result.timings || {};
  result.timings[targetKey] = keys.reduce((a, k) => a + (result.timings[k] || 0), 0);
}

/**
 * Increment a numeric counter on result.counters[key] by `n` (default 1).
 * Use for things like bytes downloaded, items scraped, errors, etc.
 *   counter(result, 'bytesReceived', responseBodySize);
 *   counter(result, 'itemsScraped');
 */
function counter(result, key, n = 1) {
  result.counters = result.counters || {};
  result.counters[key] = (result.counters[key] || 0) + n;
}

/** Set an arbitrary numeric metric on result.counters[key] (overwrite). */
function setMetric(result, key, value) {
  result.counters = result.counters || {};
  result.counters[key] = value;
}

/**
 * Hook Playwright's `response` event to accumulate network metrics into
 * result.counters. Call ONCE per page (e.g. before page.goto).
 *
 * Captures:
 *   bytesReceived  – sum of response body bytes (best-effort)
 *   requestCount   – number of responses observed
 *   failedRequests – responses with status >= 400
 */
function trackNetwork(page, result) {
  result.counters = result.counters || {};
  result.counters.bytesReceived  = result.counters.bytesReceived  || 0;
  result.counters.requestCount   = result.counters.requestCount   || 0;
  result.counters.failedRequests = result.counters.failedRequests || 0;

  page.on('response', async (response) => {
    try {
      result.counters.requestCount++;
      if (response.status() >= 400) result.counters.failedRequests++;

      // Prefer Content-Length header (cheap, no body fetch); fall back to body().
      const headers = response.headers();
      const cl = parseInt(headers['content-length'] || '', 10);
      if (Number.isFinite(cl) && cl > 0) {
        result.counters.bytesReceived += cl;
        return;
      }
      const buf = await response.body().catch(() => null);
      if (buf) result.counters.bytesReceived += buf.length;
    } catch (_) { /* ignore — response may have been disposed */ }
  });
}

/**
 * Cross-VM rendezvous barrier. All browsers calling `barrier(result, label)`
 * with the same label across all VMs will be released together once the full
 * quorum arrives, OR after `timeoutMs` elapses (fail-open: stragglers are
 * skipped, never blocking the whole run).
 *
 *   await barrier(result, 'preSearch');
 *   await barrier(result, 'preCheckout', { timeoutMs: 5000 });
 *
 * On return, all participants synchronize to `releaseAt` (epoch ms) and then
 * proceed simultaneously. Records:
 *   result.timings['barrier_<label>']   – ms spent waiting (incl. release sleep)
 *   result.barriers[<label>]            – diagnostic info
 *
 * Requires `config.barrierUrl` to be present (passed by coordinator). If the
 * barrier URL is missing or the request fails, this is a no-op so scripts can
 * be run standalone without the coordinator.
 */
async function barrier(result, label, opts = {}) {
  const { config = {}, browserId = '?', timeoutMs } = opts;
  const url = opts.barrierUrl || config.barrierUrl || (typeof __BARRIER_URL__ !== 'undefined' ? __BARRIER_URL__ : null);

  result.barriers = result.barriers || {};
  result.timings  = result.timings  || {};

  if (!url) {
    result.barriers[label] = { skipped: true, reason: 'no barrierUrl' };
    return;
  }

  const arrivedAt = Date.now();
  const reqTimeout = (timeoutMs || opts.requestTimeoutMs || 60000) + 5000;

  let info;
  try {
    info = await postJson(url, { label, browserId, timeoutMs }, reqTimeout);
  } catch (e) {
    // Fail-open: continue the script even if the barrier server is unreachable
    result.barriers[label] = { skipped: true, reason: 'barrier error: ' + e.message, arrivedAt };
    result.timings['barrier_' + label] = Date.now() - arrivedAt;
    return;
  }

  // Sleep until the shared release timestamp so all participants resume together
  const sleep = (info.releaseAt || 0) - Date.now();
  if (sleep > 0) await new Promise(r => setTimeout(r, sleep));

  const releasedAt = Date.now();
  result.barriers[label] = {
    arrivedAt,
    releasedAt,
    waitedMs:  releasedAt - arrivedAt,
    arrivals:  info.arrivals,
    expected:  info.expected,
    timedOut:  !!info.timedOut,
    late:      !!info.late,
  };
  result.timings['barrier_' + label] = releasedAt - arrivedAt;
}

// Internal: tiny POST helper using whatever module the agent sandbox exposes.
function postJson(urlStr, body, timeoutMs = 65000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('barrier request timeout')); });
    req.write(data);
    req.end();
  });
}
