import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const prefixes = ['/solar', '/assets', '/audio', '/data', '/earth', '/external', '/fonts', '/geo', '/images', '/moons', '/planets', '/species', '/vendor', '/weather', '/__local', '/__external', '/api/environment'];
export function isAtlasRequest(rawUrl) {
  const url = new URL(rawUrl, 'http://localhost');
  return (url.pathname === '/' && (['globe', 'map', 'depth'].includes(url.searchParams.get('view')) || url.searchParams.get('from') === 'solar' || url.searchParams.get('intro') === '0' || ['sel', 'lesson', 'mode'].some(key => url.searchParams.has(key))))
    || url.pathname === '/earth-config.json'
    || prefixes.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix + '/'));
}

export async function startAtlas() {
  const child = spawn(process.env.PYTHON || 'python', ['-u', 'integrated_server.py'], {
    cwd: resolve('atlas'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  let live = true;
  child.on('exit', () => { live = false; });
  child.stderr.on('data', chunk => process.stderr.write(`[Atlas] ${chunk}`));
  const port = await new Promise((ok, fail) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => { child.kill(); fail(Error('Atlas startup timed out')); }, 15000);
    const reject = error => { clearTimeout(timer); lines.close(); fail(error); };
    child.once('error', reject);
    child.once('exit', code => reject(Error(`Atlas exited before startup (${code})`)));
    lines.on('line', line => {
      try {
        const status = JSON.parse(line);
        if (status.application === 'personal-web-atlas' && Number.isInteger(status.port)) {
          clearTimeout(timer); lines.close(); ok(status.port);
        }
      } catch { /* Python startup diagnostics are not the ready record. */ }
    });
  });
  const stop = () => { if (live) child.kill(); };
  process.once('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop(); process.exit(0); });

  function middleware(req, res, next) {
    if (!isAtlasRequest(req.originalUrl)) return next();
    if (!live) return res.status(503).json({ error: '太阳系服务已停止，请重新启动网站。' });
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    // The public gateway has already checked the same-origin write policy.
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
    delete headers.connection;
    const upstream = request({ hostname: '127.0.0.1', port, path: req.originalUrl, method: req.method, headers }, incoming => {
      res.status(incoming.statusCode);
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined && !['connection', 'transfer-encoding', 'server'].includes(key)) res.setHeader(key, value);
      }
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ error: '暂时无法连接太阳系服务。' }); else res.destroy(); });
    upstream.setTimeout(120000, () => upstream.destroy(Error('Atlas request timed out')));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }
  return { middleware, stop, get live() { return live; } };
}
