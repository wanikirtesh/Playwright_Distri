const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

function stackPreview(err, maxLines = 6) {
  if (!err || !err.stack) return '';
  return String(err.stack).split('\n').slice(0, maxLines).join('\n');
}

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

function createRunLogger(log, context = {}) {
  function emit(level, message, meta) {
    const msg = typeof message === 'string' ? message : String(message);
    const mergedMeta = { ...context, ...(meta && typeof meta === 'object' ? meta : {}) };

    if (typeof log[level] === 'function') {
      log[level](msg, mergedMeta);
      return;
    }

    if (typeof log === 'function') {
      log(`[${String(level).toUpperCase()}] ${msg} ${JSON.stringify(mergedMeta)}`);
    }
  }

  const logger = (message, meta) => emit('info', message, meta);
  logger.debug = (message, meta) => emit('debug', message, meta);
  logger.info = (message, meta) => emit('info', message, meta);
  logger.warn = (message, meta) => emit('warn', message, meta);
  logger.error = (message, meta) => emit('error', message, meta);
  return logger;
}

function createBrowserRunner({ agentId, log }) {
  let activeBrowsers = [];

  function getActiveBrowserCount() {
    return activeBrowsers.length;
  }

  async function cleanupBrowsers() {
    log(`Cleaning up ${activeBrowsers.length} active browsers...`);
    await Promise.all(activeBrowsers.map(b => b.close().catch(() => undefined)));
    activeBrowsers = [];
  }

  async function reportResult(reportBackUrl, result) {
    if (!reportBackUrl) return;

    try {
      const reportUrl = new URL(reportBackUrl);
      const postData = JSON.stringify(result);
      const options = {
        hostname: reportUrl.hostname,
        port: reportUrl.port || 80,
        path: reportUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };
      const req = http.request(options);
      req.write(postData);
      req.end();
    } catch (e) {
      // Ignore report-back failures so local execution can continue.
    }
  }

  async function runBrowsers(config) {
    const {
      browsers = 1,
      headless = false,
      ignoreHTTPSErrors = true,
      reportBackUrl = null,
      scriptFile = 'unknown',
      moduleFiles = [],
      script = null,
      globalBrowserStart = 0,
      totalBrowsersPerIteration = browsers,
      iteration = 1,
      iterations = 1,
      vmId = agentId,
      vmHost = null,
      vmPort = null,
      browserInputs = [],
    } = config;

    if (!script) throw new Error('No script source received from coordinator');

    // Compile the script sent over the wire — module.exports pattern.
    // We expose require so helpers like barrier() can use http/https modules.
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    (new Function('module', 'exports', 'require', script))(mod, mod.exports, require);
    const runScript = mod.exports;

    const browserInstances = await Promise.all(
      Array.from({ length: browsers }, async (_, i) => {
        const browserId = `${agentId}-browser-${i + 1}`;
        log(`Launching browser ${i + 1}/${browsers} [${browserId}] in headless=${headless} mode...`);

        const result = {
          browserId,
          agentId,
          browserIndex: i + 1,
          status: 'running',
          timings: {},
          error: null,
        };

        try {
          const chromiumPath = process.env.CHROMIUM_PATH;
          const launchOpts = { headless };

          try {
            fs.accessSync(chromiumPath);
            launchOpts.executablePath = chromiumPath;
          } catch (e) {
            log(`CHROMIUM_PATH not set or invalid; using default Chromium from Playwright package.`);
          }

          const browser = await chromium.launch(launchOpts);
          activeBrowsers.push(browser);

          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            ignoreHTTPSErrors,
          });

          const page = await context.newPage();

          const globalVuIndex = ((iteration - 1) * totalBrowsersPerIteration) + globalBrowserStart + i;
          const executionContext = {
            agentId,
            vmId,
            vmHost,
            vmPort,
            iteration,
            iterations,
            localBrowserIndex: i + 1,
            globalBrowserIndex: globalBrowserStart + i + 1,
            globalVuIndex,
            totalBrowsersPerIteration,
          };

          const assigned = Array.isArray(browserInputs) ? browserInputs[i] : null;
          const runLogger = createRunLogger(log, {
            browserId,
            agentId,
            vmId,
            iteration,
            localBrowserIndex: i + 1,
          });

          result.executionContext = executionContext;
          result.vu = assigned && assigned.vu ? assigned.vu : executionContext;
          await runScript(
            page,
            {
              ...config,
              __executionContext: executionContext,
              __browserInput: assigned,
            },
            result,
            browserId,
            {
              log: runLogger,
              executionContext,
            }
          );
          result.status = 'success';

          await browser.close();
          activeBrowsers = activeBrowsers.filter(b => b !== browser);
          log(`[${browserId}] ✓ Done. Total: ${result.timings.totalTime}ms`);
        } catch (err) {
          result.status = 'error';
          result.error = err.message;
          if (!result.errorDetails) {
            result.errorDetails = toErrorDetails(err);
          }

          const failedScript = err && err.scriptName
            ? err.scriptName
            : (result.executedScripts && result.executedScripts.length)
            ? result.executedScripts[result.executedScripts.length - 1]
            : scriptFile;

          log(`[${browserId}] ✗ Error in script: ${failedScript}`);
          log(`[${browserId}]   entry script: ${scriptFile}`);
          if (Array.isArray(moduleFiles) && moduleFiles.length) {
            log(`[${browserId}]   modules: ${moduleFiles.join(', ')}`);
          }
          if (result.errorDetails.stackTop) {
            log(`[${browserId}]   stackTop: ${result.errorDetails.stackTop}`);
          }

          const preview = stackPreview(err);
          if (preview) {
            log(`[${browserId}]   stack:\n${preview}`);
          } else {
            log(`[${browserId}]   message: ${err.message}`);
          }
        }

        await reportResult(reportBackUrl, result);
        return result;
      })
    );

    return browserInstances;
  }

  return {
    runBrowsers,
    cleanupBrowsers,
    getActiveBrowserCount,
  };
}

module.exports = {
  createBrowserRunner,
};
