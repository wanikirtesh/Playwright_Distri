# Playwright LoadMesh

Run real browser sessions concurrently across multiple VMs and measure response times end-to-end.

---
![Playwright LoadMesh](./md/playwright-loadmesh.png) 
---

## Architecture

```
┌─────────────────────────────────────────────┐
│             COORDINATOR                     │
│   coordinator/coordinator.js                │
│   - Reads config (VMs + browsers count)     │
│   - Health-checks all agents                │
│   - Dispatches test commands in parallel    │
│   - Aggregates results + generates report   │
└────────────┬────────────┬───────────────────┘
             │            │
    ┌─────────▼──┐   ┌────▼────────┐
    │  AGENT     │   │  AGENT      │   ... more VMs
    │  VM 1      │   │  VM 2       │
    │  :3001     │   │  :3001      │
    │            │   │             │
    │ browser 1  │   │ browser 1   │
    │ browser 2  │   │ browser 2   │
    │ browser 3  │   │ browser 3   │
    └────────────┘   └─────────────┘
```

---

## Quick Start (Single Machine)

### Step 1 — Install dependencies
```bash
npm install
npx playwright install chromium
```

### Step 2 — Start the agent (in Terminal 1)
```bash
npm run agent
# or: node agent/agent.js --port=3001 --id=my-machine
```

### Step 3 — Run the coordinator (in Terminal 2)
```bash
npm run run
# or: node coordinator/coordinator.js --config=config.local.json
```

Results appear in the terminal and as an HTML report in `reports/`.

---

## Multi-VM Setup

### Option A — One-shot bootstrap from GitHub (recommended)

Use [scripts/setup-agent.sh](scripts/setup-agent.sh) to install everything and start the
agent as a systemd service in a single command. The script is **idempotent** — run
the same command for first install and for every subsequent code update.

**First run on a fresh Linux VM:**
```bash
curl -fsSL https://raw.githubusercontent.com/wanikirtesh/Playwright_Distri/main/scripts/setup-agent.sh -o setup-agent.sh
REPO_URL=https://github.com/wanikirtesh/Playwright_Distri.git \
AGENT_PORT=3001 AGENT_ID=vm-office-1 \
bash setup-agent.sh
```

**Subsequent runs (pull latest code & restart agent):**
```bash
bash ~/playwright_distri/scripts/setup-agent.sh
```

**Keep the script attached (wait instead of exiting):**
```bash
WAIT_MODE=logs bash ~/playwright_distri/scripts/setup-agent.sh
# or: WAIT_MODE=journal ...   (follow systemd journal)
# or: WAIT_MODE=wait ...      (block while service stays active)
```

What the script does (each step is idempotent):

1. Installs `git` and Node.js (LTS `20`) via `apt` / `dnf` / `yum` if missing.
2. Clones the repo on first run; otherwise `git fetch` + `reset --hard origin/$BRANCH`.
3. Runs `npm install` (no-op when already up to date).
4. Runs `npx playwright install --with-deps chromium` (skips already-installed browsers).
5. Writes `/etc/systemd/system/playwright-agent.service` and enables it so the agent:
   - starts automatically on boot
   - auto-restarts on crash (`Restart=always`)
   - logs to `~/playwright_distri/agent.log` and `journalctl`
6. Falls back to `nohup` + PID file on systems without systemd.
7. Health-checks `http://127.0.0.1:$AGENT_PORT/health` before exiting.

**Configurable env vars:**

| Variable       | Default                  | Description                                  |
|----------------|--------------------------|----------------------------------------------|
| `REPO_URL`     | —                        | Git URL (required on first run only)         |
| `BRANCH`       | `main`                   | Branch to track                              |
| `APP_DIR`      | `~/playwright_distri`    | Where to clone the repo                      |
| `AGENT_PORT`   | `3001`                   | Port the agent listens on                    |
| `AGENT_ID`     | `$(hostname)`            | Friendly id reported to the coordinator      |
| `NODE_MAJOR`   | `20`                     | Required Node.js major version               |
| `SERVICE_NAME` | `playwright-agent`       | systemd unit name                            |
| `WAIT_MODE`    | `exit`                   | Post-health behavior: `exit`, `logs`, `journal`, `wait` |

