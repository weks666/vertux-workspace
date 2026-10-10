import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafeFetcher, createRobotsGuard, isPublicAddress, normalizePublicUrl, parseRobots, robotsAllows, ResearchFetchError, decodeResponseBody } from '../lead-server/safe-fetch.mjs';

const html = (text = '<h1>Fixture</h1>', status = 200, headers = {}) => ({ status, headers: { 'content-type': 'text/html', ...headers }, text, body: Buffer.from(text), bytes: Buffer.byteLength(text) });
function fixture({ routes = {}, resolver = async () => [{ address: '93.184.215.14', family: 4 }] } = {}) {
  let current = 1_000_000; const requests = [], sleeps = [];
  const fetcher = createSafeFetcher({ resolver, schedule: new Map(), now: () => current, sleep: async delay => { sleeps.push(delay); current += delay; }, transport: async (url, target, options) => {
    requests.push({ url: url.href, target, headers: options.headers, at: current });
    const value = routes[url.href];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(url, target, options);
    return value || html();
  } });
  return { fetcher, requests, sleeps, advance: ms => { current += ms; } };
}

test('public-only IPv4/IPv6 includes mapped, transition and metadata defenses', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '100.100.100.200', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.4', '198.19.0.1', '224.0.0.1', '255.255.255.255', '168.63.129.16', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:7f00:1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '3fff::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '93.184.215.14', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('unsafe URL schemes, ports, credentials, alternate IPv4 and sensitive queries fail closed', () => {
  for (const url of ['file:///etc/passwd', 'ftp://public.example/a', 'http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://localhost/', 'http://api.internal/', 'https://public.example:8443/', 'https://user:pass@public.example/', 'https://public.example/?access_token=fixture']) assert.throws(() => normalizePublicUrl(url), ResearchFetchError, url);
  assert.equal(normalizePublicUrl('https://public.example/path#secret').href, 'https://public.example/path');
});

test('every DNS answer is verified and transport uses the exact pinned address', async () => {
  const mixed = fixture({ resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(mixed.fetcher('https://mixed.example/'), { code: 'PRIVATE_ADDRESS' });
  assert.equal(mixed.requests.length, 0);
  let lookups = 0;
  const pinned = fixture({ resolver: async () => { lookups++; return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; } });
  await pinned.fetcher('https://rebind.example/');
  assert.equal(lookups, 1);
  assert.equal(pinned.requests[0].target.address, '8.8.8.8');
  await assert.rejects(pinned.fetcher('https://rebind.example/'), { code: 'PRIVATE_ADDRESS' });
});

test('redirects verify target DNS before network and reject local, downgraded and overlong chains', async () => {
  const f = fixture({ routes: { 'https://safe.example/': html('', 302, { location: 'https://private.example/' }) }, resolver: async host => [{ address: host === 'private.example' ? '10.0.0.3' : '93.184.215.14', family: 4 }] });
  await assert.rejects(f.fetcher('https://safe.example/'), { code: 'PRIVATE_ADDRESS' });
  assert.equal(f.requests.length, 1);
  const downgrade = fixture({ routes: { 'https://safe.example/': html('', 301, { location: 'http://safe.example/' }) } });
  await assert.rejects(downgrade.fetcher('https://safe.example/'), { code: 'INSECURE_REDIRECT' });
  const loop = fixture({ routes: { 'https://safe.example/': html('', 302, { location: '/' }) } });
  await assert.rejects(loop.fetcher('https://safe.example/'), { code: 'REDIRECT_LIMIT' });
  assert.equal(loop.requests.length, 6);
});

test('DNS and body timeouts, cancellation, size limits and stable errors are bounded', async () => {
  const timeout = fixture({ resolver: () => new Promise(() => {}) });
  await assert.rejects(timeout.fetcher('https://slow.example/', { timeoutMs: 50 }), { code: 'REQUEST_TIMEOUT' });
  const body = fixture({ routes: { 'https://large.example/': html('x'.repeat(100)) } });
  await assert.rejects(body.fetcher('https://large.example/', { maxBytes: 10 }), { code: 'BODY_TOO_LARGE' });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(body.fetcher('https://large.example/', { signal: aborted.signal }), { code: 'REQUEST_ABORTED' });
  const failed = fixture({ routes: { 'https://error.example/': new Error('untrusted server error must not escape') } });
  await assert.rejects(failed.fetcher('https://error.example/'), { code: 'REQUEST_FAILED', message: 'REQUEST_FAILED' });
});

test('429 Retry-After persists a host cooldown and never silently retries', async () => {
  const f = fixture({ routes: { 'https://busy.example/': html('', 429, { 'retry-after': '60' }) } });
  await assert.rejects(f.fetcher('https://busy.example/'), error => error.code === 'RATE_LIMITED' && Boolean(error.retryAt));
  await assert.rejects(f.fetcher('https://busy.example/other'), { code: 'RATE_LIMITED' });
  assert.equal(f.requests.length, 1);
  f.advance(60_001);
  await f.fetcher('https://busy.example/other');
  assert.equal(f.requests.length, 2);
});

test('robots use longest matching rule, allow ties, wildcards, encoding and matching user-agent groups', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /\nUser-agent: vertuxleadresearch\nDisallow: /private/\nAllow: /private/public/\nDisallow: /*.pdf$\nAllow: /same\nDisallow: /same\nDisallow: /caf%C3%A9\nDisallow: /a%2Fb\nDisallow: /%7Euser\nCrawl-delay: 2.5\n\nUser-agent: VertuxLeadResearch\nDisallow: /combined');
  assert.equal(policy.crawlDelayMs, 2500);
  for (const path of ['/private/x', '/a.pdf', '/café', '/a%2fb', '/~user', '/combined']) assert.equal(robotsAllows(policy, `https://rules.example${path}`), false, path);
  for (const path of ['/free', '/private/public/x', '/same', '/a.pdf?download=1', '/a/b', '/robots.txt']) assert.equal(robotsAllows(policy, `https://rules.example${path}`), true, path);
});

test('robots inaccessible means stop, 404 allows, auth errors deny, redirected pages recheck robots', async () => {
  const f = fixture({ routes: {
    'https://locked.example/robots.txt': html('', 403),
    'https://down.example/robots.txt': html('', 500),
    'https://missing.example/robots.txt': html('', 404),
    'https://challenge.example/robots.txt': html('<!doctype html><title>Verify you are human</title>'),
    'https://source.example/robots.txt': html('', 404),
    'https://source.example/': html('', 302, { location: 'https://locked.example/' }),
  } });
  const guard = createRobotsGuard(f.fetcher, { minDelayMs: 0 });
  await assert.rejects(guard.check('https://locked.example/a'), { code: 'ROBOTS_DENIED' });
  await assert.rejects(guard.check('https://down.example/a'), { code: 'ROBOTS_UNAVAILABLE' });
  await guard.check('https://missing.example/a');
  await assert.rejects(guard.check('https://challenge.example/a'), { code: 'ROBOTS_UNAVAILABLE' });
  await assert.rejects(f.fetcher('https://source.example/', { beforeRequest: guard.check }), { code: 'ROBOTS_DENIED' });
  assert.equal(f.requests.some(request => request.url === 'https://locked.example/'), false);
});

test('crawl-delay is applied between robots and the very first page', async () => {
  const f = fixture({ routes: { 'https://polite.example/robots.txt': html('User-agent: *\nCrawl-delay: 2', 200, { 'content-type': 'text/plain' }) } });
  const guard = createRobotsGuard(f.fetcher, { minDelayMs: 0 });
  await f.fetcher('https://polite.example/', { beforeRequest: guard.check, minDelayMs: 0 });
  assert.equal(f.requests[1].at - f.requests[0].at, 2000);
});

test('Google key is header-only and cannot escape its fixed endpoint through redirects', async () => {
  const endpoint = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fsafe.example';
  const f = fixture({ routes: { [endpoint]: html('', 302, { location: 'https://other.example/' }) } });
  await assert.rejects(f.fetcher(endpoint, { googleApiKey: 'fixture-not-a-real-key' }), { code: 'API_REDIRECT_DENIED' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.includes('fixture-not-a-real-key'), false);
  assert.equal(f.requests[0].headers['X-Goog-Api-Key'], 'fixture-not-a-real-key');
  await assert.rejects(f.fetcher('https://other.example/', { googleApiKey: 'fixture-not-a-real-key' }), { code: 'API_KEY_SCOPE' });
});

test('hostile robots wildcards do not cause regex backtracking or excessive parsing', () => {
  const policy = parseRobots(`User-agent: *\nDisallow: /${'a*'.repeat(25)}b`);
  const started = performance.now();
  assert.equal(robotsAllows(policy, `https://rules.example/${'a'.repeat(2000)}`), true);
  assert.ok(performance.now() - started < 50);
  assert.throws(() => parseRobots(`User-agent: *\n${'Disallow: /a\n'.repeat(4097)}`), { code: 'ROBOTS_TOO_COMPLEX' });
});

test('Russian legacy charset is decoded without corrupting company identity', () => {
  const word = Buffer.from([0xcc, 0xee, 0xf1, 0xea, 0xe2, 0xe0]);
  assert.equal(decodeResponseBody(word, 'text/html; charset=windows-1251'), 'Москва');
  const body = Buffer.concat([Buffer.from('<meta charset="windows-1251"><p>'), word, Buffer.from('</p>')]);
  assert.ok(decodeResponseBody(body, 'text/html').includes('Москва'));
  assert.throws(() => decodeResponseBody(word, 'text/html; charset=unknown-encoding'), { code: 'UNSUPPORTED_CHARSET' });
});
