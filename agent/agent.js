#!/usr/bin/env node
/**
 * PLAYWRIGHT DISTRIBUTED AGENT
 * Run this on each VM: node agent/agent.js --port=3001
 * The coordinator connects to this agent and instructs it to open browsers.
 */

const http = require('http');
const { chromium } = require('playwright');

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3001');
const AGENT_ID = process.argv.find(a => a.startsWith('--id='))?.split('=')[1] || `agent-${PORT}`;

let activeBrowsers = [];

const log = (msg) => console.log(`[${new Date().toISOString()}] [${AGENT_ID}] ${msg}`);

// ─── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', agentId: AGENT_ID, port: PORT, activeBrowsers: activeBrowsers.length }));
    return;
  }

  // Run test
  if (req.method === 'POST' && url.pathname === '/run') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const config = JSON.parse(body);
        log(`Received run command: ${config.browsers} browsers, query="${config.searchQuery}"`);
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'started', agentId: AGENT_ID }));
        // Run async after responding
        runBrowsers(config).catch(e => log(`Error: ${e.message}`));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Stream results (long-poll)
  if (req.method === 'POST' && url.pathname === '/run-sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const config = JSON.parse(body);
        log(`Running ${config.browsers} browsers synchronously...`);
        const results = await runBrowsers(config);
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'done', agentId: AGENT_ID, results }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message, agentId: AGENT_ID }));
      }
    });
    return;
  }

  // Cleanup
  if (req.method === 'POST' && url.pathname === '/cleanup') {
    await cleanupBrowsers();
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'cleaned', agentId: AGENT_ID }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Browser Runner ──────────────────────────────────────────────────────────
async function runBrowsers(config) {
  const {
    browsers = 2,
    searchQuery = 'Playwright',
    targetUrl = 'https://www.google.com',
    headless = false,
    ignoreHTTPSErrors = true,
    reportBackUrl = null,
    script = null
  } = config;

  if (!script) throw new Error('No script source received from coordinator');
  // Compile the script sent over the wire — module.exports pattern.
  // We expose `require` so helpers like barrier() can use http/https modules.
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  (new Function('module', 'exports', 'require', script))(mod, mod.exports, require);
  const runScript = mod.exports;

  const results = [];

  const browserInstances = await Promise.all(
    Array.from({ length: browsers }, async (_, i) => {
      const browserId = `${AGENT_ID}-browser-${i + 1}`;
      log(`Launching browser ${i + 1}/${browsers} [${browserId}] in headless=${headless} mode...`);

      const result = {
        browserId,
        agentId: AGENT_ID,
        browserIndex: i + 1,
        status: 'running',
        timings: {},
        error: null
      };

      try {
        const _chromiumPath = process.env.CHROMIUM_PATH || '/home/claude/.cache/puppeteer/chrome-headless-shell/linux-131.0.6778.204/chrome-headless-shell-linux64/chrome-headless-shell';
        const _launchOpts = { 
          headless:headless,
        };
        try { require('fs').accessSync(_chromiumPath); _launchOpts.executablePath = _chromiumPath; } catch (e) {}
        const browser = await chromium.launch(_launchOpts);
        activeBrowsers.push(browser);

        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          ignoreHTTPSErrors
        });


        
        const page = await context.newPage();

        // ── Run browser interactions ──
        await runScript(page, config, result, browserId);
        result.status = 'success';

        await browser.close();
        activeBrowsers = activeBrowsers.filter(b => b !== browser);
        log(`[${browserId}] ✓ Done. Total: ${result.timings.totalTime}ms`);

      } catch (err) {
        result.status = 'error';
        result.error = err.message;
        log(`[${browserId}] ✗ Error: ${err.message}`);
      }

      results.push(result);

      // Report back to coordinator if URL provided
      if (reportBackUrl) {
        try {
          const reportUrl = new URL(reportBackUrl);
          const postData = JSON.stringify(result);
          const options = {
            hostname: reportUrl.hostname,
            port: reportUrl.port || 80,
            path: reportUrl.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
          };
          const req = http.request(options);
          req.write(postData);
          req.end();
        } catch (e) { /* ignore report errors */ }
      }

      return result;
    })
  );

  return browserInstances;
}

async function cleanupBrowsers() {
  log(`Cleaning up ${activeBrowsers.length} active browsers...`);
  await Promise.all(activeBrowsers.map(b => b.close().catch(() => {})));
  activeBrowsers = [];
}

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  log(`Agent listening on port ${PORT}`);
  log(`Health: http://localhost:${PORT}/health`);
  log(`Run:    POST http://localhost:${PORT}/run-sync`);
});

process.on('SIGINT', async () => {
  log('Shutting down...');
  await cleanupBrowsers();
  process.exit(0);
});
