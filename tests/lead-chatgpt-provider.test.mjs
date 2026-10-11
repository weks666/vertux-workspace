import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatGPTProvider } from '../lead-server/chatgpt-provider.mjs';
import { makeAnalysisPrompt } from '../lead-server/ai.mjs';
import { validateAnalysisPlan } from '../lead-server/sales.mjs';

// Every network and credential operation is an isolated fixture. This suite
// neither reads credential files nor makes a request to any real provider.
const MODELS = 'https://api.openai.com/v1/models';
const RESPONSES = 'https://api.openai.com/v1/responses';
const NOW = Date.parse('2026-10-10T10:00:00Z');
const connected = (id = 'fixture-account') => ({ connected: true, scopes: ['openid', 'chatgpt.tokens.use.direct'], account: { id, label: 'Fixture account' } });
const small = { slug: 'fixture-small', display_name: 'Fixture Small', visibility: 'list' };
const prompt = { messages: [{ role: 'system', content: 'Choose only supplied IDs.' }, { role: 'user', content: '{"facts":["booking"]}' }], max_tokens: 70, temperature: 0.1, response_format: { type: 'json_object' } };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const event = (value, ending = '\n') => `event: ${value.type}${ending}data: ${JSON.stringify(value)}${ending}${ending}`;
const completed = (text = '{"ok":true}', overrides = {}) => ({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 41, output_tokens: 9, total_tokens: 50 }, ...overrides } });
function sse(value = event(completed()), { chunkBytes, headers = {}, onCancel, stayOpen = false } = {}) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + (chunkBytes || bytes.length));
        controller.enqueue(bytes.slice(offset, end)); offset = end;
      } else if (!stayOpen) controller.close();
    },
    cancel() { onCancel?.(); },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'req_fixture', ...headers } });
}
function fixture({ models = [small], response = () => sse(), credentials, fetcher, ...options } = {}) {
  const state = { status: connected(), token: 'fixture-access-token', tokenReads: 0, statusReads: 0, calls: [] };
  const adapter = credentials || {
    status() { state.statusReads++; return structuredClone(state.status); },
    getAccessToken({ signal }) { assert.equal(signal.aborted, false); state.tokenReads++; return state.token; },
  };
  const network = fetcher || (async (url, init) => {
    assert.ok(url === MODELS || url === RESPONSES, 'Only documented public routes are allowed');
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    state.calls.push({ url, init });
    return url === MODELS ? json({ models }) : response(init);
  });
  return { state, provider: createChatGPTProvider({ credentials: adapter, fetcher: network, now: () => NOW, ...options }) };
}
async function rejectsCode(promise, code) {
  let actual;
  await assert.rejects(promise, cause => { actual = cause; return cause?.code === code; });
  return actual;
}

test('account model catalog preserves canonical labels/order and selects a listed small non-Astra model', async () => {
  const models = [
    { slug: 'fixture-astra', display_name: 'Fixture Astra', visibility: 'list' },
    { slug: 'fixture-main', display_name: 'Fixture Main', visibility: 'list' },
    { slug: 'hidden-mini', display_name: 'Hidden Mini', visibility: 'hidden' },
    small,
    { slug: 'later-nano', display_name: 'Later Nano', visibility: 'list' },
  ];
  const { provider, state } = fixture({ models });
  const catalog = await provider.listModels();
  assert.equal(provider.type, 'chatgpt_plan');
  assert.deepEqual(catalog, { models: models.filter(model => model.visibility === 'list'), defaultModel: small.slug, checkedAt: new Date(NOW).toISOString() });
  assert.deepEqual(provider.models, catalog.models.map(model => model.slug));
  assert.equal(provider.defaultModel, small.slug);
  catalog.models[0].display_name = 'Mutated outside';
  assert.equal((await provider.listModels()).models[0].display_name, 'Fixture Astra');
  assert.equal(state.calls.length, 1);
  assert.equal(await provider.ready('fixture-main'), true);
  await rejectsCode(provider.ready('hidden-mini'), 'chatgpt_model_not_allowed');
  await rejectsCode(provider.complete('invented-model', prompt), 'chatgpt_model_not_allowed');
  assert.equal(state.calls.filter(call => call.url === RESPONSES).length, 0);
  await provider.listModels(undefined, { force: true });
  assert.equal(state.calls.length, 2);
});

