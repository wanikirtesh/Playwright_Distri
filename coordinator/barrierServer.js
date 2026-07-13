const http = require('http');

function createBarrierServer(options) {
  const {
    host = 'localhost',
    port = 4000,
    defaultTimeout = 90000,
    log = () => {},
    onAgentLog = null,
  } = options || {};

  const barrierState = new Map();
  let barrierExpected = 0;

  function ensureBarrier(label, expected, timeoutMs) {
    let state = barrierState.get(label);
    if (!state) {
      state = {
        label,
        arrivals: 0,
        expected,
        pending: [],
        deadlineAt: null,
        released: false,
        releaseAt: null,
        timer: null,
        timedOut: false,
      };
      barrierState.set(label, state);
    }

    if (expected > state.expected) state.expected = expected;
    if (!state.deadlineAt) {
      state.deadlineAt = Date.now() + timeoutMs;
      state.timer = setTimeout(() => releaseBarrier(label, true), timeoutMs);
    }

    return state;
  }

  function respondBarrier(res, state, browserId, late) {
    const body = JSON.stringify({
      label: state.label,
      arrivals: state.arrivals,
      expected: state.expected,
      timedOut: state.timedOut,
      late,
      releaseAt: state.releaseAt,
      browserId,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  function releaseBarrier(label, timedOut = false) {
    const state = barrierState.get(label);
    if (!state || state.released) return;

    state.released = true;
    state.timedOut = timedOut;
    state.releaseAt = Date.now() + 50;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    log(`barrier "${label}" ${timedOut ? 'TIMED OUT' : 'released'} — ${state.arrivals}/${state.expected} arrived`);
    state.pending.forEach(({ res, browserId }) => respondBarrier(res, state, browserId, false));
    state.pending = [];
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/agent-log')) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          if (typeof onAgentLog === 'function') {
            onAgentLog(payload);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid log payload' }));
        }
      });
      return;
    }

    if (req.method !== 'POST' || !req.url.startsWith('/barrier')) {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = {};
      }

      const label = payload.label || 'default';
      const browserId = payload.browserId || '?';
      const timeoutMs = Math.max(100, payload.timeoutMs || defaultTimeout);

      const state = ensureBarrier(label, barrierExpected, timeoutMs);
      if (state.released) {
        respondBarrier(res, state, browserId, true);
        return;
      }

      state.arrivals++;
      state.pending.push({ res, browserId });

      res.on('close', () => {
        if (!state.released) {
          state.pending = state.pending.filter(p => p.res !== res);
        }
      });

      if (state.arrivals >= state.expected) {
        releaseBarrier(label, false);
      }
    });

    req.on('error', () => {
      try {
        res.writeHead(500);
        res.end();
      } catch {}
    });
  });

  function setExpected(expected) {
    barrierExpected = expected;
  }

  function resetForIteration(expected) {
    barrierState.clear();
    barrierExpected = expected;
  }

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        log(`Barrier server listening on http://${host}:${port}/barrier  (expected=${barrierExpected}, timeout=${defaultTimeout}ms)`);
        resolve();
      });
    });
  }

  function stop() {
    for (const label of barrierState.keys()) releaseBarrier(label, true);
    return new Promise(resolve => server.close(() => resolve()));
  }

  return {
    start,
    stop,
    setExpected,
    resetForIteration,
  };
}

module.exports = {
  createBarrierServer,
};
