const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(level) {
  const name = String(level || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, name) ? name : 'info';
}

function shouldLog(currentLevel, targetLevel) {
  return LEVELS[targetLevel] >= LEVELS[currentLevel];
}

function fireAndForgetPost(urlString, payload, timeoutMs = 1500) {
  if (!urlString) return;

  try {
    const u = new URL(urlString);
    const client = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);

    const req = client.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search || ''}`,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });

    req.on('error', () => {});
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
    });
    req.write(body);
    req.end();
  } catch {
    // ignore log transport failures
  }
}

function createLogger(agentId, options = {}) {
  const state = {
    level: normalizeLevel(options.level || process.env.AGENT_LOG_LEVEL || 'info'),
    filePath: options.filePath || process.env.AGENT_LOG_FILE || null,
    streamUrl: options.streamUrl || null,
    streamTimeoutMs: Number(options.streamTimeoutMs || process.env.AGENT_LOG_STREAM_TIMEOUT_MS || 1500),
    runId: null,
  };

  if (state.filePath) {
    const dir = path.dirname(state.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore file logger setup errors
    }
  }

  function write(level, message, meta) {
    const normalized = normalizeLevel(level);
    if (!shouldLog(state.level, normalized)) return;

    const at = new Date().toISOString();
    const entry = {
      at,
      level: normalized,
      agentId,
      runId: state.runId,
      message: typeof message === 'string' ? message : String(message),
      meta: meta && typeof meta === 'object' ? meta : undefined,
    };

    const line = `[${entry.at}] [${entry.agentId}] [${entry.level.toUpperCase()}]${entry.runId ? ` [${entry.runId}]` : ''} ${entry.message}`;
    const metaLine = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';

    console.log(`${line}${metaLine}`);

    if (state.filePath) {
      fs.appendFile(state.filePath, `${line}${metaLine}\n`, () => {});
    }

    if (state.streamUrl) {
      fireAndForgetPost(state.streamUrl, entry, state.streamTimeoutMs);
    }
  }

  const log = function log(message, meta) {
    write('info', message, meta);
  };

  log.debug = (message, meta) => write('debug', message, meta);
  log.info = (message, meta) => write('info', message, meta);
  log.warn = (message, meta) => write('warn', message, meta);
  log.error = (message, meta) => write('error', message, meta);

  log.setLevel = (level) => {
    state.level = normalizeLevel(level);
  };

  log.setFilePath = (filePath) => {
    state.filePath = filePath;
    if (!state.filePath) return;
    try {
      fs.mkdirSync(path.dirname(state.filePath), { recursive: true });
    } catch {
      // ignore
    }
  };

  log.setStreamTarget = (streamUrl) => {
    state.streamUrl = streamUrl || null;
  };

  log.setRunId = (runId) => {
    state.runId = runId || null;
  };

  return log;
}

module.exports = {
  createLogger,
};
