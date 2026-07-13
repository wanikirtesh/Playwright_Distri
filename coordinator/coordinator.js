#!/usr/bin/env node
/**
 * PLAYWRIGHT DISTRIBUTED COORDINATOR
 *
 * Usage:
 *   node coordinator/coordinator.js --config=config.json
 *
 * Or inline:
 *   node coordinator/coordinator.js \
 *     --vms="localhost:3001,192.168.1.10:3001" \
 *     --browsers=3 \
 *     --query="Playwright"
 */

const fs = require('fs');
const path = require('path');
const reporters = require('../src/reporters');
const { httpPost, httpGet } = require('./httpClient');
const { buildBundledScript, parseCsv } = require('./scriptBundler');
const { createBarrierServer } = require('./barrierServer');
const { aggregateResults } = require('./resultAggregator');

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveOptionalPath(rawPath, baseDir) {
  if (!rawPath) return null;
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(baseDir, rawPath);
}

function readJsonFile(filePath, label) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse ${label} JSON at ${filePath}: ${e.message}`);
  }
}

function createAgentLogSink({ enabled, filePath }) {
  if (!enabled) {
    return {
      filePath: null,
      onAgentLog: () => {},
    };
  }

  const resolvedFile = path.resolve(filePath || `reports/agent-live-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(resolvedFile), { recursive: true });

  return {
    filePath: resolvedFile,
    onAgentLog: (entry) => {
      const at = entry && entry.at ? entry.at : new Date().toISOString();
      const level = String((entry && entry.level) || 'info').toUpperCase();
      const agentId = entry && entry.agentId ? entry.agentId : '?';
      const runId = entry && entry.runId ? ` [${entry.runId}]` : '';
      const message = entry && entry.message ? entry.message : '';
      const meta = entry && entry.meta && typeof entry.meta === 'object' ? ` ${JSON.stringify(entry.meta)}` : '';
      const line = `[${at}] [AGENT:${agentId}] [${level}]${runId} ${message}${meta}`;

      console.log(`\x1b[35m[AGENT-RT]\x1b[0m ${line}`);
      fs.appendFile(resolvedFile, `${line}\n`, () => {});
    },
  };
}

function readDistributionDataset(shared) {
  if (!isObject(shared)) return [];
  if (Array.isArray(shared.data)) return shared.data;
  if (Array.isArray(shared.dataset)) return shared.dataset;
  if (Array.isArray(shared.rows)) return shared.rows;
  return [];
}

function normalizeDistribution(shared) {
  const dist = isObject(shared && shared.distribution) ? shared.distribution : {};
  return {
    mode: String(dist.mode || dist.strategy || 'round-robin').toLowerCase(),
    onExhausted: String(dist.onExhausted || 'wrap').toLowerCase(),
  };
}

function selectDataIndex({
  mode,
  onExhausted,
  datasetSize,
  globalVuIndex,
  browserSlotIndex,
  iteration,
  totalBrowsersPerIteration,
}) {
  if (!datasetSize) {
    return {
      dataIndex: null,
      dataExhausted: false,
      error: null,
    };
  }

  let rawIndex;
  if (mode === 'iteration-block') {
    const blockStart = (iteration - 1) * totalBrowsersPerIteration;
    rawIndex = blockStart + (globalVuIndex % Math.max(totalBrowsersPerIteration, 1));
  } else if (mode === 'browser-sticky' || mode === 'vm-browser-sticky') {
    rawIndex = browserSlotIndex;
  } else {
    rawIndex = globalVuIndex;
  }

  if (rawIndex >= datasetSize) {
    if (onExhausted === 'error') {
      return {
        dataIndex: null,
        dataExhausted: true,
        error: `Data distribution exhausted at index ${rawIndex}. Dataset size is ${datasetSize}.`,
      };
    }
    if (onExhausted === 'skip') {
      return {
        dataIndex: null,
        dataExhausted: true,
        error: null,
      };
    }
    return {
      dataIndex: rawIndex % datasetSize,
      dataExhausted: false,
      error: null,
    };
  }

  return {
    dataIndex: rawIndex,
    dataExhausted: false,
    error: null,
  };
}