test('Astra-only accounts require explicit selection and empty catalogs never invent a default', async () => {
  const { provider } = fixture({ models: [{ slug: 'only-astra', display_name: 'Only Astra', visibility: 'list' }] });
  assert.equal((await provider.listModels()).defaultModel, null);
  await rejectsCode(provider.ready('auto'), 'chatgpt_model_required');
  assert.equal(await provider.ready('only-astra'), true);
  const empty = fixture({ models: [] });
  assert.deepEqual((await empty.provider.listModels()).models, []);
  await rejectsCode(empty.provider.complete(null, prompt), 'chatgpt_model_required');
});

test('large account catalogs discard model metadata and retain only visible picker fields', async () => {
  const large = { ...small, instructions: 'fixture instructions '.repeat(40000), capabilities: { ignored: true } };
  const { provider, state } = fixture({ models: [large, { slug: 'hidden', visibility: 'hidden' }] });
  assert.ok(Buffer.byteLength(JSON.stringify({ models: [large] })) > 614466);
  const catalog = await provider.listModels();
  assert.deepEqual(catalog.models, [small]);
  assert.equal(catalog.defaultModel, small.slug);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog)) < 1024);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, MODELS);
});

test('catalog byte limit accepts the boundary and cancels larger advertised or streamed bodies', async () => {
  const limit = 2 * 1024 * 1024;
  const base = JSON.stringify({ models: [small], metadata: '' });
  const exact = JSON.stringify({ models: [small], metadata: 'x'.repeat(limit - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(exact), limit);
  const accepted = fixture({ fetcher: () => new Response(exact) });
  assert.deepEqual((await accepted.provider.listModels()).models, [small]);
  for (const advertised of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(exact + ' ')); },
      cancel() { cancelled = true; },
    });
    const oversized = fixture({ fetcher: () => new Response(body, { headers: advertised ? { 'content-length': String(limit + 1) } : {} }) });
    await rejectsCode(oversized.provider.listModels(), 'chatgpt_models_too_large');
    assert.equal(cancelled, true);
    assert.deepEqual(oversized.provider.models, []);
  }
});

test('connection, direct permission, and verified account are required before token retrieval or fetch', async () => {
  for (const [status, code] of [
    [{ connected: false }, 'chatgpt_not_connected'],
    [{ ...connected(), scopes: ['openid', 'chatgpt.tokens.use.indirect'] }, 'chatgpt_plan_permission_required'],
    [{ ...connected(), account: null }, 'chatgpt_account_unverified'],
  ]) {
    const { provider, state } = fixture(); state.status = status;
    await rejectsCode(provider.complete('auto', prompt), code);
    assert.equal(state.tokenReads, 0); assert.equal(state.calls.length, 0);
  }
});

test('account changes during refresh fail closed and unsafe credentials never enter request headers', async () => {
  let checks = 0, fetches = 0;
  const changing = fixture({ credentials: { status: () => connected(++checks === 1 ? 'a' : 'b'), getAccessToken: () => 'fixture-token' }, fetcher: () => { fetches++; throw Error('must not fetch'); } });
  await rejectsCode(changing.provider.ready(small.slug), 'chatgpt_account_changed');
  assert.equal(fetches, 0);
  const invalid = fixture(); invalid.state.token = 'fixture-token\r\nInjected: yes';
  await rejectsCode(invalid.provider.listModels(), 'chatgpt_credentials_invalid');
  assert.equal(invalid.state.calls.length, 0);
});

test('cached catalogs are bound to current token/account and permissions are rechecked', async () => {
  const { provider, state } = fixture();
  await provider.ready('auto'); await provider.complete('auto', prompt);
  assert.equal(state.calls.filter(call => call.url === MODELS).length, 1);
  assert.equal(state.calls[0].init.headers.Authorization, state.calls[1].init.headers.Authorization);
  state.token = 'rotated-fixture-token'; await provider.ready('auto');
  assert.equal(state.calls.filter(call => call.url === MODELS).length, 2);
  state.status = connected('other-account'); await provider.ready('auto');
  assert.equal(state.calls.filter(call => call.url === MODELS).length, 3);
  const count = state.calls.length;
  state.status.scopes = []; await rejectsCode(provider.complete('auto', prompt), 'chatgpt_plan_permission_required');
  assert.equal(state.calls.length, count);
});

