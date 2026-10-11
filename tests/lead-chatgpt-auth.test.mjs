// Offline OAuth/JWKS fixtures only. No existing credentials or remote services.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, stat, rm, link, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {createChatGPTCredentials, CHATGPT_REDIRECT_URI} from '../lead-server/chatgpt-auth.mjs';

const ISSUER = 'https://auth.openai.com', CLIENT = 'oaiapp_fixture_client';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const STAMP = Date.parse('2026-10-10T09:00:00Z');
const key = await generateKeyPair('ES256'), wrongKey = await generateKeyPair('ES256');
const jwk = {...await exportJWK(key.publicKey), kid: 'fixture-key', use: 'sig', alg: 'ES256'};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vertux-lead-auth-test-'));
  t.after(async () => { const location = resolve(directory); assert.ok(location.startsWith(resolve(tmpdir()) + sep) && location.includes('vertux-lead-auth-test-')); await rm(location, {recursive: true, force: true}); });
  const ctx = {directory, clock: STAMP, params: null, requests: [], refreshes: 0, tokenCalls: 0, revocations: 0, grant: null, refresh: null, discovery: null, revoke: null};
  ctx.identity = async (changes = {}, signingKey = key.privateKey) => new SignJWT({sub: 'fixture-subject', email: 'owner@fixture.invalid', nonce: ctx.params?.get('nonce'), iss: ISSUER, aud: CLIENT, iat: Math.floor(ctx.clock / 1000), exp: Math.floor(ctx.clock / 1000) + 3600, ...changes}).setProtectedHeader({alg: 'ES256', kid: 'fixture-key'}).sign(signingKey);
  ctx.fetcher = async (url, init = {}) => {
    ctx.requests.push({url, init}); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({keys: [jwk]});
    if (url === `${ISSUER}/.well-known/openid-configuration`) return ctx.discovery ? ctx.discovery() : Response.json({issuer: ISSUER, revocation_endpoint: `${ISSUER}/oauth/revoke`});
    if (url === `${ISSUER}/oauth/revoke`) { ctx.revocations++; return ctx.revoke ? ctx.revoke(init) : new Response(null, {status: 200}); }
    assert.equal(url, `${ISSUER}/api/accounts/oauth/token`, 'Unexpected network destination');
    assert.equal(init.method, 'POST'); assert.match(init.headers['Content-Type'], /application\/x-www-form-urlencoded/);
    const body = new URLSearchParams(init.body); assert.equal(body.get('client_id'), CLIENT); assert.equal(body.get('resource'), 'https://api.openai.com/v1'); assert.equal(body.has('client_secret'), false);
    if (body.get('grant_type') === 'refresh_token') { ctx.refreshes++; return ctx.refresh ? ctx.refresh(body) : Response.json({access_token: 'fixture-access-refreshed', refresh_token: 'fixture-refresh-rotated', token_type: 'Bearer', expires_in: 3600}); }
    ctx.tokenCalls++; assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.get('redirect_uri'), CHATGPT_REDIRECT_URI);
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), ctx.params.get('code_challenge'));
    return ctx.grant ? ctx.grant(body) : Response.json({access_token: 'fixture-access-initial', refresh_token: 'fixture-refresh-initial', id_token: await ctx.identity(), token_type: 'Bearer', expires_in: 3600, scope: SCOPES});
  };
  ctx.newCredentials = () => createChatGPTCredentials({directory, fetcher: ctx.fetcher, now: () => ctx.clock, ...options});
  ctx.auth = ctx.newCredentials();
  ctx.begin = async () => { const result = await ctx.auth.begin(); ctx.params = new URL(result.authorizationUrl).searchParams; return result; };
  ctx.callback = extra => ctx.auth.callback({code: 'fixture-authorization-code', state: ctx.params.get('state'), clientId: CLIENT, ...extra});
  ctx.connect = async () => { await ctx.begin(); return ctx.callback(); };
  ctx.record = async () => JSON.parse(await readFile(join(directory, 'chatgpt-auth.json'), 'utf8'));
  return ctx;
}

