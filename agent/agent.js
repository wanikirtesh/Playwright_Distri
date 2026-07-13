#!/usr/bin/env node
/**
 * PLAYWRIGHT DISTRIBUTED AGENT
 * Run this on each VM: node agent/agent.js --port=3001
 * The coordinator connects to this agent and instructs it to open browsers.
 */

const { loadAgentConfig } = require('./lib/config');
const { createLogger } = require('./lib/logger');
const { createBrowserRunner } = require('./lib/browserRunner');
const { createAgentServer } = require('./lib/server');

const { port, agentId } = loadAgentConfig(process.argv);
const log = createLogger(agentId, {
  level: process.env.AGENT_LOG_LEVEL || 'info',
  filePath: process.env.AGENT_LOG_FILE || 'reports/agent.log',
});

const runner = createBrowserRunner({ agentId, log });
const server = createAgentServer({
  port,
  agentId,
  log,
  runBrowsers: runner.runBrowsers,
  cleanupBrowsers: runner.cleanupBrowsers,
  getActiveBrowserCount: runner.getActiveBrowserCount,
});

server.listen(port, '0.0.0.0', () => {
  log(`Agent listening on port ${port}`);
  log(`Health: http://localhost:${port}/health`);
  log(`Run:    POST http://localhost:${port}/run-sync`);
});

async function shutdown() {
  log('Shutting down...');
  await runner.cleanupBrowsers();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
