import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {mkdir, open, readFile, lstat, chmod, rename, unlink} from 'node:fs/promises';
import {resolve, join, isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_REDIRECT_URI = 'http://127.0.0.1:47922/auth/callback';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const PLAN_SCOPES = ['resource.invoke', 'chatgpt.tokens.use.direct'];
const TTL = 600000, MAX_FILE = 256 * 1024;
const queues = new Map();
const execute = promisify(execFile);
export class ChatGPTAuthError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'ChatGPTAuthError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ChatGPTAuthError(code, status); };
const opaque = (value, max = 32768) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\u0000-\u001f\u007f]/.test(value);
const issuedClient = value => opaque(value, 256) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value !== 'dynamic_agent_client';
const scopesFor = value => {
  if (typeof value !== 'string' || value.length > 2048) fail('chatgpt_scope_required', 403);
  const scopes = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (scopes.some(scope => !/^[A-Za-z0-9._:-]{1,150}$/.test(scope))) fail('chatgpt_scope_required', 403);
  return scopes;
};
const hasPlan = scopes => PLAN_SCOPES.every(scope => scopes.includes(scope));
const pause = ms => new Promise(done => setTimeout(done, ms));
const aborted = signal => { if (signal?.aborted) fail('chatgpt_request_aborted', 499); };
const safeLabel = value => String(value || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 160);