test('dynamic registration uses fixed loopback, fresh PKCE, a persistent host and verified identity', async t => {
  const f = await fixture(t), first = await f.begin();
  assert.equal(f.params.get('client_id'), 'dynamic_agent_client'); assert.equal(f.params.get('agent_name_hint'), 'Vertux Workspace');
  assert.equal(f.params.get('scope'), SCOPES); assert.equal(f.params.get('redirect_uri'), CHATGPT_REDIRECT_URI); assert.equal(f.params.get('code_challenge_method'), 'S256');
  const host = f.params.get('ext_agent_host_id'); assert.match(host, /^urn:uuid:/); assert.equal(Date.parse(first.expiresAt), STAMP + 600000);
  const connected = await f.callback(); assert.equal(connected.connected, true); assert.equal(connected.account.label, 'owner@fixture.invalid');
  assert.equal(await f.auth.getAccessToken(), 'fixture-access-initial'); assert.equal(f.refreshes, 0);
  const restarted = f.newCredentials(); assert.deepEqual(await restarted.status(), connected);
  const returning = new URL((await restarted.begin()).authorizationUrl).searchParams;
  assert.equal(returning.get('client_id'), CLIENT); assert.equal(returning.get('ext_agent_host_id'), host); assert.equal(returning.has('agent_name_hint'), false); assert.ok(returning.has('id_token_hint'));
  assert.doesNotMatch(JSON.stringify(connected), /fixture-access|fixture-refresh|eyJ|code_verifier|client_id|ext_agent_host_id/);
  if (process.platform !== 'win32') { assert.equal((await stat(f.directory)).mode & 0o777, 0o700); for (const name of ['host.json', 'chatgpt-auth.json']) assert.equal((await stat(join(f.directory, name))).mode & 0o777, 0o600); }
});

test('state mismatch, expiry, replay and superseded attempts never redeem a code', async t => {
  const f = await fixture(t); await f.begin();
  await assert.rejects(f.callback({state: 'wrong-state'}), {code: 'chatgpt_state_invalid'});
  await assert.rejects(f.callback(), {code: 'chatgpt_state_invalid'});
  await f.begin(); f.clock += 600000; await assert.rejects(f.callback(), {code: 'chatgpt_state_invalid'});
  await f.begin(); const old = f.params.get('state'); await f.begin(); await assert.rejects(f.callback({state: old}), {code: 'chatgpt_state_invalid'});
  assert.equal(f.tokenCalls, 0); await f.connect(); await assert.rejects(f.callback(), {code: 'chatgpt_state_invalid'}); assert.equal(f.tokenCalls, 1);
});

test('authorization cancellation, missing issued client and arbitrary redirects are rejected', async t => {
  const f = await fixture(t);
  for (const redirectUri of ['http://localhost:47922/auth/callback', 'https://evil.invalid/auth/callback', 'http://127.0.0.1:47922/other']) await assert.rejects(f.auth.begin({redirectUri}), {code: 'chatgpt_redirect_invalid'});
  await f.begin(); await assert.rejects(f.callback({error: 'access_denied'}), {code: 'chatgpt_authorization_denied'});
  await f.begin(); await assert.rejects(f.callback({clientId: undefined}), {code: 'chatgpt_client_invalid'});
  await f.begin(); await assert.rejects(f.callback({clientId: 'dynamic_agent_client'}), {code: 'chatgpt_client_invalid'}); assert.equal(f.tokenCalls, 0);
});

