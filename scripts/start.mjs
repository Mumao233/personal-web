import { existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Please install Node.js 24 or newer: https://nodejs.org/');
  process.exit(1);
}
const python = spawnSync(process.env.PYTHON || 'python', ['--version'], { encoding: 'utf8', windowsHide: true });
if (python.status !== 0) { console.error('Python 3.9+ is required. Set PYTHON to its executable if necessary.'); process.exit(1); }
function npm(args) {
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
  });
  if (run.status !== 0) process.exit(run.status || 1);
}
if (!existsSync('node_modules/vite/package.json')) npm(['ci', '--no-audit', '--no-fund']);
const built = existsSync('dist/index.html') ? statSync('dist/index.html').mtimeMs : 0;
function newest(path) {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  return info.isDirectory() ? Math.max(info.mtimeMs, ...readdirSync(path).map(name => newest(resolve(path, name)))) : info.mtimeMs;
}
if (['src', 'public', 'index.html', 'vite.config.js', 'package-lock.json'].some(path => newest(path) > built)) npm(['run', 'build']);
const port = process.env.PORT || '5193';
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
  if (response.ok && (await response.json()).application === 'personal-universe') {
    console.log(`Website already running: http://localhost:${port}/`);
    process.exit(0);
  }
} catch { /* No existing instance. */ }
process.argv.push('--production');
await import('../server/index.js');