test('Responses body is an explicit SIWC allowlist while exact grounding IDs survive the shared prompt', async () => {
  const evidence = { url: 'https://fixture.example/booking', quote: 'Бронирование столиков по телефону', checkedAt: new Date(NOW).toISOString(), confidence: 0.9 };
  const research = { signals: [{ id: 'booking', label: 'Бронирование', confidence: 0.9, evidence: [evidence] }], opportunities: [{ serviceId: 'booking', confidence: 0.6, evidence: [evidence] }] };
  const plan = { serviceId: 'booking', evidenceIds: ['booking'], approach: 'process', questionIds: ['current_process'], objectionIds: ['have_solution'] };
  const shared = makeAnalysisPrompt({ company: 'Тестовый ресторан' }, research, { maxInputTokens: 16000, maxOutputTokens: 700 });
  Object.assign(shared, { max_output_tokens: 500, tools: [{ type: 'web_search' }], previous_response_id: 'old', metadata: { private: true }, store: true, stream: false });
  const { provider, state } = fixture({ response: () => sse(event(completed(JSON.stringify(plan)))) });
  const result = await provider.complete('auto', shared);
  const request = JSON.parse(state.calls.find(call => call.url === RESPONSES).init.body);
  assert.deepEqual(Object.keys(request).sort(), ['input', 'instructions', 'model', 'store', 'stream']);
  assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.ok(Array.isArray(request.input)); assert.equal(request.input.length, 1); assert.equal(request.input[0].role, 'user');
  assert.equal(request.instructions, shared.messages[0].content);
  const user = JSON.parse(request.input[0].content);
  assert.deepEqual(user.services, ['booking']); assert.deepEqual(user.facts.map(fact => fact.id), ['booking']);
  assert.deepEqual(validateAnalysisPlan(JSON.parse(result.text), research), plan);
  assert.throws(() => validateAnalysisPlan({ ...plan, evidenceIds: ['invented'] }, research), { code: 'ai_output_ungrounded' });
  assert.throws(() => validateAnalysisPlan({ ...plan, claim: 'Invented revenue claim' }, research), { code: 'ai_output_invalid' });
  assert.deepEqual(result.usage, { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50, cost: null });
  assert.equal(result.billing, 'chatgpt_plan'); assert.equal(result.cost, null);
  assert.equal(result.model, small.slug); assert.equal(result.requestId, 'req_fixture'); assert.equal(result.responseId, 'resp_fixture');
});

test('SSE accepts UTF-8 split across bytes, CRLF boundaries and only canonical completed output', async () => {
  const text = '{"услуга":"бронирование"}';
  const stream = ': fixture heartbeat\r\n\r\n' + event({ type: 'response.created', response: { id: 'resp_fixture' } }, '\r\n') + event({ type: 'response.output_text.delta', delta: 'partial does not become output' }, '\r\n') + event(completed(text), '\r\n') + 'data: [DONE]\r\n\r\n';
  let cancelled = false;
  const { provider } = fixture({ response: () => sse(stream, { chunkBytes: 1, stayOpen: true, onCancel: () => { cancelled = true; } }) });
  const result = await provider.complete('auto', prompt);
  assert.equal(result.text, text); assert.equal(cancelled, true);
});

test('partial, incomplete, refused and failed responses never produce generated text', async () => {
  const delta = event({ type: 'response.output_text.delta', delta: 'private partial material' });
  const cases = [
    [delta, 'chatgpt_stream_interrupted'],
    [delta + 'data: [DONE]\n\n', 'chatgpt_stream_interrupted'],
    [delta + event(completed()).trimEnd(), 'chatgpt_stream_interrupted'],
    [delta + event({ type: 'response.incomplete', response: { id: 'resp_fixture', incomplete_details: { reason: 'max_output_tokens' } } }), 'chatgpt_response_incomplete'],
    [delta + event({ type: 'response.failed', response: { id: 'resp_fixture', error: { code: 'subscription_sharing_usage_unavailable', message: 'private diagnostic' } } }), 'subscription_sharing_usage_unavailable'],
    [event({ type: 'error', code: 'subscription_sharing_unsupported_capability', param: 'temperature', message: 'private diagnostic' }), 'subscription_sharing_unsupported_capability'],
    [event({ type: 'response.refusal.delta', delta: 'refused' }), 'chatgpt_response_refused'],
    [event(completed('', { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'refused' }] }] })), 'chatgpt_response_refused'],
    [event(completed('', { status: 'in_progress' })), 'chatgpt_invalid_stream'],
    ['event: response.completed\ndata: {invalid}\n\n', 'chatgpt_invalid_stream'],
    ['event: response.failed\ndata: ' + JSON.stringify(completed()) + '\n\n', 'chatgpt_invalid_stream'],
  ];
  for (const [body, code] of cases) {
    const { provider } = fixture({ response: () => sse(body) });
    const cause = await rejectsCode(provider.complete('auto', prompt), code);
    assert.equal(cause.text, undefined); assert.ok(!JSON.stringify(cause).includes('private'));
  }
});

