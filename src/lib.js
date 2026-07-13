// ─── Shared helpers shipped with every script ────────────────────────────────
// NOTE: This file is concatenated with bundled script files by the coordinator
// and evaluated inside `new Function('module','exports','require', ...)` on the
// agent. Each configured module file is wrapped in its own local CommonJS scope
// so its `module.exports` can be registered independently, then the final entry
// script is wrapped into a single runner that executes all registered scripts.

const __bundledScriptRegistry = [];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfigLayers(...layers) {
  const out = {};
  layers.forEach(layer => {
    if (!isPlainObject(layer)) return;
    Object.keys(layer).forEach(k => {
      if (k === '__sharedMeta' || k === '__browserInput' || k === '__executionContext') return;
      out[k] = layer[k];
    });
  });
  return out;
}

function readSharedConfig(config) {
  return isPlainObject(config && config.sharedConfig) ? config.sharedConfig : {};
}

function buildScriptConfig(baseConfig, scriptName, result, browserId) {
  const sharedConfig = readSharedConfig(baseConfig);
  const globals = isPlainObject(sharedConfig.global)
    ? sharedConfig.global
    : (isPlainObject(sharedConfig.defaults) ? sharedConfig.defaults : {});
  const moduleMap = isPlainObject(sharedConfig.modules) ? sharedConfig.modules : {};
  const moduleOverrides = isPlainObject(moduleMap[scriptName]) ? moduleMap[scriptName] : {};

  const browserInput = isPlainObject(baseConfig.__browserInput) ? baseConfig.__browserInput : {};
  const rowLayer = isPlainObject(browserInput.input) ? browserInput.input : {};

  const executionContext = isPlainObject(baseConfig.__executionContext)
    ? baseConfig.__executionContext
    : {};

  const effective = mergeConfigLayers(baseConfig, globals, moduleOverrides, rowLayer);
  const vu = isPlainObject(browserInput.vu) ? browserInput.vu : executionContext;

  effective.vu = vu;
  effective.dataRow = rowLayer;
  effective.__sharedMeta = {
    scriptName,
    browserId,
    dataIndex: vu.dataIndex,
    datasetSize: vu.datasetSize,
    distributionMode: vu.distributionMode,
    dataExhausted: vu.dataExhausted,
    executionContext,
  };
  effective.__executionContext = executionContext;

  result.distribution = result.distribution || {
    mode: vu.distributionMode,
    dataIndex: vu.dataIndex,
    datasetSize: vu.datasetSize,
    dataExhausted: vu.dataExhausted,
    globalVuIndex: executionContext.globalVuIndex,
    iteration: executionContext.iteration,
    vmId: executionContext.vmId,
    localBrowserIndex: executionContext.localBrowserIndex,
  };

  return effective;
}

function createScriptLogger(runtimeCtx, result, scriptName, browserId) {
  const forward = runtimeCtx && typeof runtimeCtx.log === 'function' ? runtimeCtx.log : null;

  result.moduleLogs = result.moduleLogs || [];

  function write(level, message, meta) {
    const msg = typeof message === 'string' ? message : String(message);
    const entry = {
      at: new Date().toISOString(),
      level: String(level || 'info').toLowerCase(),
      scriptName,
      browserId,
      message: msg,
      meta: isPlainObject(meta) ? meta : undefined,
    };

    result.moduleLogs.push(entry);

    if (forward) {
      if (typeof forward[entry.level] === 'function') {
        forward[entry.level](`[${scriptName}] ${msg}`, entry.meta);
      } else {
        forward(`[${scriptName}] ${msg}`, { level: entry.level, ...(entry.meta || {}) });
      }
    } else {
      const metaPart = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
      console.log(`[${entry.at}] [MODULE:${entry.scriptName}] [${entry.level.toUpperCase()}] [${browserId}] ${msg}${metaPart}`);
    }
  }

  const logger = (message, meta) => write('info', message, meta);
  logger.debug = (message, meta) => write('debug', message, meta);
  logger.info = (message, meta) => write('info', message, meta);
  logger.warn = (message, meta) => write('warn', message, meta);
  logger.error = (message, meta) => write('error', message, meta);
  return logger;
}

