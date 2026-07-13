const http = require('http');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode);
  res.end(JSON.stringify(payload));
}

function createAgentServer({ port, agentId, log, runBrowsers, cleanupBrowsers, getActiveBrowserCount }) {
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        agentId,
        port,
        activeBrowsers: getActiveBrowserCount(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const config = JSON.parse(body);
          if (typeof log.setStreamTarget === 'function') {
            log.setStreamTarget(config.logStreamUrl || null);
          }
          if (typeof log.setRunId === 'function') {
            log.setRunId(config.runId || null);
          }
          log(`Received run command: ${config.browsers} browsers, headless=${config.headless}, ignoreHTTPSErrors=${config.ignoreHTTPSErrors}`);
          sendJson(res, 200, { status: 'started', agentId });
          runBrowsers(config).catch(e => log(`Error: ${e.message}`));
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/run-sync') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const config = JSON.parse(body);
          if (typeof log.setStreamTarget === 'function') {
            log.setStreamTarget(config.logStreamUrl || null);
          }
          if (typeof log.setRunId === 'function') {
            log.setRunId(config.runId || null);
          }
          log(`Running ${config.browsers} browsers synchronously...`);
          const results = await runBrowsers(config);
          sendJson(res, 200, { status: 'done', agentId, results });
        } catch (e) {
          sendJson(res, 500, { error: e.message, agentId });
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/cleanup') {
      await cleanupBrowsers();
      sendJson(res, 200, { status: 'cleaned', agentId });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

module.exports = {
  createAgentServer,
};