**Service operations:**
```bash
sudo systemctl restart playwright-agent
sudo systemctl status  playwright-agent
journalctl -u playwright-agent -f
tail -f ~/playwright_distri/agent.log
```

Open the port on the firewall (Ubuntu): `sudo ufw allow 3001/tcp`.

### Coordinator one-shot bootstrap

The same idea applies to the machine that dispatches tests. Use
[scripts/setup-coordinator.sh](scripts/setup-coordinator.sh) — also idempotent —
to install Node.js, clone/pull the repo, `npm install`, and immediately run
the coordinator against your config.

**First run:**
```bash
curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/main/scripts/setup-coordinator.sh -o setup-coordinator.sh
REPO_URL=https://github.com/<user>/<repo>.git \
CONFIG=config.json \
bash setup-coordinator.sh
```

**Subsequent runs (pulls latest code, then runs):**
```bash
CONFIG=config.json bash ~/playwright_distri/scripts/setup-coordinator.sh
```

**Setup only, no run:**
```bash
SKIP_RUN=1 bash ~/playwright_distri/scripts/setup-coordinator.sh
```

**Pass extra coordinator flags:**
```bash
EXTRA_ARGS='--browsers=5 --query="Playwright"' \
  bash ~/playwright_distri/scripts/setup-coordinator.sh
```

| Variable     | Default                | Description                              |
|--------------|------------------------|------------------------------------------|
| `REPO_URL`   | —                      | Git URL (required on first run only)     |
| `BRANCH`     | `main`                 | Branch to track                          |
| `APP_DIR`    | `~/playwright_distri`  | Where to clone the repo                  |
| `CONFIG`     | `config.json`          | Config file passed to coordinator        |
| `NODE_MAJOR` | `20`                   | Required Node.js major version           |
| `SKIP_RUN`   | `0`                    | Set `1` to install only, skip running    |
| `EXTRA_ARGS` | —                      | Extra CLI args forwarded to coordinator  |

> Unlike the agent, the coordinator is **not** installed as a systemd service —
> it runs on demand. Schedule it via `cron` / `systemd --user` timer if you
> want recurring runs, e.g. `0 * * * * bash ~/playwright_distri/scripts/setup-coordinator.sh >> ~/coord.log 2>&1`.

### Option B — Manual setup

```bash
# Copy the project
scp -r playwright-distributed/ user@192.168.1.10:~/

# SSH into the VM and start the agent
ssh user@192.168.1.10
cd playwright-distributed
npm install && npx playwright install chromium
node agent/agent.js --port=3001 --id=vm-office-1
```

### Edit config.json on your local machine:
```json
{
  "headless": true,
  "vms": [
    { "id": "local",      "host": "localhost",    "port": 3001, "browsers": 3 },
    { "id": "vm-office1", "host": "192.168.1.10", "port": 3001, "browsers": 2 },
    { "id": "vm-office2", "host": "192.168.1.11", "port": 3001, "browsers": 2 }
  ]
}
```

### Run the coordinator:
```bash
node coordinator/coordinator.js --config=config.json
```

---

## Configuration Options

### config.json fields

| Field         | Type    | Default               | Description                        |
|---------------|---------|-----------------------|------------------------------------|
| `headless`    | boolean | `true`                | Run browsers headless              |
| `reportFile`  | string  | `reports/report.json` | Where to save JSON report          |
| `timeout`     | number  | `90000`               | Timeout per VM in ms               |
| `scriptFile`  | string  | `src/runScript.js`    | Entry file that exports runScript  |
| `moduleFiles` | array   | `[]`                  | Extra JS files bundled before entry |
| `sharedConfigFile` | string | —                 | Path to one shared JSON for module params + test data distribution |
| `sharedConfig` | object | —                    | Inline shared JSON object (alternative to `sharedConfigFile`) |
| `enableAgentLogStream` | boolean | `true`        | Stream agent logs in real-time to coordinator console + file |
| `agentLogFile` | string | `reports/agent-live-<ts>.log` | File path for streamed agent logs on coordinator machine |
| `vms`         | array   | —                     | List of VM definitions             |

### VM object fields

| Field      | Type   | Description                              |
|------------|--------|------------------------------------------|
| `id`       | string | Friendly name shown in reports           |
| `host`     | string | IP address or hostname                   |
| `port`     | number | Port the agent is listening on (default 3001) |
| `browsers` | number | How many concurrent browsers to open     |