function buildBrowserInputs({ sharedConfig: shared, vm, vmGlobalStart, browsers, iteration, iterations, totalBrowsersPerIteration }) {
  const dataset = readDistributionDataset(shared);
  const dist = normalizeDistribution(shared);

  return Array.from({ length: browsers }, (_, localIndex) => {
    const globalBrowserIndex = vmGlobalStart + localIndex + 1;
    const browserSlotIndex = vmGlobalStart + localIndex;
    const globalVuIndex = ((iteration - 1) * totalBrowsersPerIteration) + vmGlobalStart + localIndex;

    const selected = selectDataIndex({
      mode: dist.mode,
      onExhausted: dist.onExhausted,
      datasetSize: dataset.length,
      globalVuIndex,
      browserSlotIndex,
      iteration,
      totalBrowsersPerIteration,
    });

    if (selected.error) {
      throw new Error(selected.error);
    }

    return {
      input: selected.dataIndex === null ? null : dataset[selected.dataIndex],
      vu: {
        agentId: vm.id,
        vmId: vm.id,
        vmHost: vm.host,
        vmPort: vm.port,
        iteration,
        iterations,
        localBrowserIndex: localIndex + 1,
        globalBrowserIndex,
        globalVuIndex,
        totalBrowsersPerIteration,
        dataIndex: selected.dataIndex,
        datasetSize: dataset.length,
        distributionMode: dist.mode,
        dataExhausted: selected.dataExhausted,
      },
    };
  });
}

// ─── Parse CLI args ──────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

// ─── Load config ─────────────────────────────────────────────────────────────
let config = {};
let configPath = null;
if (args.config && fs.existsSync(args.config)) {
  configPath = path.resolve(args.config);
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(`Loaded config from ${configPath}`);
}

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_DIR = configPath ? path.dirname(configPath) : ROOT_DIR;

const sharedConfigPathArg = args.shared || args['shared-config'];
const sharedConfigPathCfg = config.sharedConfigFile || null;
const sharedConfigPath = sharedConfigPathArg || sharedConfigPathCfg;
const sharedConfig = sharedConfigPath
  ? readJsonFile(resolveOptionalPath(sharedConfigPath, CONFIG_DIR), 'shared config')
  : (isObject(config.sharedConfig) ? config.sharedConfig : null);

const moduleFilesFromArgs = parseCsv(args.modules);
const moduleFilesFromConfig = Array.isArray(config.moduleFiles) ? config.moduleFiles : [];
const moduleFiles = moduleFilesFromArgs.length ? moduleFilesFromArgs : moduleFilesFromConfig;
const scriptFile = args.script || config.scriptFile || null;

// ─── Load script source to send to agents ────────────────────────────────────
const BUNDLED_SCRIPT = buildBundledScript(ROOT_DIR, scriptFile, moduleFiles, { logger: console.log });

// CLI overrides config
const CONFIG = {
  vms: args.vms
    ? args.vms.split(',').map((v, i) => {
        const [host, port] = v.split(':');
        return { id: `vm-${i + 1}`, host: host.trim(), port: parseInt(port || '3001'), browsers: parseInt(args.browsers || '2') };
      })
    : config.vms || [{ id: 'local', host: 'localhost', port: 3001, browsers: 2 }],

  headless:    args.headless !== 'false' && config.headless !== false,
  ignoreHTTPSErrors: args.ignoreHTTPSErrors !== 'false' && config.ignoreHTTPSErrors !== false,
  reportFile:  args.report || config.reportFile  || `reports/report-${Date.now()}.json`,
  timeout:     parseInt(args.timeout || config.timeout || '60000'),
  iterations:  parseInt(args.iterations || config.iterations || '1'),

  // Barrier (rendezvous) server — agents POST /barrier?label=X to sync up
  barrierHost:    args['barrier-host']    || config.barrierHost    || 'localhost',
  barrierPort:    parseInt(args['barrier-port']    || config.barrierPort    || '4000'),
  barrierTimeout: parseInt(args['barrier-timeout'] || config.barrierTimeout || '90000'),

  enableAgentLogStream: args['agent-log-stream'] !== 'false' && config.enableAgentLogStream !== false,
  agentLogFile: args['agent-log-file'] || config.agentLogFile || `reports/agent-live-${Date.now()}.log`,

  sharedConfig,
};

