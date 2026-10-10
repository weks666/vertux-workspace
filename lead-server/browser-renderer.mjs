import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizePublicUrl, ResearchFetchError, safeFetch, createRobotsGuard } from './safe-fetch.mjs';

const fail = code => new ResearchFetchError(code);
const MAX_LINE = 3 * 1024 * 1024;
const allowedTypes = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch']);
const safeHeaders = response => Object.fromEntries(Object.entries(response.headers || {}).filter(([name, value]) => ['content-type', 'content-security-policy', 'x-content-type-options', 'access-control-allow-origin'].includes(name.toLowerCase()) && typeof value === 'string' && value.length < 8192 && !/[\r\n]/.test(value)));

/**
 * The browser is never allowed host egress: Docker --network=none is mandatory.
 * Browser routing alone does not constrain WebRTC, DNS or browser background
 * traffic. Parent Node fulfills resource requests through the protected fetcher.
 */
export function createBrowserRenderer({ env = process.env, spawnImpl = spawn } = {}) {
  return async function renderPage(input, { fetcher = safeFetch, checkUrl, signal, timeoutMs = 12000, maxBytes = 1024 * 1024, maxRequests = 35 } = {}) {
    const url = normalizePublicUrl(input).href;
    const image = env.LEAD_BROWSER_IMAGE;
    if (!image || !/^[a-z0-9][a-z0-9._:/@-]{0,180}$/i.test(image)) throw fail('RENDERER_UNAVAILABLE');
    if (signal?.aborted) throw fail('REQUEST_ABORTED');
    let networkRequests = 0;
    const onRequest = () => { if (networkRequests >= maxRequests) throw fail('RESOURCE_LIMIT'); networkRequests++; };
    const guard = checkUrl || createRobotsGuard(fetcher, { signal, timeoutMs, minDelayMs: 1000, onRequest }).check;
    await guard(url);
    const containerName = `vertux-lead-render-${randomUUID()}`;
    const args = ['run', '--rm', '--pull=never', '--name', containerName, '--network=none', '--read-only', '--init', '--user', 'pwuser', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=768m', '--cpus=1', '--shm-size=256m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=192m', '-i'];
    // Administrator-supplied, reviewed Docker seccomp profile, never a page field.
    if (env.LEAD_BROWSER_SECCOMP_PROFILE) {
      if (!/^(?:\/[\w./ -]+|[a-z]:[\\/][\w.\\/ -]+)$/i.test(env.LEAD_BROWSER_SECCOMP_PROFILE)) throw fail('RENDERER_UNAVAILABLE');
      args.push('--security-opt', `seccomp=${env.LEAD_BROWSER_SECCOMP_PROFILE}`);
    }
    args.push('--entrypoint', 'node', image, '/app/lead-server/browser-renderer.mjs', '--isolated-child');
    let child;
    try { child = spawnImpl('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch { throw fail('RENDERER_UNAVAILABLE'); }
    return new Promise((resolve, reject) => {
      let ended = false, buffer = '', totalOutput = 0, requests = 0, totalBytes = 0, active = 0;
      const requestIds = new Set();
      const controller = new AbortController();
      const send = message => { if (!ended && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`); };
      const cleanupContainer = () => {
        try { const cleanup = spawnImpl('docker', ['rm', '--force', containerName], { stdio: 'ignore', windowsHide: true }); cleanup.on?.('error', () => {}); cleanup.unref?.(); } catch { /* already removed or daemon unavailable */ }
      };
      const finish = (cause, result) => {
        if (ended) return; ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        controller.abort(); child.stdin.end(); child.kill(); cleanupContainer();
        if (cause) reject(cause); else resolve(result);
      };
      const abort = () => finish(fail('REQUEST_ABORTED'));
      const timer = setTimeout(() => finish(fail('BROWSER_TIMEOUT')), Math.max(1000, Math.min(30000, timeoutMs)) + 5000);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(fail('RENDERER_UNAVAILABLE')));
      child.on('exit', () => { if (!ended) finish(fail('BROWSER_FAILED')); });
      // Never forward stderr: Chromium, Docker or page errors can contain URLs,
      // credentials or remote content. Exit status maps to a stable public code.
      child.stderr.on('data', () => {});
      child.stdout.setEncoding?.('utf8');
      child.stdin.on('error', () => { if (!ended) finish(fail('BROWSER_FAILED')); });
      const processMessage = async message => {
        if (message.type === 'result') {
          const resultUrl = normalizePublicUrl(message.url).href;
          if (new URL(resultUrl).origin !== new URL(url).origin || typeof message.html !== 'string' || Buffer.byteLength(message.html) > maxBytes) throw fail('BROWSER_INVALID_RESULT');
          finish(null, { url: resultUrl, html: message.html, requests, isolation: 'docker_network_none' });
          return;
        }
        if (message.type === 'error') throw fail(message.code === 'RENDERER_UNAVAILABLE' ? 'RENDERER_UNAVAILABLE' : 'BROWSER_FAILED');
        if (message.type !== 'request' || !Number.isSafeInteger(message.id) || requestIds.has(message.id) || typeof message.url !== 'string' || message.method !== 'GET' || !allowedTypes.has(message.resourceType)) throw fail('BROWSER_PROTOCOL_ERROR');
        requestIds.add(message.id);
        if (++requests > maxRequests || active >= 8) { send({ type: 'response', id: message.id, error: 'RESOURCE_LIMIT' }); return; }
        active++;
        try {
          const resourceUrl = normalizePublicUrl(message.url).href;
          if (message.resourceType === 'document' && resourceUrl !== url) throw fail('NAVIGATION_BLOCKED');
          await guard(resourceUrl);
          const response = await fetcher(resourceUrl, { signal: controller.signal, timeoutMs: Math.min(timeoutMs, 12000), maxBytes: Math.min(maxBytes, 1024 * 1024), accept: '*/*', minDelayMs: 1000, beforeRequest: guard, onRequest });
          const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text || '');
          totalBytes += body.length;
          if (body.length > maxBytes || totalBytes > 6 * 1024 * 1024) throw fail('RESOURCE_LIMIT');
          if (/attachment/i.test(response.headers?.['content-disposition'] || '')) throw fail('DOWNLOAD_BLOCKED');
          send({ type: 'response', id: message.id, status: response.status, headers: safeHeaders(response), body: body.toString('base64') });
        } catch { send({ type: 'response', id: message.id, error: 'RESOURCE_BLOCKED' }); }
        finally { active--; }
      };
      child.stdout.on('data', chunk => {
        totalOutput += Buffer.byteLength(chunk);
        if (totalOutput > 8 * 1024 * 1024) { finish(fail('BROWSER_OUTPUT_LIMIT')); return; }
        buffer += chunk.toString('utf8');
        if (buffer.length > MAX_LINE) { finish(fail('BROWSER_OUTPUT_LIMIT')); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try { Promise.resolve(processMessage(JSON.parse(line))).catch(() => finish(fail('BROWSER_FAILED'))); }
          catch { finish(fail('BROWSER_PROTOCOL_ERROR')); }
        }
      });
      send({ type: 'init', url, timeoutMs: Math.max(1000, Math.min(30000, timeoutMs)), maxBytes });
    });
  };
}

// Exported for isolated protocol fixtures. Production enters only through the
// Docker command above, with no network and no application secrets in its env.
export async function runRendererProtocol({ input = process.stdin, output = process.stdout, loadPlaywright = () => import('playwright') } = {}) {
  input.setEncoding?.('utf8');
  const write = message => output.write(`${JSON.stringify(message)}\n`);
  const pending = new Map(); let nextId = 0, browser, buffer = '', initialised = false, done = false;
  const rejectPending = () => { for (const item of pending.values()) item.reject(fail('BROWSER_CLOSED')); pending.clear(); };
  const close = async () => { if (done) return; done = true; rejectPending(); try { await browser?.close(); } catch {} };
  const network = request => new Promise((resolve, reject) => {
    if (done || pending.size >= 8) { reject(fail('RESOURCE_LIMIT')); return; }
    const id = ++nextId; pending.set(id, { resolve, reject });
    write({ type: 'request', id, url: request.url(), method: request.method(), resourceType: request.resourceType() });
  });
  const begin = async config => {
    if (initialised) throw fail('BROWSER_PROTOCOL_ERROR'); initialised = true;
    const url = normalizePublicUrl(config.url).href;
    const timeoutMs = Math.max(1000, Math.min(30000, Number(config.timeoutMs) || 12000));
    const maxBytes = Math.max(1024, Math.min(1024 * 1024, Number(config.maxBytes) || 1024 * 1024));
    const playwright = await loadPlaywright();
    browser = await playwright.chromium.launch({ headless: true, chromiumSandbox: true, timeout: timeoutMs,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND'],
      // Defence in depth. All real resources arrive via IPC; accidental browser
      // traffic also fails against this closed proxy before the OS egress deny.
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', permissions: [], ignoreHTTPSErrors: false, javaScriptEnabled: true, viewport: { width: 1365, height: 900 } });
    if (typeof context.routeWebSocket !== 'function') throw fail('RENDERER_UNAVAILABLE');
    await context.routeWebSocket('**/*', websocket => websocket.close());
    await context.addInitScript(() => {
      const disabled = () => { throw new Error('Disabled in read-only research'); };
      for (const name of ['WebSocket', 'Worker', 'SharedWorker', 'EventSource', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
        try { Object.defineProperty(globalThis, name, { value: disabled, configurable: false, writable: false }); } catch {}
      }
      window.open = () => null;
    });
    let activePage;
    context.on('page', page => { if (activePage) page.close().catch(() => {}); });
    await context.route('**/*', async route => {
      const request = route.request();
      if (request.method() !== 'GET' || !allowedTypes.has(request.resourceType()) || (request.isNavigationRequest() && (request.frame().parentFrame() || request.url() !== url))) { await route.abort(); return; }
      try {
        normalizePublicUrl(request.url());
        const response = await network(request);
        if (response.error || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) { await route.abort(); return; }
        const body = Buffer.from(response.body || '', 'base64');
        if (body.length > maxBytes) { await route.abort(); return; }
        await route.fulfill({ status: response.status, headers: response.headers, body });
      } catch { await route.abort().catch(() => {}); }
    });
    activePage = await context.newPage();
    activePage.on('download', download => download.cancel().catch(() => {}));
    activePage.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    activePage.setDefaultTimeout(timeoutMs);
    await activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await activePage.waitForLoadState('networkidle', { timeout: Math.min(2500, timeoutMs) }).catch(() => {});
    const html = await activePage.content();
    if (Buffer.byteLength(html) > maxBytes) throw fail('BODY_TOO_LARGE');
    write({ type: 'result', url: activePage.url(), html });
    await close();
  };
  input.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_LINE) { write({ type: 'error', code: 'BROWSER_PROTOCOL_ERROR' }); close(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === 'init') begin(message).catch(async () => { write({ type: 'error', code: 'BROWSER_FAILED' }); await close(); });
        else if (message.type === 'response' && pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); item.resolve(message); }
        else { write({ type: 'error', code: 'BROWSER_PROTOCOL_ERROR' }); close(); }
      } catch { write({ type: 'error', code: 'BROWSER_PROTOCOL_ERROR' }); close(); }
    }
  });
  input.on('end', close);
  input.on('error', close);
  return { close };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv.includes('--isolated-child')) {
  await runRendererProtocol();
}
