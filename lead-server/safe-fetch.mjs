import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

export const CRAWLER_AGENT = 'VertuxLeadResearch/1.0';
export class ResearchFetchError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'ResearchFetchError'; this.code = code; Object.assign(this, details); }
}
const error = (code, details) => new ResearchFetchError(code, details);
const clamp = (value, fallback, low, high) => Number.isFinite(Number(value)) ? Math.max(low, Math.min(high, Number(value))) : fallback;
const ipv4Number = address => address.split('.').reduce((n, octet) => (n * 256) + Number(octet), 0);
const in4 = (n, base, bits) => Math.floor(n / (2 ** (32 - bits))) === Math.floor(ipv4Number(base) / (2 ** (32 - bits)));

// Conservative public-unicast allowlist. Transition, documentation and special-use
// ranges are deliberately excluded even when an individual address is routable.
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const n = ipv4Number(address);
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['168.63.129.16', 32], ['224.0.0.0', 3],
    ].some(([base, bits]) => in4(n, base, bits));
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(p => parseInt(p || '0', 16));
  if ((parts[0] & 0xe000) !== 0x2000) return false;
  if (parts[0] === 0x2001 && (parts[1] <= 0x01ff || parts[1] === 0x0db8)) return false;
  if (parts[0] === 0x2002 || parts[0] === 0x3ffe || parts[0] === 0x3fff) return false;
  return true;
}

export function normalizePublicUrl(input, base) {
  let url;
  try { url = new URL(String(input), base); } catch { throw error('INVALID_URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) throw error('UNSAFE_URL');
  if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) throw error('UNSAFE_PORT');
  if (!host || (!net.isIP(host) && (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host)))) throw error('UNSAFE_HOST');
  if (net.isIP(host) && !isPublicAddress(host)) throw error('PRIVATE_ADDRESS');
  for (const key of url.searchParams.keys()) {
    if (/^(?:token|access_token|auth|authorization|password|secret|api[_-]?key|key|session|code|signature)$/i.test(key)) throw error('SENSITIVE_URL');
  }
  url.hash = '';
  return url;
}

export async function resolvePublicTarget(input, { resolver = dns.lookup, signal } = {}) {
  const url = input instanceof URL ? normalizePublicUrl(input.href) : normalizePublicUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  signal?.throwIfAborted();
  let records;
  try {
    records = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await raceAbort(resolver(hostname, { all: true, verbatim: true }), signal);
  } catch (cause) { if (signal?.aborted) throw error(signal.reason?.code || 'REQUEST_ABORTED'); throw error('DNS_FAILED'); }
  if (!Array.isArray(records) || !records.length || records.some(record => !isPublicAddress(record.address) || Number(record.family) !== net.isIP(record.address))) throw error('PRIVATE_ADDRESS');
  return { hostname, address: records[0].address, family: Number(records[0].family) };
}

export function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || error('REQUEST_ABORTED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || error('REQUEST_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || error('REQUEST_ABORTED')); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason || error('REQUEST_ABORTED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function decodeResponseBody(body, contentType = '') {
  let encoding = String(contentType).match(/charset\s*=\s*["']?([a-z0-9_-]+)/i)?.[1];
  if (!encoding && /(?:text\/html|xhtml)/i.test(contentType)) encoding = body.subarray(0, 2048).toString('latin1').match(/charset\s*=\s*["']?([a-z0-9_-]+)/i)?.[1];
  if (body[0] === 0xff && body[1] === 0xfe) encoding = 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) encoding = 'utf-16be';
  try { return new TextDecoder(encoding || 'utf-8').decode(body); }
  catch { throw error('UNSUPPORTED_CHARSET'); }
}

function pinnedRequest(url, target, { signal, maxBytes, headers, now }) {
  return new Promise((resolve, reject) => {
    const started = now();
    // Connect to the validated numeric address, never resolve the hostname again.
    // Host/SNI/certificate validation retain the original origin.
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol, hostname: target.address, family: target.family,
      port: url.protocol === 'https:' ? 443 : 80, method: 'GET', path: url.pathname + url.search,
      agent: false, signal, maxHeaderSize: 32768, insecureHTTPParser: false,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(target.hostname, certificate),
      headers: { ...headers, Host: url.host, Connection: 'close' },
    }, response => {
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
      const length = Number(responseHeaders['content-length']);
      if (Number.isFinite(length) && length > maxBytes) { response.destroy(); reject(error('BODY_TOO_LARGE')); return; }
      if (responseHeaders['content-encoding'] && responseHeaders['content-encoding'] !== 'identity') { response.destroy(); reject(error('UNSUPPORTED_ENCODING')); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); reject(error('BODY_TOO_LARGE')); } else chunks.push(chunk);
      });
      response.on('error', () => reject(signal?.aborted ? signal.reason : error('RESPONSE_FAILED')));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        try { resolve({ status: response.statusCode, headers: responseHeaders, body, text: decodeResponseBody(body, responseHeaders['content-type']), bytes, durationMs: now() - started }); }
        catch (cause) { reject(cause); }
      });
    });
    request.on('error', () => reject(signal?.aborted ? signal.reason : error('REQUEST_FAILED')));
    request.end();
  });
}