test('jose verifies signature, issuer, audience, expiry, issued-at and nonce before accepting credentials', async t => {
  const f = await fixture(t);
  for (const changes of [{iss: 'https://evil.invalid'}, {aud: 'oaiapp_other'}, {exp: Math.floor(STAMP / 1000) - 60}, {iat: Math.floor(STAMP / 1000) + 60}, {nonce: 'wrong-nonce'}, {sub: ''}, {aud: [CLIENT, 'oaiapp_other']}]) {
    await f.begin(); f.grant = async () => Response.json({access_token: 'fixture-access-forbidden', refresh_token: 'fixture-refresh-forbidden', id_token: await f.identity(changes), token_type: 'Bearer', expires_in: 3600, scope: SCOPES});
    await assert.rejects(f.callback(), {code: 'chatgpt_identity_invalid'}); assert.equal((await f.auth.status()).connected, false); assert.equal((await f.record()).tokens, null);
  }
  await f.begin(); f.grant = async () => Response.json({access_token: 'fixture-access-forbidden', refresh_token: 'fixture-refresh-forbidden', id_token: await f.identity({}, wrongKey.privateKey), token_type: 'Bearer', expires_in: 3600, scope: SCOPES});
  await assert.rejects(f.callback(), {code: 'chatgpt_identity_invalid'});
});

test('returning authorization preserves issued client and rejects another verified subject', async t => {
  const f = await fixture(t); const before = await f.connect(); await f.begin();
  await assert.rejects(f.callback({clientId: 'oaiapp_other'}), {code: 'chatgpt_client_invalid'}); assert.equal(f.tokenCalls, 1);
  await f.begin(); f.grant = async () => Response.json({access_token: 'fixture-foreign-access', refresh_token: 'fixture-foreign-refresh', id_token: await f.identity({sub: 'foreign-subject'}), token_type: 'Bearer', expires_in: 3600, scope: SCOPES});
  await assert.rejects(f.callback({clientId: undefined}), {code: 'chatgpt_account_mismatch'}); assert.deepEqual(await f.auth.status(), before); assert.equal(await f.auth.getAccessToken(), 'fixture-access-initial');
  f.grant = null; await f.begin(); assert.equal((await f.callback({clientId: undefined})).connected, true);
});

test('issued registration survives invalid_grant without retaining unusable credentials', async t => {
  const f = await fixture(t); await f.begin(); const host = f.params.get('ext_agent_host_id');
  f.grant = async () => Response.json({error: 'invalid_grant', error_description: 'fixture-secret-that-must-not-leak'}, {status: 400});
  await assert.rejects(f.callback(), error => error.code === 'chatgpt_reauthentication_required' && !JSON.stringify(error).includes('fixture-secret'));
  f.auth = f.newCredentials(); await f.begin(); assert.equal(f.params.get('client_id'), CLIENT); assert.equal(f.params.get('ext_agent_host_id'), host); assert.equal(f.params.has('id_token_hint'), false);
});

test('unsupported server region is reported without tokens, retries, or provider details', async t => {
  const f = await fixture(t);
  for(const error of ['unsupported_country_region_territory',{code:'unsupported_country_region_territory',message:'fixture-private-provider-detail'}]){
    await f.begin();const before=f.tokenCalls;
    f.grant=async()=>Response.json({error,error_description:'fixture-private-provider-detail'},{status:403});
    await assert.rejects(f.callback(),e=>e.code==='chatgpt_region_unsupported'&&e.status===403&&!JSON.stringify(e).includes('fixture-private'));
    assert.equal(f.tokenCalls,before+1);assert.equal((await f.auth.status()).connected,false);
    const saved=await f.record();assert.equal(saved.client_id,CLIENT);assert.equal(saved.tokens,null);
  }
});

