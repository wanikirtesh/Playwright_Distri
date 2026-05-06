// ─── Shared helpers shipped with every script ────────────────────────────────
// NOTE: This file is concatenated with the user script by the coordinator and
// evaluated inside `new Function(...)` on the agent. Do NOT use `module.exports`
// or `require` here — only declare functions/consts that the script can call.

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
