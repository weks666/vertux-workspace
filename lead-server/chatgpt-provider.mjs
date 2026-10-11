import { createHash } from 'node:crypto';
import { LeadError } from './errors.mjs';

// Official SIWC direct-plan route. No API-key route, backend-api endpoint,
// credential-file lookup, SDK fallback, or automatic inference retry exists here.
// https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
// https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
const MODELS_URL = 'https://api.openai.com/v1/models';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const machineCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{2,80}$/.test(value) ? value : null;
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : null;
const safeParam = value => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.\[\]-]{0,100}$/.test(value) ? value : null;
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const error = (code, status = 502, details = {}) => Object.assign(new LeadError(code, status), details);
const recovery = {
  subscription_sharing_user_not_eligible: { status: 403, recovery: 'account_or_policy', retryable: false },
  subscription_sharing_usage_limit_exceeded: { status: 429, recovery: 'usage_limit', retryable: false, pause: true, usageUrl: USAGE_URL },
  subscription_sharing_usage_unavailable: { status: 503, recovery: 'retry_later', retryable: true },
  subscription_sharing_unsupported_capability: { status: 400, recovery: 'fix_request', retryable: false },
  subscription_sharing_route_not_supported: { status: 403, recovery: 'fix_integration', retryable: false },
  subscription_sharing_invalid_user: { status: 401, recovery: 'check_credentials', retryable: false },
  chatpass_v2_scope_not_authorized: { status: 403, recovery: 'check_permission', retryable: false },
  chatpass_v2_invalid_authorization_context: { status: 403, recovery: 'check_permission', retryable: false },
  subscription_sharing_user_unavailable: { status: 503, recovery: 'retry_later', retryable: true },
};

function raceSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function withDeadline(parentSignal, timeoutMs, operation) {
  const controller = new AbortController();
  const abort = () => controller.abort(error('chatgpt_request_aborted', 499, { retryable: false, recovery: 'request_interrupted' }));
  if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(error('chatgpt_request_timeout', 504, { retryable: false, recovery: 'request_interrupted' })), timeoutMs);
  try { return await raceSignal(operation(controller.signal), controller.signal); }
  catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (cause instanceof LeadError) throw cause;
    throw error('chatgpt_provider_unavailable', 503, { retryable: true, recovery: 'retry_later' });
  } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); }
}

function cancelBody(reader) { try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} }