test('identity-only or downgraded scope never authorizes inference', async t => {
  const f = await fixture(t); await f.connect(); await f.begin();
  f.grant = async () => Response.json({access_token: 'fixture-limited-access', refresh_token: 'fixture-limited-refresh', id_token: await f.identity(), token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access'});
  await assert.rejects(f.callback(), {code: 'chatgpt_scope_required'}); assert.equal((await f.auth.status()).connected, false); assert.ok((await f.auth.status()).account);
  await assert.rejects(f.auth.getAccessToken(), {code: 'chatgpt_not_connected'}); assert.equal((await f.record()).tokens, null);
});

test('concurrent callers and two instances serialize refresh and atomically retain rotated tokens', async t => {
  const f = await fixture(t); await f.connect(); f.clock += 3550000;
  f.refresh = async body => { assert.equal(body.get('refresh_token'), 'fixture-refresh-initial'); assert.equal(body.has('scope'), false); await new Promise(done => setTimeout(done, 40)); return Response.json({access_token: 'fixture-access-refreshed', refresh_token: 'fixture-refresh-rotated', token_type: 'Bearer', expires_in: 3600}); };
  const second = f.newCredentials(); const results = await Promise.all(Array.from({length: 12}, (_, i) => (i % 2 ? second : f.auth).getAccessToken()));
  assert.ok(results.every(token => token === 'fixture-access-refreshed')); assert.equal(f.refreshes, 1);
  const stored = await f.record(); assert.equal(stored.tokens.refresh_token, 'fixture-refresh-rotated'); assert.equal(stored.tokens.access_token, 'fixture-access-refreshed'); assert.equal(stored.client_id, CLIENT); assert.ok(stored.scopes.includes('chatgpt.tokens.use.direct'));
});

test('separate OS processes cannot race a rotating refresh token', async t => {
  const f = await fixture(t); await f.connect(); f.clock += 3550000;
  const source = `import {appendFile} from 'node:fs/promises'; import {join} from 'node:path'; import {createChatGPTCredentials} from ${JSON.stringify(new URL('../lead-server/chatgpt-auth.mjs', import.meta.url).href)};
    const directory=process.argv[1], clock=Number(process.argv[2]);
    const credentials=createChatGPTCredentials({directory,now:()=>clock,fetcher:async(url,init)=>{
      if(url!=='https://auth.openai.com/api/accounts/oauth/token'||new URLSearchParams(init.body).get('grant_type')!=='refresh_token')throw Error('Unexpected destination');
      await appendFile(join(directory,'refresh-fixture.log'),'refresh\\n'); await new Promise(done=>setTimeout(done,150));
      return Response.json({access_token:'fixture-child-access',refresh_token:'fixture-child-rotated',token_type:'Bearer',expires_in:3600});
    }});
    if(await credentials.getAccessToken()!=='fixture-child-access')process.exitCode=1;`;
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, f.directory, String(f.clock)], {windowsHide: true, timeout: 10000, maxBuffer: 1024});
  await Promise.all([run(), run()]);
  assert.equal((await readFile(join(f.directory, 'refresh-fixture.log'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await f.record()).tokens.refresh_token, 'fixture-child-rotated');
});

test('a crashed process or incomplete old lock does not block later startup', async t => {
  const f = await fixture(t); await f.auth.status();
  const child = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {windowsHide: true, timeout: 5000});
  const lockPath = join(f.directory, '.oauth.lock'), past = new Date(Date.now() - 60000);
  for (const owner of [`${Number(child.stdout)}:fixture-exited-process`, '']) {
    await writeFile(lockPath, owner, {mode: 0o600}); await utimes(lockPath, past, past);
    assert.equal((await f.auth.status()).connected, false);
  }
});

test('refresh invalid_grant clears tokens, retains account, and never includes provider errors', async t => {
  const f = await fixture(t); const before = await f.connect(); f.clock += 3600000;
  f.refresh = async () => Response.json({error: 'invalid_grant', error_description: 'fixture-refresh-token-private'}, {status: 400});
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'chatgpt_reauthentication_required' && !String(error).includes('fixture-refresh-token-private'));
  const after = await f.auth.status(); assert.equal(after.connected, false); assert.deepEqual(after.account, before.account); assert.equal((await f.record()).tokens, null);
});