export function retryAfterMs(value, now = Date.now()) {
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(String(value))) return Math.max(0, Math.min(8640000000000000 - now, Number(value) * 1000));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : 60000;
}

const hostSchedule = new Map();
export function createSafeFetcher({ resolver = dns.lookup, transport = pinnedRequest, now = Date.now, sleep = waitFor, schedule = hostSchedule } = {}) {
  return async function safeFetch(input, options = {}) {
    let url = normalizePublicUrl(input); const redirects = [];
    const timeoutMs = clamp(options.timeoutMs, 12000, 50, 30000);
    const maxBytes = clamp(options.maxBytes, 1024 * 1024, 1, 4 * 1024 * 1024);
    const controller = new AbortController();
    const abort = () => controller.abort(error('REQUEST_ABORTED'));
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(error('REQUEST_TIMEOUT')), timeoutMs);
    const allowedHeaders = { 'User-Agent': CRAWLER_AGENT, Accept: options.accept || 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8', 'Accept-Encoding': 'identity' };
    if (options.googleApiKey) {
      if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/pagespeedonline/v5/runPagespeed' || typeof options.googleApiKey !== 'string' || options.googleApiKey.length > 256 || /[\r\n]/.test(options.googleApiKey)) { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); throw error('API_KEY_SCOPE'); }
      allowedHeaders['X-Goog-Api-Key'] = options.googleApiKey;
    }
    // Only fixed, explicitly supported cache headers can come from stored pages.
    for (const name of ['if-none-match', 'if-modified-since']) {
      const value = options.headers?.[name];
      if (typeof value === 'string' && value.length <= 512 && !/[\r\n]/.test(value)) allowedHeaders[name] = value;
    }
    try {
      for (let hop = 0; hop <= 5; hop++) {
        const policy = await raceAbort(options.beforeRequest?.(url, { signal: controller.signal }), controller.signal);
        const delay = Math.max(0, Number(options.minDelayMs) || 0, Number(policy?.crawlDelayMs) || 0);
        const key = url.hostname.toLowerCase(); const existing = schedule.get(key) || { next: 0, retryUntil: 0 };
        if (existing.retryUntil > now()) throw error('RATE_LIMITED', { retryAt: new Date(existing.retryUntil).toISOString() });
        const start = Math.max(now(), existing.next, (existing.lastStart || 0) + delay);
        if (start - now() >= timeoutMs) throw error('CRAWL_DELAY', { retryAt: new Date(start).toISOString() });
        schedule.set(key, { next: start + delay, retryUntil: existing.retryUntil, lastStart: start });
        if (schedule.size > 5000) for (const [entry, state] of schedule) if (state.next < now() && state.retryUntil < now()) schedule.delete(entry);
        await raceAbort(sleep(start - now(), controller.signal), controller.signal);
        const target = await resolvePublicTarget(url, { resolver, signal: controller.signal });
        options.onRequest?.({ url: url.href });
        const response = await raceAbort(transport(url, target, { signal: controller.signal, maxBytes, headers: allowedHeaders, now }), controller.signal);
        if (!response || typeof response.status !== 'number') throw error('INVALID_RESPONSE');
        if (response.bytes > maxBytes || Buffer.byteLength(response.text || '') > maxBytes) throw error('BODY_TOO_LARGE');
        if (response.status === 429 || response.status === 503) {
          const retryUntil = now() + retryAfterMs(response.headers?.['retry-after'], now());
          schedule.set(key, { next: retryUntil, retryUntil, lastStart: now() });
          throw error('RATE_LIMITED', { retryAt: new Date(retryUntil).toISOString(), status: response.status });
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.headers?.location || hop === 5) throw error('REDIRECT_LIMIT');
          redirects.push(url.href);
          const next = normalizePublicUrl(response.headers.location, url);
          if (options.googleApiKey && (next.origin !== url.origin || next.pathname !== url.pathname)) throw error('API_REDIRECT_DENIED');
          if (url.protocol === 'https:' && next.protocol === 'http:') throw error('INSECURE_REDIRECT');
          url = next;
          continue;
        }
        return { ...response, url: url.href, redirects };
      }
      throw error('REDIRECT_LIMIT');
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cause instanceof ResearchFetchError) throw cause;
      throw error('REQUEST_FAILED');
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  };
}