const log  = (msg) => console.log(`\x1b[36m[COORDINATOR]\x1b[0m ${msg}`);
const ok   = (msg) => console.log(`\x1b[32m[✓]\x1b[0m ${msg}`);
const err  = (msg) => console.log(`\x1b[31m[✗]\x1b[0m ${msg}`);

const agentLogSink = createAgentLogSink({
  enabled: CONFIG.enableAgentLogStream,
  filePath: CONFIG.agentLogFile,
});

const barrierServer = createBarrierServer({
  host: CONFIG.barrierHost,
  port: CONFIG.barrierPort,
  defaultTimeout: CONFIG.barrierTimeout,
  log,
  onAgentLog: agentLogSink.onAgentLog,
});

// ─── Health check all VMs ─────────────────────────────────────────────────────
async function checkVMs() {
  log(`Checking connectivity to ${CONFIG.vms.length} VM(s)...`);
  const results = await Promise.allSettled(
    CONFIG.vms.map(vm => httpGet(vm.host, vm.port, '/health'))
  );

  const reachable = [];
  const unreachable = [];

  results.forEach((r, i) => {
    const vm = CONFIG.vms[i];
    if (r.status === 'fulfilled') {
      ok(`${vm.id} (${vm.host}:${vm.port}) - reachable`);
      reachable.push(vm);
    } else {
      err(`${vm.id} (${vm.host}:${vm.port}) - UNREACHABLE: ${r.reason?.message}`);
      unreachable.push(vm);
    }
  });

  return { reachable, unreachable };
}

// ─── Run tests on all reachable VMs ──────────────────────────────────────────
async function runOnAllVMs(reachableVMs) {
  log(`\nDispatching to ${reachableVMs.length} VM(s)...`);
  log(`Query: "Headless: ${CONFIG.headless}`);
  console.log('');

  const startTime = Date.now();
  const totalBrowsersPerIteration = reachableVMs.reduce((sum, vm) => sum + (vm.browsers || 0), 0);

  let globalBrowserStart = 0;
  const dispatchPlan = reachableVMs.map(vm => {
    const planned = {
      vm,
      globalBrowserStart,
    };
    globalBrowserStart += (vm.browsers || 0);
    return planned;
  });

  const vmResults = await Promise.allSettled(
    dispatchPlan.map(async ({ vm, globalBrowserStart: vmGlobalStart }) => {
      const browserInputs = buildBrowserInputs({
        sharedConfig: CONFIG.sharedConfig,
        vm,
        vmGlobalStart,
        browsers: vm.browsers,
        iteration: CONFIG.currentIteration || 1,
        iterations: CONFIG.iterations,
        totalBrowsersPerIteration,
      });

      log(`→ Dispatching to ${vm.id} (${vm.host}:${vm.port}) — ${vm.browsers} browser(s)`);
      const response = await httpPost(
        vm.host, vm.port, '/run-sync',
        {
          runId: `iter-${CONFIG.currentIteration || 1}-${vm.id}-${Date.now()}`,
          vmId: vm.id,
          vmHost: vm.host,
          vmPort: vm.port,
          browsers: vm.browsers,
          globalBrowserStart: vmGlobalStart,
          totalBrowsersPerIteration,
          iteration: CONFIG.currentIteration || 1,
          iterations: CONFIG.iterations,
          browserInputs,
          headless: CONFIG.headless,
          ignoreHTTPSErrors: CONFIG.ignoreHTTPSErrors,
          sharedConfig: CONFIG.sharedConfig,
          scriptFile,
          moduleFiles,
          script: BUNDLED_SCRIPT,
          logStreamUrl: CONFIG.enableAgentLogStream
            ? `http://${CONFIG.barrierHost}:${CONFIG.barrierPort}/agent-log`
            : null,
          barrierUrl:     `http://${CONFIG.barrierHost}:${CONFIG.barrierPort}/barrier`,
          barrierTimeout: CONFIG.barrierTimeout
        },
        CONFIG.timeout
      );
      ok(`${vm.id} completed — ${response.results?.length || 0} results`);
      return { vm, response };
    })
  );

  const totalDuration = Date.now() - startTime;
  return { vmResults, totalDuration };
}

