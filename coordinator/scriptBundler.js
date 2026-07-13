const fs = require('fs');
const path = require('path');

function parseCsv(value) {
  if (!value) return [];
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function resolveScriptPath(rawPath, rootDir) {
  if (!rawPath) return null;
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(rootDir, rawPath);
}

function readTextFileOrDie(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function toSourceUrlPath(filePath, rootDir) {
  const rel = rootDir ? path.relative(rootDir, filePath) : filePath;
  return rel.split(path.sep).join('/');
}

function wrapBundledModuleSource(filePath, source, rootDir) {
  const sourceUrl = toSourceUrlPath(filePath, rootDir);
  const moduleName = path.basename(filePath, '.js');  // Strip .js extension
  return `\n// ---- module: ${filePath} ----\n(() => {\n  const module = { exports: {} };\n  const exports = module.exports;\n${source}\n  registerBundledScript(${JSON.stringify(moduleName)}, module.exports);\n})();`;
}

function buildBundledScript(rootDir, scriptFile, moduleFiles, options = {}) {
  const {
    logger = console.log,
    libFile = path.resolve(__dirname, '../src/lib.js'),
    defaultScript = '',
  } = options;

  const entryPath = resolveScriptPath(scriptFile || defaultScript, rootDir);
  const modulePaths = (moduleFiles || []).map(m => resolveScriptPath(m, rootDir));

  if (!entryPath && modulePaths.length === 0) {
    throw new Error('No scripts configured. Provide at least one moduleFiles entry or scriptFile.');
  }

  const libSource = readTextFileOrDie(libFile, 'Shared helper file');
  const moduleSources = modulePaths.map((p, i) => {
    const source = readTextFileOrDie(p, `Module file #${i + 1}`);
    return `${wrapBundledModuleSource(p, source, rootDir)}\n//# sourceURL=${toSourceUrlPath(p, rootDir)}`;
  });
  const entrySource = entryPath ? readTextFileOrDie(entryPath, 'Entry script file') : null;

  if (entryPath) {
    logger(`Using entry script: ${entryPath}`);
  } else {
    logger('No entry script configured; running module files only.');
  }
  if (modulePaths.length) {
    logger(`Using modules (${modulePaths.length}):`);
    modulePaths.forEach(p => logger(`  - ${p}`));
  }

  const entryName = entryPath ? path.basename(entryPath, '.js') : null;
  const entryBlock = entryPath
    ? `\n\n// ---- entry: ${entryPath} ----\n${entrySource}\n//# sourceURL=${toSourceUrlPath(entryPath, rootDir)}\n\nconst __entryRunScript = module.exports;\nmodule.exports = createBundledRunner(__entryRunScript, ${JSON.stringify(entryName)});`
    : `\n\nmodule.exports = createBundledRunner(null, null);`;

  // Bundle order matters: helpers -> wrapped modules -> entry -> composite export.
  return `${libSource}${moduleSources.join('')}${entryBlock}`;
}

module.exports = {
  parseCsv,
  resolveScriptPath,
  buildBundledScript,
};