async function readBoundedBody(response, { signal, maxBytes }) {
  const length = response.headers?.get?.('content-length');
  if (length && Number(length) > maxBytes) { cancelBody(response.body); throw error('chatgpt_response_too_large'); }
  const reader = response.body?.getReader();
  if (!reader) throw error('chatgpt_invalid_response');
  let bytes = 0; const chunks = [];
  try {
    for (;;) {
      const part = await raceSignal(reader.read(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw error('chatgpt_invalid_response');
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw error('chatgpt_response_too_large');
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (cause) { cancelBody(reader); throw cause; }
  finally { try { reader.releaseLock(); } catch {} }
}

function requestDetails(response) {
  return { httpStatus: response.status, requestId: safeId(response.headers?.get?.('x-request-id')) };
}

function classifyShape(value, text) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.error && typeof value.error === 'object') return 'error_object';
    if (typeof value.detail === 'string') return 'detail_text';
    return 'json_object';
  }
  if (Array.isArray(value)) return 'json_array';
  return text ? 'text' : 'empty';
}

function failureFromBody(value, { httpStatus, requestId, bodyShape, responseId, now, retryAfter } = {}) {
  const returned = value?.error && typeof value.error === 'object' ? value.error : value;
  const code = machineCode(returned?.code);
  const fallback = httpStatus === 401 ? 'chatgpt_admission_unauthorized' : httpStatus === 403 ? 'chatgpt_admission_forbidden' : httpStatus === 429 ? 'chatgpt_rate_limited' : httpStatus === 503 ? 'chatgpt_route_unavailable' : 'chatgpt_request_failed';
  const rule = code && recovery[code];
  const fallbackRule = { recovery: httpStatus === 401 ? 'check_credentials' : httpStatus === 403 ? 'check_permission' : httpStatus === 429 ? 'retry_later' : 'retry_later', retryable: httpStatus === 429 || httpStatus >= 500 };
  const result = error(code || fallback, rule?.status || (httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 502), {
    ...fallbackRule, ...(rule || {}), httpStatus, requestId: requestId || null,
    bodyShape: bodyShape || 'error_object', param: safeParam(returned?.param), responseId: safeId(responseId),
  });
  // A usage-limit code is not a reset time. Only an explicit Retry-After header
  // can supply retry timing; there is no assumed weekly or account-wide reset.
  if (retryAfter) {
    const seconds = /^\d{1,9}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
    const absolute = seconds === null ? Date.parse(retryAfter) : Number(now) + seconds * 1000;
    if (Number.isFinite(absolute) && absolute > Number(now)) result.retryAt = new Date(absolute).toISOString();
  }
  return result;
}

async function fetchResponse(fetcher, url, options, signal) {
  signal.throwIfAborted();
  let response;
  try { response = await raceSignal(fetcher(url, { ...options, cache: 'no-store', redirect: 'error', signal }), signal); }
  catch (cause) { if (signal.aborted) throw signal.reason; throw error('chatgpt_provider_unavailable', 503, { retryable: true, recovery: 'retry_later' }); }
  if (!response || !Number.isInteger(response.status) || !response.headers?.get || !response.body || response.redirected) { cancelBody(response?.body); throw error('chatgpt_invalid_response'); }
  let headerBytes = 0;
  for (const [name, value] of response.headers) headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  if (headerBytes > 32768) { cancelBody(response.body); throw error('chatgpt_response_too_large'); }
  return response;
}

async function requireOK(response, signal, now) {
  if (response.status >= 200 && response.status < 300) return;
  const text = await readBoundedBody(response, { signal, maxBytes: 32768 });
  let value; try { value = JSON.parse(text); } catch {}
  throw failureFromBody(value, { ...requestDetails(response), bodyShape: classifyShape(value, text), now, retryAfter: response.headers.get('retry-after') });
}

function permission(status) {
  if (status?.connected !== true) throw error('chatgpt_not_connected', 401, { recovery: 'sign_in', retryable: false });
  const scopes = Array.isArray(status.scopes) ? status.scopes : typeof status.scope === 'string' ? status.scope.split(/\s+/) : [];
  if (!scopes.includes(REQUIRED_SCOPE)) throw error('chatgpt_plan_permission_required', 403, { recovery: 'enable_plan_usage', retryable: false });
  const accountId = status.account?.id;
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256 || /[\u0000-\u001f\u007f]/.test(accountId)) throw error('chatgpt_account_unverified', 403, { recovery: 'check_credentials', retryable: false });
  return accountId;
}

function selectDefault(models) {
  const nonAstra = models.filter(model => !/astra/i.test(`${model.slug} ${model.display_name}`));
  return (nonAstra.find(model => /(?:^|[-_. /])(?:mini|nano|small|luna)(?:$|[-_. /])/i.test(`${model.slug} ${model.display_name}`)) || nonAstra[0])?.slug || null;
}

function modelSlug(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value); }