// The caller chooses one dedicated runtime directory; no other application's
// credentials are read. Unix modes and Windows DACLs both restrict this directory.
export function createChatGPTCredentials({directory, fetcher = fetch, now = Date.now, verifyIdentity} = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('chatgpt_storage_configuration', 500);
  const root = resolve(directory), hostPath = join(root, 'host.json'), authPath = join(root, 'chatgpt-auth.json'), lockPath = join(root, '.oauth.lock');
  let prepared = false, pending = null, keySet = null, keysAt = 0;

  async function prepare() {
    if (prepared) return;
    await mkdir(root, {recursive: true, mode: 0o700});
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('chatgpt_storage_unsafe', 500);
    for (const path of [hostPath, authPath]) {
      try { const item = await lstat(path); if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1) fail('chatgpt_storage_unsafe', 500); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (process.platform === 'win32') {
      // Static script, path passed as data. Inheritance from a broadly readable
      // parent is removed before any credential file is read or created.
      const script = "$ErrorActionPreference='Stop'; $who=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'); $paths=@($env:VERTUX_AUTH_DIRECTORY); foreach($name in @('host.json','chatgpt-auth.json')) { $path=Join-Path $env:VERTUX_AUTH_DIRECTORY $name; if(Test-Path -LiteralPath $path) {$paths+=$path} }; foreach($path in $paths) { $item=Get-Item -LiteralPath $path -Force; if($item.PSIsContainer) { $acl=[System.Security.AccessControl.DirectorySecurity]::new(); foreach($sid in @($who,$system)) {$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))} } else { $acl=[System.Security.AccessControl.FileSecurity]::new(); foreach($sid in @($who,$system)) {$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))} }; $acl.SetOwner($who); $acl.SetAccessRuleProtection($true,$false); if($item.PSIsContainer) {[System.IO.Directory]::SetAccessControl($path,$acl)} else {[System.IO.File]::SetAccessControl($path,$acl)} }";
      await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, timeout: 10000, maxBuffer: 1024, env: {...process.env, VERTUX_AUTH_DIRECTORY: root}});
    } else {
      await chmod(root, 0o700);
      for (const path of [hostPath, authPath]) try { await chmod(path, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    prepared = true;
  }
  async function readRecord(path) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE) fail('chatgpt_storage_unsafe', 500);
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function writeRecord(path, value) {
    const temp = join(root, `.${randomUUID()}.tmp`); let handle;
    try {
      handle = await open(temp, 'wx', 0o600); await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await rename(temp, path);
      if (process.platform !== 'win32') { const dir = await open(root, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await handle?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  }
  async function acquire(signal) {
    const deadline = Date.now() + 30000, owner = `${process.pid}:${randomUUID()}`;
    for (;;) {
      aborted(signal);
      try {
        const file = await open(lockPath, 'wx', 0o600);
        try { await file.writeFile(owner); } catch (error) { await file.close(); await unlink(lockPath).catch(() => {}); throw error; }
        await file.close(); return owner;
      }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      try {
        const stat = await lstat(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 100) fail('chatgpt_storage_unsafe', 500);
        const value = await readFile(lockPath, 'utf8'), pid = Number(value.split(':')[0]);
        if (Date.now() - stat.mtimeMs > 30000 && !value) { await unlink(lockPath); continue; }
        if (Date.now() - stat.mtimeMs > 1000 && Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { await unlink(lockPath); continue; } }
        }
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (Date.now() >= deadline) fail('chatgpt_storage_busy', 503);
      await pause(30);
    }
  }
  function locked(operation, signal) {
    const before = queues.get(root) || Promise.resolve();
    const result = before.catch(() => {}).then(async () => {
      let owner;
      try { await prepare(); owner = await acquire(signal); return await operation(); }
      catch (error) { if (error instanceof ChatGPTAuthError) throw error; fail('chatgpt_storage_unavailable', 503); }
      finally { if (owner) try { if (await readFile(lockPath, 'utf8') === owner) await unlink(lockPath); } catch {} }
    });
    queues.set(root, result); void result.finally(() => { if (queues.get(root) === result) queues.delete(root); }).catch(() => {});
    return result;
  }
  async function state() {
    let host = await readRecord(hostPath);
    if (!host) { host = {version: 1, ext_agent_host_id: `urn:uuid:${randomUUID()}`}; await writeRecord(hostPath, host); }
    if (host.version !== 1 || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(host.ext_agent_host_id || '')) fail('chatgpt_storage_invalid', 500);
    const record = await readRecord(authPath) || {version: 1, issuer: ISSUER, client_id: null, subject: null, label: null, email: null, scopes: [], tokens: null};
    if (record.version !== 1 || record.issuer !== ISSUER || (record.client_id !== null && !issuedClient(record.client_id)) || (record.subject !== null && !opaque(record.subject, 512)) || !Array.isArray(record.scopes) || record.scopes.some(s => typeof s !== 'string') || (record.tokens !== null && (!record.subject || !record.client_id || !opaque(record.tokens?.access_token) || !opaque(record.tokens?.refresh_token) || !Number.isFinite(record.tokens.expires_at)))) fail('chatgpt_storage_invalid', 500);
    // Importing a credential session must never import another machine's host ID.
    record.ext_agent_host_id = host.ext_agent_host_id;
    return record;
  }
  function summary(record) {
    return {connected: Boolean(record.tokens && hasPlan(record.scopes)), scopes: [...record.scopes], account: record.subject ? {id: createHash('sha256').update(`${ISSUER}\0${record.client_id}\0${record.subject}`).digest('hex').slice(0, 32), label: safeLabel(record.label) || 'ChatGPT'} : null};
  }
  async function request(url, options = {}, signal, timeout = 15000) {
    aborted(signal);
    try { return await fetcher(url, {...options, redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)}); }
    catch { aborted(signal); fail('chatgpt_oauth_unavailable', 503); }
  }
  async function json(response) {
    try {
      const reader = response.body?.getReader(); if (!reader) throw Error(); const chunks = []; let size = 0;
      for (;;) { const {done, value} = await reader.read(); if (done) break; if ((size += value.byteLength) > MAX_FILE) { await reader.cancel(); throw Error(); } chunks.push(Buffer.from(value)); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value;
    } catch { fail('chatgpt_oauth_invalid_response', 502); }
  }
  async function tokenRequest(body, signal) {
    const response = await request(TOKEN, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'}, body: new URLSearchParams(body)}, signal);
    const data = await json(response);
    if (!response.ok) {
      if (data.error === 'invalid_grant' || data.error === 'invalid_client') fail('chatgpt_reauthentication_required', 401);
      fail('chatgpt_oauth_unavailable', 503);
    }
    return data;
  }
  async function verified(idToken, clientId, nonce, signal) {
    if (!opaque(idToken)) fail('chatgpt_identity_invalid', 401);
    const options = {issuer: ISSUER, audience: clientId, nonce, now: now(), signal}; let payload;
    try {
      if (verifyIdentity) payload = await verifyIdentity(idToken, options);
      else {
        const jose = await import('jose');
        const loadKeys = async () => { const response = await request(JWKS, {headers: {Accept: 'application/json'}}, signal); if (!response.ok) fail('chatgpt_identity_unavailable', 503); const keys = await json(response); if (!Array.isArray(keys.keys) || !keys.keys.length || keys.keys.length > 32) fail('chatgpt_identity_invalid', 401); keySet = jose.createLocalJWKSet(keys); keysAt = now(); };
        if (!keySet || now() - keysAt > 300000) await loadKeys();
        const check = () => jose.jwtVerify(idToken, keySet, {issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], algorithms: ['RS256', 'ES256'], clockTolerance: 5, currentDate: new Date(now())});
        try { ({payload} = await check()); } catch (error) { if (error.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error; await loadKeys(); ({payload} = await check()); }
      }
      const audience = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud], seconds = now() / 1000;
      if (!payload || payload.iss !== ISSUER || !audience.includes(clientId) || (audience.length > 1 && payload.azp !== clientId) || !opaque(payload.sub, 512) || !Number.isFinite(payload.exp) || payload.exp <= seconds - 5 || !Number.isFinite(payload.iat) || payload.iat > seconds + 5 || (nonce !== undefined && payload.nonce !== nonce)) throw Error();
      return payload;
    } catch (error) { if (signal?.aborted) fail('chatgpt_request_aborted', 499); if (error instanceof ChatGPTAuthError && error.status === 503) throw error; fail('chatgpt_identity_invalid', 401); }
  }
  function credentials(data, previous = null) {
    if (!opaque(data.access_token) || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31536000 || !opaque(data.refresh_token ?? previous?.refresh_token) || (data.id_token !== undefined && !opaque(data.id_token))) fail('chatgpt_oauth_invalid_response', 502);
    return {access_token: data.access_token, refresh_token: data.refresh_token ?? previous.refresh_token, id_token: data.id_token ?? previous?.id_token ?? null, token_type: 'Bearer', expires_at: now() + data.expires_in * 1000, saved_at: new Date(now()).toISOString()};
  }
  async function saveGrant(record, data, identity, previous = null) {
    const scopes = data.scope === undefined && previous ? record.scopes : scopesFor(data.scope);
    if (record.subject && identity && record.subject !== identity.sub) fail('chatgpt_account_mismatch', 403);
    if (identity) { record.subject = identity.sub; record.label ||= safeLabel(identity.email || identity.name) || 'ChatGPT'; record.email = typeof identity.email === 'string' ? safeLabel(identity.email) : record.email; }
    if (!hasPlan(scopes)) { record.scopes = scopes; record.tokens = null; await writeRecord(authPath, record); fail('chatgpt_scope_required', 403); }
    record.tokens = credentials(data, previous); record.scopes = scopes; await writeRecord(authPath, record); return summary(record);
  }

  return Object.freeze({
    status: () => locked(async () => summary(await state())),
    begin: ({redirectUri = CHATGPT_REDIRECT_URI} = {}) => locked(async () => {
      if (redirectUri !== CHATGPT_REDIRECT_URI) fail('chatgpt_redirect_invalid');
      const record = await state(), verifier = randomBytes(64).toString('base64url');
      pending = {state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier, clientId: record.client_id, subject: record.subject, redirectUri, expiresAt: now() + TTL};
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({client_id: record.client_id || 'dynamic_agent_client', ext_agent_host_id: record.ext_agent_host_id, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES.join(' '), resource: RESOURCE, state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')}).toString();
      if (!record.client_id) url.searchParams.set('agent_name_hint', 'Vertux Workspace');
      if (record.tokens?.id_token) url.searchParams.set('id_token_hint', record.tokens.id_token);
      if (record.email) url.searchParams.set('login_hint', record.email);
      return {authorizationUrl: url.href, expiresAt: new Date(pending.expiresAt).toISOString()};
    }),
    callback: ({code, state: returnedState, clientId, error: oauthError, signal} = {}) => locked(async () => {
      const transaction = pending; pending = null;
      if (!transaction || transaction.expiresAt <= now() || typeof returnedState !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(returnedState) || !timingSafeEqual(Buffer.from(returnedState), Buffer.from(transaction.state))) fail('chatgpt_state_invalid', 401);
      if (oauthError) fail('chatgpt_authorization_denied', 403);
      if (!opaque(code, 4096)) fail('chatgpt_code_invalid');
      const record = await state();
      if (record.client_id !== transaction.clientId || record.subject !== transaction.subject) fail('chatgpt_session_changed', 409);
      const selected = transaction.clientId || clientId;
      if (!issuedClient(selected) || (clientId !== undefined && clientId !== selected)) fail('chatgpt_client_invalid', 401);
      if (!record.client_id) { record.client_id = selected; await writeRecord(authPath, record); }
      const data = await tokenRequest({grant_type: 'authorization_code', client_id: selected, code, code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: RESOURCE}, signal);
      const identity = await verified(data.id_token, selected, transaction.nonce, signal);
      return saveGrant(record, data, identity);
    }, signal),
    getAccessToken: ({signal} = {}) => locked(async () => {
      const record = await state(); if (!record.tokens) fail('chatgpt_not_connected', 401); if (!hasPlan(record.scopes)) fail('chatgpt_scope_required', 403);
      if (record.tokens.expires_at > now() + 60000) return record.tokens.access_token;
      try {
        const data = await tokenRequest({grant_type: 'refresh_token', client_id: record.client_id, refresh_token: record.tokens.refresh_token, resource: RESOURCE}, signal);
        const identity = data.id_token ? await verified(data.id_token, record.client_id, undefined, signal) : null;
        await saveGrant(record, data, identity, record.tokens); return record.tokens.access_token;
      } catch (error) { if (['chatgpt_reauthentication_required', 'chatgpt_account_mismatch', 'chatgpt_identity_invalid'].includes(error.code)) { record.tokens = null; await writeRecord(authPath, record); } throw error; }
    }, signal),
    disconnect: () => locked(async () => {
      pending = null; const record = await state(); let remoteRevoked = false;
      try {
        if (record.tokens?.refresh_token) {
          const discovery = await request(DISCOVERY, {headers: {Accept: 'application/json'}}, undefined, 5000);
          if (discovery.ok) {
            const config = await json(discovery), endpoint = new URL(config.revocation_endpoint);
            if (config.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('chatgpt_revocation_untrusted', 502);
            for (let attempt = 0; attempt < 3; attempt++) {
              try { const response = await request(endpoint.href, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: record.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: record.client_id})}, undefined, 5000); if (response.status === 200) { remoteRevoked = true; break; } if (response.status < 500) break; }
              catch {}
              if (attempt < 2) await pause(100 * (2 ** attempt));
            }
          }
        }
      } catch {} finally { record.tokens = null; await writeRecord(authPath, record); }
      return {...summary(record), remoteRevoked};
    })
  });
}