test('completed responses require actual consistent token usage and plain assistant output', async () => {
  for (const [override, code] of [
    [{ usage: null }, 'chatgpt_usage_unverified'],
    [{ usage: { input_tokens: 20, output_tokens: 2, total_tokens: 99 } }, 'chatgpt_usage_unverified'],
    [{ usage: { input_tokens: -1, output_tokens: 2, total_tokens: 1 } }, 'chatgpt_usage_unverified'],
    [{ output: [{ type: 'function_call', name: 'execute' }] }, 'chatgpt_output_invalid'],
    [{ output: [{ type: 'message', role: 'user', content: [] }] }, 'chatgpt_output_invalid'],
    [{ output: [] }, 'chatgpt_output_invalid'],
  ]) {
    const { provider } = fixture({ response: () => sse(event(completed('{"ok":true}', override))) });
    await rejectsCode(provider.complete('auto', prompt), code);
  }
});

test('HTTP errors retain safe code, param, status, request ID and shape without diagnostic content', async () => {
  const { provider } = fixture({ response: () => json({ error: { code: 'subscription_sharing_unsupported_capability', param: 'max_output_tokens', message: 'fixture-access-token private diagnostic' } }, 400, { 'x-request-id': 'req_safe_error' }) });
  const cause = await rejectsCode(provider.complete('auto', prompt), 'subscription_sharing_unsupported_capability');
  assert.equal(cause.status, 400); assert.equal(cause.httpStatus, 400); assert.equal(cause.requestId, 'req_safe_error');
  assert.equal(cause.param, 'max_output_tokens'); assert.equal(cause.bodyShape, 'error_object'); assert.equal(cause.recovery, 'fix_request');
  assert.ok(!JSON.stringify(cause).includes('fixture-access-token')); assert.ok(!JSON.stringify(cause).includes('private diagnostic'));
  for (const [status, code] of [[401, 'chatgpt_admission_unauthorized'], [403, 'chatgpt_admission_forbidden'], [503, 'chatgpt_route_unavailable']]) {
    const admission = fixture({ response: () => json({ detail: 'private upstream route diagnostic' }, status) });
    const failure = await rejectsCode(admission.provider.complete('auto', prompt), code);
    assert.equal(failure.bodyShape, 'detail_text'); assert.equal(failure.httpStatus, status);
    assert.ok(!JSON.stringify(failure).includes('private'));
  }
});

