export class LeadError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function fail(code, status = 400) { throw new LeadError(code, status); }
// Only machine codes cross HTTP/log boundaries. Never propagate upstream bodies.
export function publicCode(error, fallback = 'lead_service_unavailable') {
  return typeof error?.code === 'string' && /^[a-z][a-z0-9_]{2,80}$/.test(error.code) ? error.code : fallback;
}