function createRequestBody(model, prompt) {
  if (!Array.isArray(prompt?.messages) || !prompt.messages.length || prompt.messages.length > 32) throw error('chatgpt_prompt_invalid', 400);
  const instructions = [], input = [];
  for (const message of prompt.messages) {
    if (!message || typeof message.content !== 'string' || !['system', 'developer', 'user'].includes(message.role)) throw error('chatgpt_prompt_invalid', 400);
    if (message.role === 'system') instructions.push(message.content);
    else input.push({ role: message.role, content: message.content });
  }
  if (!input.some(message => message.role === 'user')) throw error('chatgpt_prompt_invalid', 400);
  // Explicit allowlist: unsupported SIWC fields from the existing paid-provider
  // prompt (temperature, max_tokens, response_format) are never copied across.
  const body = { model, input, store: false, stream: true };
  if (instructions.length) body.instructions = instructions.join('\n\n');
  if (Buffer.byteLength(JSON.stringify(body)) > 128000) throw error('chatgpt_prompt_too_large', 413);
  return body;
}

function usageFromResponse(response, required = true) {
  const usage = response?.usage;
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 || !Number.isSafeInteger(usage.total_tokens) || usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    if (required) throw error('chatgpt_usage_unverified');
    return undefined;
  }
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens, cost: null };
}

function completedOutput(response, maxOutputChars) {
  if (!Array.isArray(response.output) || response.output.length > 64) throw error('chatgpt_output_invalid');
  const texts = [];
  for (const item of response.output) {
    if (item?.type === 'reasoning') continue;
    if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length > 32) throw error('chatgpt_output_invalid');
    for (const content of item.content) {
      if (content?.type === 'refusal') throw error('chatgpt_response_refused', 422);
      if (content?.type !== 'output_text' || typeof content.text !== 'string') throw error('chatgpt_output_invalid');
      texts.push(content.text);
    }
  }
  const text = texts.join('');
  if (!text.trim() || text.length > maxOutputChars) throw error(text.length > maxOutputChars ? 'chatgpt_output_too_large' : 'chatgpt_output_invalid');
  return text;
}

async function consumeSSE(response, { signal, maxResponseBytes, maxOutputChars, now }) {
  if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) { cancelBody(response.body); throw error('chatgpt_stream_required'); }
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  const details = requestDetails(response);
  let bytes = 0, line = '', eventName = '', data = [], dataChars = 0, afterCR = false, events = 0, deltaChars = 0, terminal = null;
  const dispatch = () => {
    if (!data.length) { eventName = ''; return; }
    const value = data.join('\n'), named = eventName;
    data = []; eventName = ''; dataChars = 0;
    if (value === '[DONE]') { if (!terminal) throw error('chatgpt_stream_interrupted', 502, { ...details, recovery: 'request_interrupted', retryable: false }); return; }
    if (++events > 4096 || terminal) throw error('chatgpt_invalid_stream');
    let event; try { event = JSON.parse(value); } catch { throw error('chatgpt_invalid_stream'); }
    if (!event || typeof event.type !== 'string' || event.type.length > 120 || (named && named !== 'message' && named !== event.type)) throw error('chatgpt_invalid_stream');
    if (event.type === 'response.failed' || event.type === 'error') {
      const source = event.type === 'response.failed' ? event.response : event;
      const failure = failureFromBody(source, { ...details, bodyShape: `sse:${event.type}`, responseId: event.response?.id, now });
      failure.usage = usageFromResponse(event.response, false);
      throw failure;
    }
    if (event.type === 'response.incomplete') throw error('chatgpt_response_incomplete', 502, { ...details, responseId: safeId(event.response?.id), incompleteReason: machineCode(event.response?.incomplete_details?.reason), usage: usageFromResponse(event.response, false), recovery: 'request_incomplete', retryable: false });
    if (event.type.startsWith('response.refusal.')) throw error('chatgpt_response_refused', 422, { ...details, retryable: false });
    if (event.type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') throw error('chatgpt_invalid_stream');
      deltaChars += event.delta.length;
      if (deltaChars > maxOutputChars) throw error('chatgpt_output_too_large');
    }
    if (event.type === 'response.completed') {
      if (event.response?.status !== 'completed' || event.response.error) throw error('chatgpt_invalid_stream');
      terminal = { text: completedOutput(event.response, maxOutputChars), usage: usageFromResponse(event.response), billing: 'chatgpt_plan', cost: null,
        requestId: details.requestId, responseId: safeId(event.response.id) };
    }
  };
  const acceptLine = () => {
    const current = line; line = '';
    if (!current) { dispatch(); return; }
    if (current[0] === ':') return;
    const index = current.indexOf(':'); const field = index < 0 ? current : current.slice(0, index);
    let value = index < 0 ? '' : current.slice(index + 1); if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') { if (value.length > 120) throw error('chatgpt_invalid_stream'); eventName = value; }
    if (field === 'data') { dataChars += value.length; if (dataChars > 256000) throw error('chatgpt_response_too_large'); data.push(value); }
  };
  const acceptText = text => {
    // A single pass handles CR, LF, CRLF and UTF-8 split across arbitrary chunks.
    // No repeated scan of an ever-growing unterminated line is performed.
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (afterCR) { afterCR = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') { acceptLine(); afterCR = char === '\r'; }
      else { line += char; if (line.length > 256000) throw error('chatgpt_response_too_large'); }
    }
  };
  try {
    while (!terminal) {
      const part = await raceSignal(reader.read(), signal);
      if (part.done) { acceptText(decoder.decode()); break; }
      if (!(part.value instanceof Uint8Array)) throw error('chatgpt_invalid_stream');
      bytes += part.value.byteLength; if (bytes > maxResponseBytes) throw error('chatgpt_response_too_large');
      acceptText(decoder.decode(part.value, { stream: true }));
    }
    // A half-written terminal event at EOF is an interrupted stream, not success.
    if (!terminal) throw error('chatgpt_stream_interrupted', 502, { ...details, retryable: false, recovery: 'request_interrupted' });
    return terminal;
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    if (cause instanceof LeadError) throw cause;
    throw error('chatgpt_stream_interrupted', 502, { ...details, retryable: false, recovery: 'request_interrupted' });
  } finally { cancelBody(reader); try { reader.releaseLock(); } catch {} }
}