test('plan usage limit after streaming pauses this account with no automatic retry or API fallback', async () => {
  let denied = true;
  const { provider, state } = fixture({ response: () => denied ? sse(event({ type: 'response.output_text.delta', delta: 'partial' }) + event({ type: 'response.failed', response: { id: 'resp_denied', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private plan condition' } } })) : sse() });
  const cause = await rejectsCode(provider.complete('auto', prompt), 'subscription_sharing_usage_limit_exceeded');
  assert.equal(cause.status, 429); assert.equal(cause.httpStatus, 200); assert.equal(cause.pause, true); assert.equal(cause.retryable, false);
  assert.equal(cause.usageUrl, 'https://chatgpt.com/settings/usage'); assert.equal(cause.retryAt, undefined);
  const calls = state.calls.length;
  await rejectsCode(provider.ready('auto'), cause.code); await rejectsCode(provider.complete('auto', prompt), cause.code);
  assert.equal(state.calls.length, calls);
  assert.equal((await provider.listModels()).defaultModel, small.slug);
  denied = false; assert.equal(await provider.clearUsageBlock(), true);
  assert.equal((await provider.complete('auto', prompt)).billing, 'chatgpt_plan');
  assert.equal(state.calls.filter(call => call.url === RESPONSES).length, 2);
  assert.ok(state.calls.every(call => call.url.startsWith('https://api.openai.com/v1/')));
});

test('usage pause is account-specific and Retry-After never invents an account reset', async () => {
  let blocked = true;
  const { provider, state } = fixture({ response: () => blocked ? json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429, { 'retry-after': '60' }) : sse() });
  const cause = await rejectsCode(provider.complete('auto', prompt), 'subscription_sharing_usage_limit_exceeded');
  assert.equal(cause.retryAt, new Date(NOW + 60000).toISOString());
  state.status = connected('other-account'); blocked = false;
  assert.equal((await provider.complete('auto', prompt)).text, '{"ok":true}');
  state.status = connected(); await rejectsCode(provider.complete('auto', prompt), cause.code);
});

test('transient plan outages preserve credentials and permit a later explicit request', async () => {
  let outage = true;
  const { provider, state } = fixture({ response: () => outage ? json({ error: { code: 'subscription_sharing_user_unavailable' } }, 503) : sse() });
  const cause = await rejectsCode(provider.complete('auto', prompt), 'subscription_sharing_user_unavailable');
  assert.equal(cause.retryable, true); assert.equal(cause.pause, undefined);
  assert.equal(state.calls.filter(call => call.url === RESPONSES).length, 1);
  outage = false; assert.equal((await provider.complete('auto', prompt)).billing, 'chatgpt_plan');
  assert.equal(state.status.connected, true);
});

test('deadlines cover credentials, initial fetch and a stalled SSE body', async () => {
  const never = () => new Promise(() => {});
  const waitingCredentials = fixture({ timeoutMs: 15, credentials: { status: never, getAccessToken: never } });
  await rejectsCode(waitingCredentials.provider.listModels(), 'chatgpt_request_timeout');
  const waitingHeaders = fixture({ timeoutMs: 15, fetcher: never });
  await rejectsCode(waitingHeaders.provider.complete('auto', prompt), 'chatgpt_request_timeout');
  let cancelled = false;
  const waitingBody = fixture({ timeoutMs: 15, response: () => sse(event({ type: 'response.created' }), { stayOpen: true, onCancel: () => { cancelled = true; } }) });
  await rejectsCode(waitingBody.provider.complete('auto', prompt), 'chatgpt_request_timeout');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test('caller cancellation aborts in-flight fetch and cannot result in generated material', async () => {
  const controller = new AbortController(); let requestSignal;
  const { provider } = fixture({ fetcher: (_url, init) => { requestSignal = init.signal; queueMicrotask(() => controller.abort()); return new Promise(() => {}); } });
  await rejectsCode(provider.complete('auto', prompt, controller.signal), 'chatgpt_request_aborted');
  assert.equal(requestSignal.aborted, true);
});

test('header, model body, stream bytes, output and prompt bounds stop oversized input', async () => {
  const header = fixture({ response: () => sse(event(completed()), { headers: { 'x-large': 'x'.repeat(33000) } }) });
  await rejectsCode(header.provider.complete('auto', prompt), 'chatgpt_response_too_large');
  const catalog = fixture({ fetcher: () => json({ models: [], padding: 'x'.repeat(2 * 1024 * 1024) }) });
  await rejectsCode(catalog.provider.listModels(), 'chatgpt_models_too_large');
  const stream = fixture({ maxResponseBytes: 1024, response: () => sse(':' + 'x'.repeat(2000) + '\n\n') });
  await rejectsCode(stream.provider.complete('auto', prompt), 'chatgpt_response_too_large');
  const delta = fixture({ maxOutputChars: 64, response: () => sse(event({ type: 'response.output_text.delta', delta: 'x'.repeat(65) })) });
  await rejectsCode(delta.provider.complete('auto', prompt), 'chatgpt_output_too_large');
  const output = fixture({ maxOutputChars: 64, response: () => sse(event(completed('x'.repeat(65)))) });
  await rejectsCode(output.provider.complete('auto', prompt), 'chatgpt_output_too_large');
  const input = fixture();
  await rejectsCode(input.provider.complete('auto', { messages: [{ role: 'user', content: 'x'.repeat(128000) }] }), 'chatgpt_prompt_too_large');
  assert.equal(input.state.calls.filter(call => call.url === RESPONSES).length, 0);
});

test('invalid model catalogs, prompts, stream media and malformed UTF-8 fail closed', async () => {
  for (const models of [[small, small], [{ ...small, slug: 'bad\nslug' }], [{ ...small, display_name: '<script>' }]]) {
    const { provider } = fixture({ models }); await rejectsCode(provider.listModels(), 'chatgpt_models_invalid');
  }
  const badPrompt = fixture();
  await rejectsCode(badPrompt.provider.complete('auto', { messages: [{ role: 'tool', content: 'unsafe' }] }), 'chatgpt_prompt_invalid');
  await rejectsCode(badPrompt.provider.complete('auto', { messages: [{ role: 'system', content: 'No user' }] }), 'chatgpt_prompt_invalid');
  assert.equal(badPrompt.state.calls.filter(call => call.url === RESPONSES).length, 0);
  const media = fixture({ response: () => json(completed()) });
  await rejectsCode(media.provider.complete('auto', prompt), 'chatgpt_stream_required');
  const utf = fixture({ response: () => sse(new Uint8Array([255, 255])) });
  await rejectsCode(utf.provider.complete('auto', prompt), 'chatgpt_stream_interrupted');
});