test('network failures preserve renewable credentials and aborted requests do not call provider', async t => {
  const f = await fixture(t); await f.connect(); f.clock += 3600000;
  f.refresh = async () => { throw new Error('fixture-refresh-token-private'); };
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'chatgpt_oauth_unavailable' && !String(error).includes('fixture-refresh-token-private'));
  assert.ok((await f.record()).tokens.refresh_token); const count = f.refreshes;
  await assert.rejects(f.auth.getAccessToken({signal: AbortSignal.abort(new Error('private-abort-reason'))}), {code: 'chatgpt_request_aborted'}); assert.equal(f.refreshes, count);
});

test('sign out retries trusted revocation and clears only credentials, preserving host/account/client', async t => {
  const f = await fixture(t); const before = await f.connect(), record = await f.record();
  f.revoke = async init => { const body = new URLSearchParams(init.body); assert.equal(body.get('client_id'), CLIENT); assert.equal(body.get('token_type_hint'), 'refresh_token'); assert.equal(body.get('token'), 'fixture-refresh-initial'); return new Response(null, {status: f.revocations < 2 ? 503 : 200}); };
  const result = await f.auth.disconnect(); assert.equal(result.remoteRevoked, true); assert.equal(result.connected, false); assert.equal(f.revocations, 2); assert.deepEqual(result.account, before.account);
  const after = await f.record(); assert.equal(after.tokens, null); assert.equal(after.client_id, record.client_id); assert.equal(after.ext_agent_host_id, record.ext_agent_host_id);
  await f.begin(); assert.equal(f.params.get('client_id'), CLIENT); assert.equal(f.params.has('id_token_hint'), false); assert.equal(f.params.get('ext_agent_host_id'), record.ext_agent_host_id);
});

test('untrusted or failed discovery never receives tokens and local disconnect still completes', async t => {
  const f = await fixture(t); await f.connect();
  f.discovery = async () => Response.json({issuer: ISSUER, revocation_endpoint: 'https://evil.invalid/revoke'});
  const result = await f.auth.disconnect(); assert.equal(result.remoteRevoked, false); assert.equal(result.connected, false); assert.equal(f.revocations, 0); assert.equal(f.requests.some(item => item.url.includes('evil.invalid')), false);
  await f.connect(); f.discovery = async () => { throw Error('private-network-diagnostic'); };
  assert.equal((await f.auth.disconnect()).remoteRevoked, false); assert.equal((await f.record()).tokens, null);
});

test('credential import preserves the VM host and rejects aliased storage files', async t => {
  const f = await fixture(t); await f.connect(); const host = JSON.parse(await readFile(join(f.directory, 'host.json'), 'utf8'));
  const record = await f.record(); record.ext_agent_host_id = 'urn:uuid:11111111-1111-4111-8111-111111111111'; await writeFile(join(f.directory, 'chatgpt-auth.json'), JSON.stringify(record));
  const params = new URL((await f.newCredentials().begin()).authorizationUrl).searchParams; assert.equal(params.get('ext_agent_host_id'), host.ext_agent_host_id);
  await link(join(f.directory, 'chatgpt-auth.json'), join(f.directory, 'alias.json'));
  await assert.rejects(f.newCredentials().status(), {code: 'chatgpt_storage_unsafe'});
});

test('refresh rejects a changed identity and clears compromised replacement credentials', async t => {
  const f = await fixture(t); const before = await f.connect(); f.clock += 3600000;
  f.refresh = async () => Response.json({access_token: 'fixture-foreign-access', refresh_token: 'fixture-foreign-refresh', id_token: await f.identity({sub: 'foreign-subject'}), token_type: 'Bearer', expires_in: 3600});
  await assert.rejects(f.auth.getAccessToken(), {code: 'chatgpt_account_mismatch'}); assert.equal((await f.auth.status()).connected, false); assert.deepEqual((await f.auth.status()).account, before.account);
});