export function createChatGPTProvider({ credentials, fetcher = fetch, now = Date.now, timeoutMs = 120000, catalogTtlMs = 30000, maxResponseBytes = 1024 * 1024, maxOutputChars = 16000 } = {}) {
  if (typeof credentials?.getAccessToken !== 'function' || typeof credentials?.status !== 'function' || typeof fetcher !== 'function') throw error('chatgpt_provider_configuration_invalid', 503);
  const timeout = bounded(timeoutMs, 120000, 10, 120000), ttl = bounded(catalogTtlMs, 30000, 0, 30000);
  const responseLimit = bounded(maxResponseBytes, 1024 * 1024, 1024, 2 * 1024 * 1024), outputLimit = bounded(maxOutputChars, 16000, 64, 16000);
  let catalog = null; const usageBlocks = new Map();
  async function session(signal) {
    let before, token, after;
    try {
      before = permission(await raceSignal(credentials.status(), signal));
      token = await raceSignal(credentials.getAccessToken({ signal }), signal);
      after = permission(await raceSignal(credentials.status(), signal));
    } catch (cause) {
      if (cause instanceof LeadError || signal.aborted) throw cause;
      throw error(machineCode(cause?.code) || 'chatgpt_credentials_unavailable', 503, { recovery: 'check_credentials', retryable: false });
    }
    if (before !== after) throw error('chatgpt_account_changed', 409, { recovery: 'refresh_models', retryable: false });
    if (typeof token !== 'string' || token.length < 8 || token.length > 16384 || !/^[a-zA-Z0-9._~+/-]+=*$/.test(token)) throw error('chatgpt_credentials_invalid', 401, { recovery: 'check_credentials', retryable: false });
    return { token, accountId: after, fingerprint: createHash('sha256').update(after).update('\0').update(token).digest('hex') };
  }
  async function loadCatalog(auth, signal, force = false) {
    if (!force && catalog?.fingerprint === auth.fingerprint && now() - catalog.at < ttl) return catalog;
    const response = await fetchResponse(fetcher, MODELS_URL, { method: 'GET', headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' } }, signal);
    await requireOK(response, signal, now());
    let value; try { value = JSON.parse(await readBoundedBody(response, { signal, maxBytes: 256000 })); } catch (cause) { if (cause instanceof LeadError || signal.aborted) throw cause; throw error('chatgpt_models_invalid'); }
    if (!Array.isArray(value?.models) || value.models.length > 500) throw error('chatgpt_models_invalid');
    const models = [], seen = new Set();
    for (const model of value.models) {
      if (model?.visibility !== 'list') continue;
      if (!modelSlug(model.slug) || typeof model.display_name !== 'string' || !model.display_name.trim() || model.display_name.length > 160 || /[<>\u0000-\u001f\u007f]/.test(model.display_name) || seen.has(model.slug)) throw error('chatgpt_models_invalid');
      seen.add(model.slug); models.push({ slug: model.slug, display_name: model.display_name, visibility: 'list' });
    }
    catalog = { models, defaultModel: selectDefault(models), checkedAt: new Date(now()).toISOString(), at: now(), fingerprint: auth.fingerprint };
    return catalog;
  }
  function choose(model, list) {
    const selected = model == null || model === '' || model === 'auto' ? list.defaultModel : model;
    if (!selected) throw error('chatgpt_model_required', 422, { recovery: 'select_model', retryable: false });
    if (!modelSlug(selected) || !list.models.some(item => item.slug === selected)) throw error('chatgpt_model_not_allowed', 403, { recovery: 'refresh_models', retryable: false });
    return selected;
  }
  const block = (accountId, cause) => {
    if (cause?.code === 'subscription_sharing_usage_limit_exceeded') usageBlocks.set(accountId, {
      code: cause.code, status: cause.status, httpStatus: cause.httpStatus, requestId: cause.requestId, bodyShape: cause.bodyShape,
      recovery: cause.recovery, retryable: false, pause: true, usageUrl: USAGE_URL, ...(cause.retryAt ? { retryAt: cause.retryAt } : {}),
    });
  };
  const checkBlock = accountId => { const paused = usageBlocks.get(accountId); if (paused) throw error(paused.code, paused.status, paused); };
  return {
    type: 'chatgpt_plan',
    get models() { return catalog?.models.map(model => model.slug) || []; },
    get defaultModel() { return catalog?.defaultModel || null; },
    async listModels(signal, { force = false } = {}) {
      return withDeadline(signal, Math.min(timeout, 30000), async active => {
        const auth = await session(active), list = await loadCatalog(auth, active, force);
        return { models: structuredClone(list.models), defaultModel: list.defaultModel, checkedAt: list.checkedAt };
      });
    },
    async ready(model, signal) {
      return withDeadline(signal, Math.min(timeout, 30000), async active => {
        const auth = await session(active); checkBlock(auth.accountId);
        try { choose(model, await loadCatalog(auth, active)); return true; }
        catch (cause) { block(auth.accountId, cause); throw cause; }
      });
    },
    async complete(model, prompt, signal) {
      return withDeadline(signal, timeout, async active => {
        const auth = await session(active); checkBlock(auth.accountId);
        try {
          const selected = choose(model, await loadCatalog(auth, active)), body = createRequestBody(selected, prompt);
          const response = await fetchResponse(fetcher, RESPONSES_URL, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) }, active);
          await requireOK(response, active, now());
          const completed = await consumeSSE(response, { signal: active, maxResponseBytes: responseLimit, maxOutputChars: outputLimit, now: now() });
          return { ...completed, model: selected };
        } catch (cause) { block(auth.accountId, cause); throw cause; }
      });
    },
    // Call only from an explicit owner retry/resume action; never on a timer.
    async clearUsageBlock() { const accountId = permission(await credentials.status()); return usageBlocks.delete(accountId); },
  };
}