/**
 * Wrap a test object into a runScript-compatible function.
 * Test object format: { name?, test, defaultMetrics?, timingKeys?, totalKey?, trackNetwork? }
 * 
 * All properties are optional:
 * - name: defaults to registryName (filename without extension)
 * - defaultMetrics: defaults to {} (lazy initialization)
 * - timingKeys: auto-discovered from executed steps (no need to specify)
 * - totalKey: defaults to 'totalTime'
 * - trackNetwork: defaults to true
 */
function wrapTestObject(testObj, registryName) {
  const {
    name = registryName || 'test',
    test,
    defaultMetrics = {},
    timingKeys = [],  // If provided, use it; otherwise auto-discover
    totalKey = 'totalTime',
    trackNetwork = true,
  } = testObj;

  if (typeof test !== 'function') return null;

  return async function wrappedRunScript(page, config, result, browserId, runtimeCtx) {
    // Track which test is running so timings can be prefixed
    result.currentTestName = name;
    const scriptLog = createScriptLogger(runtimeCtx, result, name, browserId);
    
    const fw = createScriptFramework(page, config, result, browserId, {
      defaultMetrics,
      trackNetwork,
      testName: name,
      log: scriptLog,
    });

    // If timingKeys not explicitly provided, don't specify it — let framework auto-discover
    const runOpts = { totalKey, testName: name };
    if (timingKeys.length) runOpts.timingKeys = timingKeys;

    await fw.run(
      async ({ step, sync, metric, count, log }) => {
        await test({ step, sync, metric, count, log, page, config, result, browserId });
      },
      runOpts
    );
  };
}

function normalizeBundledScriptExport(exportedValue, registryName) {
  // If it's already a function (old format with runScript signature)
  if (typeof exportedValue === 'function') return exportedValue;

  // If it's a test object with `test` property (new simple format)
  if (exportedValue && typeof exportedValue.test === 'function') {
    return wrapTestObject(exportedValue, registryName);
  }

  // Fallback: runScript property or default export
  if (exportedValue && typeof exportedValue.runScript === 'function') return exportedValue.runScript;
  if (exportedValue && typeof exportedValue.default === 'function') return exportedValue.default;

  return null;
}

function registerBundledScript(name, exportedValue) {
  const runner = normalizeBundledScriptExport(exportedValue, name);
  if (!runner) return;
  __bundledScriptRegistry.push({ name, run: runner });
}

function createBundledRunner(entryExport, entryName) {
  const entryRunner = normalizeBundledScriptExport(entryExport, entryName);

  return async function bundledRunScript(page, config, result, browserId, runtimeCtx = {}) {
    const registeredScripts = __bundledScriptRegistry.slice();
    if (entryRunner) registeredScripts.push({ name: entryName || 'entry', run: entryRunner });

    result.executedScripts = result.executedScripts || [];

    for (const scriptDef of registeredScripts) {
      result.executedScripts.push(scriptDef.name);
      try {
        const scriptConfig = buildScriptConfig(config, scriptDef.name, result, browserId);
        const scriptLog = createScriptLogger(runtimeCtx, result, scriptDef.name, browserId);
        await scriptDef.run(
          page,
          scriptConfig,
          result,
          browserId,
          {
            ...runtimeCtx,
            scriptName: scriptDef.name,
            log: scriptLog,
          }
        );
      } catch (err) {
        if (err && typeof err === 'object') {
          err.scriptName = scriptDef.name;
          if (typeof err.message === 'string' && !err.message.startsWith(`[${scriptDef.name}]`)) {
            err.message = `[${scriptDef.name}] ${err.message}`;
          }
        }
        throw err;
      }
    }
  };
}

/**
 * Time an async interaction and store the duration on result.timings[key].
 *   await timed(result, 'navigation', () => page.goto(url), browserId);
 * Returns whatever fn() returns.
 * If result.currentTestName is set, prefix key with "testName."
 */