// ─── Single iteration runner ─────────────────────────────────────────────────
async function runIteration(reachable, unreachable, iterNum) {
  log(`\n── Iteration ${iterNum}/${CONFIG.iterations} ──────────────────────────────────────────`);
  CONFIG.currentIteration = iterNum;

  // Reset barrier state so each iteration gets a fresh rendezvous
  const expected = reachable.reduce((sum, vm) => sum + (vm.browsers || 0), 0);
  barrierServer.resetForIteration(expected);

  const { vmResults, totalDuration } = await runOnAllVMs(reachable);
  log(`Iteration ${iterNum} completed in ${totalDuration}ms`);

  const report = aggregateResults(
    vmResults,
    unreachable,
    totalDuration,
  );
  report.totalDuration = totalDuration;
  report.iteration = iterNum;
  return report;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[1m PLAYWRIGHT DISTRIBUTED PERFORMANCE COORDINATOR\x1b[0m\n');
  log(`VMs configured: ${CONFIG.vms.map(v => `${v.id}(${v.host}:${v.port} x${v.browsers})`).join(', ')}`);
  log(`Iterations: ${CONFIG.iterations}`);
  if (CONFIG.enableAgentLogStream) {
    log(`Agent live log stream enabled -> ${agentLogSink.filePath}`);
  } else {
    log('Agent live log stream disabled');
  }

  // Step 1: Health check
  const { reachable, unreachable } = await checkVMs();
  if (reachable.length === 0) {
    err('No VMs reachable. Make sure agents are running: node agent/agent.js');
    process.exit(1);
  }

  // Step 1b: Start barrier server (stays up for all iterations)
  const expected = reachable.reduce((sum, vm) => sum + (vm.browsers || 0), 0);
  barrierServer.setExpected(expected);
  await barrierServer.start();

  // Step 2: Run N iterations sequentially
  const iterationReports = [];
  const overallStart = Date.now();

  for (let i = 1; i <= CONFIG.iterations; i++) {
    const iterReport = await runIteration(reachable, unreachable, i);
    iterationReports.push(iterReport);

    // Print a compact per-iteration summary
    const s = iterReport.summary;
    const totalKey = iterReport.timingKeys.includes('totalTime') ? 'totalTime' : iterReport.timingKeys[iterReport.timingKeys.length - 1];
    const avgTotal = totalKey ? iterReport.timings[totalKey]?.avg : 0;
    log(`  Iteration ${i}: ${s.successfulBrowsers}/${s.totalBrowsers} ok | avg total: ${avgTotal}ms | duration: ${s.durationSec}s`);
  }

  // Step 2b: Stop barrier server
  await barrierServer.stop();

  const overallDuration = Date.now() - overallStart;

  // Step 3: Merge all iterations into one combined report
  const allBrowserResults = iterationReports.flatMap((r, idx) =>
    r.browserResults.map(b => ({ ...b, iteration: idx + 1 }))
  );

  // Re-aggregate across all iterations with one entry per reachable VM.
  // This keeps summary.totalVMs stable instead of multiplying by iteration count.
  const combinedVmResults = reachable.map(vm => ({
    status: 'fulfilled',
    value: {
      vm,
      response: {
        results: allBrowserResults.filter(b => b.vmId === vm.id),
      },
    },
  }));

  const combinedReport = aggregateResults(
    combinedVmResults,
    unreachable,
    overallDuration,
  );
  combinedReport.totalDuration = overallDuration;
  combinedReport.iterations = CONFIG.iterations;
  combinedReport.iterationReports = iterationReports;
  // Override browserResults to include iteration tag
  combinedReport.browserResults = allBrowserResults;

  // Step 4: Print combined report
  console.log(`\n\x1b[1m COMBINED REPORT — ${CONFIG.iterations} iteration(s) | ${overallDuration}ms total\x1b[0m`);
  reporters.printReport(combinedReport);

  // Step 5: Save JSON report
  const reportPath = CONFIG.reportFile;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(combinedReport, null, 2));
  ok(`Report saved: ${reportPath}`);

  // Step 6: Save HTML report
  const htmlPath = reportPath.replace('.json', '.html');
  fs.writeFileSync(htmlPath, reporters.generateHTML(combinedReport));
  ok(`HTML report: ${htmlPath}`);
}



main().catch(e => { 
  err(`${e.message}\n${e.stack}`); 
  process.exit(1); 
});
