import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createBrowserRenderer, runRendererProtocol } from '../lead-server/browser-renderer.mjs';

function fakeDocker(onMessage) {
  const launches = [], messages = [];
  const spawnImpl = (command, args, options) => {
    launches.push({ command, args, options });
    const child = new EventEmitter(); child.unref = () => {};
    if (args[0] === 'rm') return child;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 0);
    let input = '';
    child.stdin.on('data', chunk => {
      input += chunk.toString(); let newline;
      while ((newline = input.indexOf('\n')) >= 0) {
        const message = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1);
        messages.push(message); onMessage(message, child);
      }
    });
    return child;
  };
  return { spawnImpl, launches, messages };
}

test('unconfigured renderer never launches a local unprotected browser', async () => {
  let launches = 0;
  const renderer = createBrowserRenderer({ env: {}, spawnImpl: () => { launches++; throw new Error(); } });
  await assert.rejects(renderer('https://site.example/'), { code: 'RENDERER_UNAVAILABLE' });
  assert.equal(launches, 0);
});

test('standalone renderer checks robots before launching its isolated browser', async () => {
  let launches = 0;
  const renderer = createBrowserRenderer({ env: { LEAD_BROWSER_IMAGE: 'fixture' }, spawnImpl: () => { launches++; throw new Error(); } });
  await assert.rejects(renderer('https://site.example/', { fetcher: async () => ({ status: 403, headers: {}, text: '' }) }), { code: 'ROBOTS_DENIED' });
  assert.equal(launches, 0);
});

