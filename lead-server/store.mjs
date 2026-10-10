// Supabase credentials are server-only. All database mutations run in one scoped
// PostgreSQL transaction; a network error never causes an automatic RPC retry.
export class LeadStoreError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

const knownErrors = new Set(['scope_mismatch', 'not_found', 'invalid_settings', 'invalid_action', 'invalid_kind', 'invalid_payload', 'excluded', 'opted_out', 'stale_lease', 'revision_conflict', 'job_conflict', 'budget_exceeded', 'plan_quota_exceeded', 'ai_provider_mismatch', 'ai_disabled', 'idempotency_conflict', 'invalid_transition', 'invalid_usage']);
const clientErrors = new Set(['invalid_settings', 'invalid_action', 'invalid_kind', 'invalid_payload', 'invalid_usage']);

export function createLeadStore({supabaseUrl, serviceKey, organizationId, productId, fetcher = fetch, actorId = null}) {
  const base = new URL(supabaseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new LeadStoreError('invalid_store_configuration', 500);
  if (base.username || base.password || base.search || base.hash || !serviceKey || !organizationId || !productId) throw new LeadStoreError('invalid_store_configuration', 500);
  const endpoint = new URL('rest/v1/rpc/workspace_lead_rpc', base.href.replace(/\/?$/, '/')).href;

  async function rpc(action, payload = {}) {
    let response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
        headers: {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({p_organization_id: organizationId, p_product_id: productId, p_action: action, p_payload: {...payload, actorId}})
      });
    } catch { throw new LeadStoreError('store_unavailable'); }
    let result;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks = []; let bytes = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 24 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
        chunks.push(Buffer.from(value));
      }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new LeadStoreError('invalid_store_response'); }
    if (!response.ok) {
      const code = knownErrors.has(result?.message) ? result.message : 'store_unavailable';
      throw new LeadStoreError(code, code === 'not_found' ? 404 : clientErrors.has(code) ? 400 : code === 'scope_mismatch' ? 403 : knownErrors.has(code) ? 409 : 503);
    }
    return result;
  }

  return Object.freeze({
    withActor: id => createLeadStore({supabaseUrl, serviceKey, organizationId, productId, fetcher, actorId: id}),
    getSettings: () => rpc('get_settings'),
    saveSettings: patch => rpc('save_settings', {settings: patch}),
    suspendAI: (code = 'usage_limit_exceeded') => rpc('suspend_ai', {code}),
    overview: ({cursor = null, limit = 500, since = null} = {}) => rpc('overview', {cursor, limit, since}),
    detail: projectId => rpc('detail', {projectId}),
    getProject: projectId => rpc('get_project', {projectId}),
    enqueue: (projectId, kind, {force = false, priority = 0, manual = true} = {}) => rpc('enqueue', {projectId, kind, force, priority, manual}),
    controlJob: (jobId, operation) => rpc('control_job', {jobId, operation}),
    claim: workerId => rpc('claim', {workerId}),
    heartbeat: (jobId, workerId, progress = {}) => rpc('heartbeat', {jobId, workerId, progress}),
    complete: (jobId, workerId, result) => rpc('complete', {jobId, workerId, result}),
    fail: (jobId, workerId, code) => rpc('fail', {jobId, workerId, code}),
    saveMaterials: (projectId, revision, materials) => rpc('save_materials', {projectId, revision, materials}),
    savePolicy: (projectId, patch) => rpc('save_policy', {projectId, ...patch, ...(patch.opted_out === undefined ? {} : {optedOut: patch.opted_out}), ...(patch.contact_permission === undefined ? {} : {contactPermission: patch.contact_permission})}),
    addReply: (projectId, reply) => rpc('add_reply', {projectId, reply}),
    purge: projectId => rpc('purge', {projectId}),
    schedule: () => rpc('schedule'),
    reserveUsage: data => rpc('reserve_usage', data),
    settleUsage: (requestId, data) => rpc('settle_usage', {requestId, ...data})
  });
}
