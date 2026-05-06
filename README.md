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

### On EACH remote VM:
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
