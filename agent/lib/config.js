function readArg(argv, name, fallback) {
  const prefix = `--${name}=`;
  const arg = argv.find(a => typeof a === 'string' && a.startsWith(prefix));
  if (!arg) return fallback;
  return arg.slice(prefix.length);
}

function loadAgentConfig(argv = process.argv) {
  const port = parseInt(readArg(argv, 'port', '3001'), 10);
  const safePort = Number.isFinite(port) ? port : 3001;
  const agentId = readArg(argv, 'id', `agent-${safePort}`);

  return {
    port: safePort,
    agentId,
  };
}

module.exports = {
  loadAgentConfig,
};