function normalizeRobotsPath(value) {
  return Array.from(value).join('').replace(/%[0-9a-f]{2}|[^\x00-\x7F]/giu, part => {
    if (part[0] === '%') { const char = String.fromCharCode(parseInt(part.slice(1), 16)); return /[A-Za-z0-9._~-]/.test(char) ? char : part.toUpperCase(); }
    return encodeURIComponent(part);
  });
}

export function parseRobots(text, userAgent = CRAWLER_AGENT) {
  const groups = []; let group = null; let hasRules = false; let ruleCount = 0;
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = raw.replace(/#.*/, '').match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2];
    if (key === 'user-agent') {
      if (!group || hasRules) { group = { agents: [], rules: [], crawlDelayMs: 0 }; groups.push(group); hasRules = false; }
      if (value) group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow', 'crawl-delay'].includes(key)) {
      hasRules = true;
      if (key === 'crawl-delay') { if (/^\d+(?:\.\d+)?$/.test(value)) group.crawlDelayMs = Math.max(group.crawlDelayMs, Number(value) * 1000); }
      else if (value) {
        const path = normalizeRobotsPath(value).replace(/\*+/g, '*');
        if (path.length > 4096 || ++ruleCount > 4096) throw error('ROBOTS_TOO_COMPLEX');
        group.rules.push({ allow: key === 'allow', path });
      }
    }
  }
  const agent = userAgent.split('/')[0].toLowerCase();
  const specificity = group => Math.max(-1, ...group.agents.map(value => value === '*' ? 0 : agent.includes(value) ? value.length : -1));
  const best = Math.max(-1, ...groups.map(specificity));
  const selected = groups.filter(group => best >= 0 && specificity(group) === best);
  return { rules: selected.flatMap(group => group.rules), crawlDelayMs: Math.max(0, ...selected.map(group => group.crawlDelayMs)) };
}

export function robotsAllows(policy, input) {
  const url = new URL(input);
  if (url.pathname === '/robots.txt') return true;
  if (policy.denyAll) return false;
  const path = normalizeRobotsPath(url.pathname + url.search);
  let winner = null;
  for (const rule of policy.rules || []) {
    const terminal = rule.path.endsWith('$');
    const pattern = terminal ? rule.path.slice(0, -1) : rule.path;
    const length = Buffer.byteLength(pattern.replace(/\*/g, '').replace(/%[0-9a-f]{2}/gi, 'x'));
    if (globPrefixMatches(pattern, path, terminal) && (!winner || length > winner.length || (length === winner.length && rule.allow))) winner = { allow: rule.allow, length };
  }
  return !winner || winner.allow;
}

// Ordered literal searches implement REP's only wildcard without constructing a
// backtracking regular expression from an untrusted robots.txt rule.
function globPrefixMatches(pattern, path, terminal) {
  const parts = pattern.split('*');
  if (!path.startsWith(parts[0])) return false;
  if (parts.length === 1) return !terminal || path.length === pattern.length;
  let cursor = parts[0].length;
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index];
    if (terminal && index === parts.length - 1) return path.endsWith(part) && path.length - part.length >= cursor;
    if (!part) continue;
    const found = path.indexOf(part, cursor);
    if (found < 0) return false;
    cursor = found + part.length;
  }
  return true;
}

export function createRobotsGuard(fetcher, { signal, timeoutMs = 12000, minDelayMs = 1000, onRequest, now = Date.now } = {}) {
  const policies = new Map();
  async function getPolicy(input) {
    const url = normalizePublicUrl(input); const origin = url.origin;
    if (!policies.has(origin)) policies.set(origin, (async () => {
      const response = await fetcher(`${origin}/robots.txt`, { signal, timeoutMs, minDelayMs, maxBytes: 512 * 1024, accept: 'text/plain', onRequest });
      if (response.status >= 200 && response.status < 300) {
        if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(response.text) || /text\/html/i.test(response.headers?.['content-type'] || '')) throw error('ROBOTS_UNAVAILABLE');
        return { ...parseRobots(response.text), checkedAt: new Date(now()).toISOString(), url: response.url, status: 'checked' };
      }
      if ([401, 403].includes(response.status)) return { rules: [], denyAll: true, crawlDelayMs: 0, status: 'denied' };
      if (response.status >= 400 && response.status < 500) return { rules: [], crawlDelayMs: 0, status: 'not_provided' };
      throw error('ROBOTS_UNAVAILABLE');
    })());
    return policies.get(origin);
  }
  const check = async input => {
    const policy = await getPolicy(input);
    if (!robotsAllows(policy, input)) throw error('ROBOTS_DENIED');
    if (policy.crawlDelayMs >= timeoutMs) throw error('CRAWL_DELAY', { retryAt: new Date(now() + policy.crawlDelayMs).toISOString() });
    return policy;
  };
  return { check, getPolicy };
}

export const safeFetch = createSafeFetcher();