---

## CLI Usage (no config file)

```bash
# Single VM, inline flags
node coordinator/coordinator.js \
  --vms="localhost:3001" \
  --browsers=4 \
  --query="ChatGPT vs Playwright" \
  --headless=true

# Multiple VMs inline
node coordinator/coordinator.js \
  --vms="localhost:3001,192.168.1.10:3001,192.168.1.11:3001" \
  --browsers=3 \
  --query="Playwright"

# Modular script bundle (helpers + modules + entry)
node coordinator/coordinator.js \
  --config=config.local.json \
  --modules="src/modules/auth.js,src/modules/search.js,src/modules/assertions.js" \
  --script="src/scenarios/googleScenario.js"

# Shared config from a single JSON file
node coordinator/coordinator.js \
  --config=config.local.json \
  --shared=shared-data.example.json

# Disable live agent log streaming
node coordinator/coordinator.js \
  --config=config.local.json \
  --agent-log-stream=false

# Use a custom coordinator-side live agent log file
node coordinator/coordinator.js \
  --config=config.local.json \
  --agent-log-file=reports/my-agent-live.log
```

> Note: `--vms` inline applies the same `--browsers` count to all VMs. Use a config file for per-VM browser counts.

### Script bundling order

The coordinator now builds one runtime script in this order:

1. `src/lib.js` (shared framework/helpers)
2. each file from `moduleFiles` (or `--modules`) in the given order
3. `scriptFile` (or `--script`) as the final entry file

Only the entry file should set `module.exports = runScript`.

Example config:

```json
{
  "scriptFile": "src/scenarios/googleScenario.js",
  "moduleFiles": [
    "src/modules/auth.js",
    "src/modules/search.js",
    "src/modules/commonMetrics.js"
  ]
}
```

### Shared JSON Parameters And Data Distribution

Use one JSON file to control:

1. Global params applied to all modules
2. Per-module overrides
3. Distributed row-level data across all VMs, browsers, and iterations

Example: `shared-data.example.json`

```json
{
  "global": {
    "targetUrl": "https://my-app.example.com"
  },
  "modules": {
    "loginScript": {
      "targetUrl": "https://my-app.example.com/login"
    },
    "businessAnalysis": {
      "propertyId": "990001"
    }
  },
  "distribution": {
    "mode": "round-robin",
    "onExhausted": "wrap"
  },
  "data": [
    { "username": "user1", "password": "pass1", "propertyId": "990001" },
    { "username": "user2", "password": "pass2", "propertyId": "990002" }
  ]
}
```

How values are resolved for each module execution:

1. Base run config
2. `sharedConfig.global` (or `sharedConfig.defaults`)
3. `sharedConfig.modules.<moduleName>`
4. Distributed row from `sharedConfig.data`

The final layer wins, so row data can override module/global values.

Distribution is deterministic by global virtual-user index:

- `globalVuIndex = ((iteration - 1) * totalBrowsersPerIteration) + globalBrowserStart + localBrowserIndexZeroBased`

Modes:

- `round-robin` (default): uses `data[globalVuIndex % data.length]`
- `iteration-block`: assigns contiguous blocks by iteration
- `browser-sticky` (alias: `vm-browser-sticky`): pins each VM/browser slot to one row across all iterations

Sticky mode details:

- Row selection is based on browser slot, not iteration: `data[(vmGlobalStart + localBrowserIndexZeroBased)]` (then `onExhausted` policy applies)
- This keeps the same VM + browser index on the same row for every iteration
- Keep VM order and browser counts stable between runs if you need the same slot-to-row mapping across runs

Sticky mode example:

```json
{
  "distribution": {
    "mode": "browser-sticky",
    "onExhausted": "wrap"
  }
}
```

When data is exhausted:

- `wrap` (default): cycle back to start
- `skip`: no row injected
- `error`: fail fast

Each browser result now includes execution/distribution metadata (`executionContext` and `distribution`) so you can audit exactly which row each VU consumed.

### Access Shared Data Inside Module Files

You do not need any extra import. Each module already receives merged `config`.

Example (`src/pages/loginScript.js` style):