test('renderer requires isolated Docker flags, fulfills through protected parent and cleans its container', async () => {
  const f = fakeDocker((message, child) => {
    if (message.type === 'init') child.stdout.write(JSON.stringify({ type: 'request', id: 1, url: message.url, method: 'GET', resourceType: 'document' }) + '\n');
    if (message.type === 'response') child.stdout.write(JSON.stringify({ type: 'result', url: 'https://site.example/', html: '<h1>Проверенная страница</h1>' }) + '\n');
  });
  const fetched = [], checked = [];
  const renderer = createBrowserRenderer({ env: { LEAD_BROWSER_IMAGE: 'vertux-lead-browser:fixture' }, spawnImpl: f.spawnImpl });
  const result = await renderer('https://site.example/', { checkUrl: async url => checked.push(url), fetcher: async url => { fetched.push(url); return { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'must-not-be-forwarded=fixture' }, text: '<h1>Проверенная страница</h1>' }; } });
  const args = f.launches[0].args;
  for (const flag of ['--network=none', '--read-only', '--user', 'pwuser', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=768m', '--cpus=1', '--pull=never']) assert.ok(args.includes(flag), flag);
  assert.equal(args.includes('--privileged'), false);
  assert.equal(result.isolation, 'docker_network_none');
  assert.deepEqual(fetched, ['https://site.example/']);
  assert.ok(checked.length >= 2);
  assert.equal(f.messages.find(item => item.type === 'response').headers['set-cookie'], undefined);
  assert.ok(f.launches.some(item => item.args[0] === 'rm' && item.args[1] === '--force'));
});

test('even compromised child cannot request localhost through its parent transport', async () => {
  const f = fakeDocker((message, child) => {
    if (message.type === 'init') child.stdout.write(JSON.stringify({ type: 'request', id: 1, url: 'http://127.0.0.1/secrets', method: 'GET', resourceType: 'fetch' }) + '\n');
    if (message.type === 'response') child.stdout.write(JSON.stringify({ type: 'result', url: 'https://site.example/', html: '<h1>Known document</h1>' }) + '\n');
  });
  let fetched = 0;
  const renderer = createBrowserRenderer({ env: { LEAD_BROWSER_IMAGE: 'fixture' }, spawnImpl: f.spawnImpl });
  await renderer('https://site.example/', { checkUrl: async () => {}, fetcher: async () => { fetched++; return {}; } });
  assert.equal(fetched, 0);
  assert.equal(f.messages.find(item => item.type === 'response').error, 'RESOURCE_BLOCKED');
});

test('POST, downloads and oversized child output are rejected without exposing stderr', async () => {
  const post = fakeDocker((message, child) => {
    if (message.type === 'init') { child.stderr.write('private fixture diagnostic'); child.stdout.write(JSON.stringify({ type: 'request', id: 1, url: 'https://site.example/form', method: 'POST', resourceType: 'fetch' }) + '\n'); }
  });
  await assert.rejects(createBrowserRenderer({ env: { LEAD_BROWSER_IMAGE: 'fixture' }, spawnImpl: post.spawnImpl })('https://site.example/', { checkUrl: async () => {} }), error => error.code === 'BROWSER_FAILED' && !error.message.includes('private'));
  const huge = fakeDocker((message, child) => { if (message.type === 'init') child.stdout.write('x'.repeat(3 * 1024 * 1024 + 1)); });
  await assert.rejects(createBrowserRenderer({ env: { LEAD_BROWSER_IMAGE: 'fixture' }, spawnImpl: huge.spawnImpl })('https://site.example/', { checkUrl: async () => {} }), { code: 'BROWSER_OUTPUT_LIMIT' });
  const download = fakeDocker((message, child) => {
    if (message.type === 'init') child.stdout.write(JSON.stringify({ type: 'request', id: 1, url: message.url, method: 'GET', resourceType: 'document' }) + '\n');
    if (message.type === 'response') child.stdout.write(JSON.stringify({ type: 'result', url: 'https://site.example/', html: '' }) + '\n');
  });
  await createBrowserRenderer({ env: { LEAD_BROWSER_IMAGE: 'fixture' }, spawnImpl: download.spawnImpl })('https://site.example/', { checkUrl: async () => {}, fetcher: async () => ({ status: 200, headers: { 'content-disposition': 'attachment; filename=fixture.exe' }, text: 'fixture' }) });
  assert.equal(download.messages.find(item => item.type === 'response').error, 'RESOURCE_BLOCKED');
});

test('worker protocol enables sandbox and blocks SW/WebSockets while rendering', async () => {
  const input = new PassThrough(), output = new PassThrough(); let captured = '', launchOptions, contextOptions, socketRoute, routed;
  output.on('data', chunk => { captured += chunk.toString(); });
  const context = { routeWebSocket: async (pattern, callback) => { socketRoute = callback; }, addInitScript: async () => {}, on: () => {}, route: async (pattern, callback) => { routed = callback; }, newPage: async () => ({ on: () => {}, setDefaultTimeout: () => {}, goto: async () => {}, waitForLoadState: async () => {}, content: async () => '<h1>Fixture render</h1>', url: () => 'https://site.example/' }) };
  const protocol = await runRendererProtocol({ input, output, loadPlaywright: async () => ({ chromium: { launch: async options => { launchOptions = options; return { newContext: async options => { contextOptions = options; return context; }, close: async () => {} }; } } }) });
  input.write(JSON.stringify({ type: 'init', url: 'https://site.example/', timeoutMs: 1000, maxBytes: 5000 }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launchOptions.chromiumSandbox, true);
  assert.equal(launchOptions.args.includes('--no-sandbox'), false);
  assert.equal(contextOptions.serviceWorkers, 'block');
  assert.equal(contextOptions.acceptDownloads, false);
  assert.equal(typeof socketRoute, 'function');
  assert.equal(typeof routed, 'function');
  assert.ok(captured.includes('Fixture render'));
  input.end(); await protocol.close();
});

test('real bundled Chromium executes a synthetic JS page via IPC only (not Docker acceptance)', { skip: !process.env.LEAD_TEST_PLAYWRIGHT_PATH, timeout: 20000 }, async () => {
  const input = new PassThrough(), output = new PassThrough(); const requests = [];
  const html = '<html><head><meta charset="utf-8"><title>Synthetic JS fixture</title></head><body><div id="app">Loading</div><script>setTimeout(()=>{document.querySelector("#app").textContent="Синтетическая страница готова"},10)</script></body></html>';
  let buffer = '';
  const completed = new Promise((resolve, reject) => {
    output.on('data', chunk => {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (message.type === 'request') { requests.push(message); input.write(JSON.stringify({ type: 'response', id: message.id, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html).toString('base64') }) + '\n'); }
        if (message.type === 'result') resolve(message);
        if (message.type === 'error') reject(new Error(message.code));
      }
    });
  });
  const protocol = await runRendererProtocol({ input, output, loadPlaywright: async () => {
    const playwright = await import(pathToFileURL(process.env.LEAD_TEST_PLAYWRIGHT_PATH).href);
    const channel = process.env.LEAD_TEST_BROWSER_CHANNEL;
    if (!channel) return playwright;
    assert.ok(['chrome', 'msedge'].includes(channel));
    return { chromium: { launch: options => playwright.chromium.launch({ ...options, channel }) } };
  } });
  try {
    input.write(JSON.stringify({ type: 'init', url: 'https://synthetic.example/', timeoutMs: 10000, maxBytes: 50000 }) + '\n');
    const result = await completed;
    assert.ok(result.html.includes('Синтетическая страница готова'));
    assert.ok(!result.html.includes('>Loading<'));
    assert.ok(requests.length >= 1);
    assert.ok(requests.every(request => request.url === 'https://synthetic.example/'));
  } finally { input.end(); await protocol.close(); }
});
