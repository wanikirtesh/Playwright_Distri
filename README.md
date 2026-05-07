# Playwright Distributed Performance Tester

Run real browser sessions concurrently across multiple VMs and measure response times end-to-end.

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
curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/main/scripts/setup-agent.sh -o setup-agent.sh
REPO_URL=https://github.com/<user>/<repo>.git \
AGENT_PORT=3001 AGENT_ID=vm-office-1 \
bash setup-agent.sh
```

**Subsequent runs (pull latest code & restart agent):**
```bash
bash ~/playwright_distri/scripts/setup-agent.sh
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
  "searchQuery": "Playwright",
  "targetUrl": "https://www.google.com",
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
| `searchQuery` | string  | `"Playwright"`        | What to search for on Google       |
| `targetUrl`   | string  | `"https://www.google.com"` | URL to open                   |
| `headless`    | boolean | `true`                | Run browsers headless              |
| `reportFile`  | string  | `reports/report.json` | Where to save JSON report          |
| `timeout`     | number  | `90000`               | Timeout per VM in ms               |
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
```

> Note: `--vms` inline applies the same `--browsers` count to all VMs. Use a config file for per-VM browser counts.

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