```js
module.exports = {
  test: async ({ step, metric, page, config, result, browserId }) => {
    const {
      targetUrl,
      username,
      password,
      propertyId,
      vu = {}
    } = config;

    // Optional: simple VU context (already prepared by coordinator)
    console.log(`[${browserId}] iter=${vu.iteration} vm=${vu.vmId} row=${vu.dataIndex}`);

    await step('navigation', () => page.goto(targetUrl, { waitUntil: 'domcontentloaded' }));
    await step('fillUser', () => page.fill('input[type="email"]', username));
    await step('fillPass', () => page.fill('input[type="password"]', password));

    metric('hasPropertyId', propertyId ? 1 : 0);
  },
};
```

Available in `config` for each module run:

- `targetUrl`, `username`, `password`, etc. (from merged shared JSON layers)
- `vu`: simple browser context object
- `vu.dataIndex`: selected row index from `data`
- `vu.datasetSize`: total rows in dataset
- `vu.distributionMode`: `round-robin`, `iteration-block`, or `browser-sticky`
- `vu.dataExhausted`: true when `onExhausted=skip` and no row assigned
- `vu.iteration`, `vu.vmId`, `vu.localBrowserIndex`, `vu.globalVuIndex`
- `dataRow`: the full assigned input row (same values that were merged into `config`)

Merge precedence reminder (later wins):

1. Base run config
2. `sharedConfig.global` (or `sharedConfig.defaults`)
3. `sharedConfig.modules.<moduleName>`
4. Assigned row in `sharedConfig.data`

So if `data` row has `username`, it overrides `modules.loginScript.username` and `global.username`.

### Module-Level Logging

Module test functions can now consume `log` directly from the context object.

```js
module.exports = {
  test: async ({ step, log, config, browserId }) => {
    log.info('Starting login flow', { browserId, propertyId: config.propertyId });
    await step('navigation', () => page.goto(config.baseUrl));
    log.warn('Navigation completed with warning threshold', { ttfbMs: 850 });
  },
};
```

Supported methods:

- `log(message, meta)` (same as `log.info`)
- `log.debug(message, meta)`
- `log.info(message, meta)`
- `log.warn(message, meta)`
- `log.error(message, meta)`

Module logs are:

- visible on agent console
- written to agent local log file (`AGENT_LOG_FILE`)
- streamed in real-time to coordinator when `enableAgentLogStream=true`
- stored in result JSON under `browserResults[].moduleLogs`

### Agent Logging Framework

Agent now has level-based logging with local file and optional real-time streaming to coordinator.

- Default local agent log file: `reports/agent.log` (on each agent VM)
- Configure with env vars on agent VM:
  - `AGENT_LOG_LEVEL` = `debug|info|warn|error`
  - `AGENT_LOG_FILE` = custom local path
- Real-time log streaming:
  - Coordinator exposes `POST /agent-log` on barrier host/port
  - Agent streams logs best-effort during active runs
  - Coordinator prints `[AGENT-RT] ...` lines and appends to `agentLogFile`

If log streaming cannot reach coordinator, agent execution continues (logging transport is fail-open).

---

## What Gets Measured

For each browser session:

| Metric             | Description                                    |
|--------------------|------------------------------------------------|
| `navigation`       | Time to load Google's homepage                 |
| `searchResponse`   | Time from pressing Enter to page load          |
| `resultsRendered`  | Time for search result elements to appear      |
| `totalTime`        | Sum of all three above                         |

The report also shows **min / max / avg / P95** across all browser sessions.

---

## Output

- **Terminal**: formatted table with per-VM and per-browser breakdown
- **JSON**: `reports/report-<timestamp>.json` — full structured data
- **HTML**: `reports/report-<timestamp>.html` — visual dashboard, open in browser

---

## Firewall / Network Notes

- Agents listen on `0.0.0.0` so they accept connections from any host
- Default port is `3001` — make sure it's open between coordinator and agents
- Open the port: `sudo ufw allow 3001/tcp` (Ubuntu)

---

## Running Multiple Agents on Same Machine (different ports)

```bash
# Terminal 1
node agent/agent.js --port=3001 --id=agent-A

# Terminal 2
node agent/agent.js --port=3002 --id=agent-B
```

```json
"vms": [
  { "id": "agent-A", "host": "localhost", "port": 3001, "browsers": 3 },
  { "id": "agent-B", "host": "localhost", "port": 3002, "browsers": 3 }
]
```