async function timed(result, key, fn, browserId) {
  result.timings = result.timings || {};
  
  // Prefix with test name if available
  const finalKey = result.currentTestName ? `${result.currentTestName}.${key}` : key;
  
  const start = Date.now();
  try {
    return await fn();
  } finally {
    result.timings[finalKey] = Date.now() - start;
    const tag = browserId ? `[${browserId}] ` : '';
    console.log(`[${new Date().toISOString()}] [SCRIPT] ${tag}${finalKey}: ${result.timings[finalKey]}ms`);
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

/** Normalize thrown values into a structured error payload for reports. */
function toErrorDetails(err) {
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack) : '';
  return {
    name: (err && err.name) || 'Error',
    message,
    stack,
    stackTop: stack ? (stack.split('\n')[1] || '').trim() : '',
    at: new Date().toISOString(),
  };
}

/**
 * Lightweight test framework for script authors.
 *
 * Usage:
 *   const fw = createScriptFramework(page, config, result, browserId, {
 *     defaultMetrics: { itemsScraped: 0 },
 *   });
 *
 *   await fw.run(async ({ step, sync, metric }) => {
 *     await step('navigation', () => page.goto(url));
 *     await sync('preSearch');
 *     metric('itemsScraped', 3);
 *   }, { timingKeys: ['navigation'] });
 */
function createScriptFramework(page, config, result, browserId, opts = {}) {
  const scriptStartAt = Date.now();
  const executedTimingKeys = [];

  result.timings = result.timings || {};
  result.counters = result.counters || {};

  const defaults = {
    scriptFailed: 0,
    errorCount: 0,
    ...(opts.defaultMetrics || {}),
  };
  Object.keys(defaults).forEach(k => setMetric(result, k, defaults[k]));

  if (opts.trackNetwork !== false) trackNetwork(page, result);

  const step = async (key, fn) => {
    if (!executedTimingKeys.includes(key)) executedTimingKeys.push(key);
    return timed(result, key, fn, browserId);
  };

  const sync = async (label, barrierOpts = {}) =>
    barrier(result, label, { config, browserId, ...barrierOpts });

  const metric = (key, value) => setMetric(result, key, value);
  const count = (key, n = 1) => counter(result, key, n);
  const moduleLog = typeof opts.log === 'function'
    ? opts.log
    : ((message, meta) => {
        const metaPart = isPlainObject(meta) ? ` ${JSON.stringify(meta)}` : '';
        console.log(`[${new Date().toISOString()}] [MODULE] [${browserId}] ${String(message)}${metaPart}`);
      });

  if (typeof moduleLog.debug !== 'function') moduleLog.debug = moduleLog;
  if (typeof moduleLog.info !== 'function') moduleLog.info = moduleLog;
  if (typeof moduleLog.warn !== 'function') moduleLog.warn = moduleLog;
  if (typeof moduleLog.error !== 'function') moduleLog.error = moduleLog;

  const finalize = ({ timingKeys, totalKey = 'totalTime' } = {}) => {
    const keys = Array.isArray(timingKeys) && timingKeys.length ? timingKeys : executedTimingKeys;
    if (keys.length) {
      const presentKeys = keys.filter(k => Number.isFinite(result.timings[k]));
      if (presentKeys.length) sumTimings(result, presentKeys, totalKey);
    }

    // For fail-fast runs, wall-clock elapsed time is a more truthful total.
    if (result.counters.scriptFailed === 1) {
      result.timings[totalKey] = Date.now() - scriptStartAt;
      return;
    }

    // Ensure reports always have a total time, even if no timed step completed.
    if (!Number.isFinite(result.timings[totalKey])) {
      result.timings[totalKey] = Date.now() - scriptStartAt;
    }
  };

  const run = async (fn, runOpts = {}) => {
    try {
      await fn({ step, sync, metric, count, log: moduleLog, page, config, result, browserId });
      finalize(runOpts);
    } catch (err) {
      result.errorDetails = toErrorDetails(err);
      setMetric(result, 'scriptFailed', 1);
      setMetric(result, 'errorCount', (result.counters.errorCount || 0) + 1);
      finalize(runOpts);
      throw err;
    }
  };

  return { step, sync, metric, count, log: moduleLog, finalize, run };
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
