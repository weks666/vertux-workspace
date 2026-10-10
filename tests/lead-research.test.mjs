import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearcher, extractPage, officialCandidates, plainText } from '../lead-server/research.mjs';
import { createSafeFetcher, ResearchFetchError } from '../lead-server/safe-fetch.mjs';
import { scoreResearch } from '../lead-server/scoring.mjs';

const STAMP = Date.parse('2026-10-10T08:00:00Z');
const settings = { requestsPerHostDelayMs: 0, requestTimeoutMs: 500, maxPagesQuick: 2, maxPagesDeep: 6, maxInputTokens: 12000, staleDays: 30 };
const project = { id: 'fixture-company', company: 'Северная звезда', city: 'Казань', site: 'https://hotel.example/', phone: '+7 (843) 555-12-34' };
const hotel = `<html><head><title>Северная звезда — отель в Казани</title><meta name="description" content="Отель Северная звезда: Казань, проживание, конференции и завтрак."></head><body><h1>Северная звезда</h1><p>Казань. Комфортное проживание для семей с детьми и корпоративных клиентов. Завтрак и конференции. Уточните актуальные условия проживания у менеджера гостиницы. Забронировать номер можно на официальном сайте.</p><a href="tel:+78435551234">+7 (843) 555-12-34</a><a href="mailto:hello@hotel.example">Связаться по email</a><a href="/contacts">Контакты</a><a href="/rooms">Номера</a><a href="/faq">Частые вопросы</a><a href="/checkout">Оплатить</a><script>window.secret='MUST_NOT_APPEAR'</script></body></html>`;
const contacts = '<html><title>Контакты Северная звезда</title><h1>Казань, улица Мира, 12</h1><p>Телефон +7 (843) 555-12-34. Email hello@hotel.example. Режим работы: ежедневно.</p></html>';
const rooms = '<html><title>Номера Северная звезда</title><h1>Гостиница: номера и проживание</h1><p>Северная звезда, Казань. Забронировать номер. Завтрак, конференции и проживание для корпоративных клиентов.</p></html>';
function fixture(routes = {}, { renderer = null, env = {} } = {}) {
  const requests = []; let simulated = STAMP;
  const fetcher = createSafeFetcher({ resolver: async () => [{ address: '93.184.215.14', family: 4 }], schedule: new Map(), now: () => simulated, sleep: async delay => { simulated += delay; }, transport: async (url, target, options) => {
    requests.push({ url: url.href, target, headers: options.headers });
    let value = routes[url.href];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') value = await value(url, options);
    if (value === undefined) value = url.pathname === '/robots.txt' ? { status: 404, text: '' } : { status: 404, text: '' };
    if (typeof value === 'string') value = { status: 200, text: value };
    const text = value.text || '';
    return { headers: { 'content-type': url.pathname === '/robots.txt' ? 'text/plain' : 'text/html', ...(value.headers || {}) }, status: value.status ?? 200, text, body: Buffer.from(text), bytes: Buffer.byteLength(text), durationMs: 10 };
  } });
  const research = createResearcher({ fetcher, renderer, now: () => STAMP, env });
  return { research, requests };
}
const hotelRoutes = { 'https://hotel.example/': hotel, 'https://hotel.example/contacts': contacts, 'https://hotel.example/rooms': rooms, 'https://hotel.example/faq': '<h1>Северная звезда</h1><p>Частые вопросы: завтрак, заезд, бронирование.</p>' };

test('safe extraction returns bounded inert text and observed attributes only', () => {
  const page = extractPage(hotel + '<img src=x onerror=alert(1)>', 'https://hotel.example/');
  assert.equal(page.text.includes('MUST_NOT_APPEAR'), false);
  assert.equal(page.text.includes('<'), false);
  assert.equal(page.text.includes('onerror'), false);
  assert.ok(page.features.phones.length);
  assert.ok(page.features.emails.includes('hello@hotel.example'));
  assert.equal(plainText('<style>secret</style><p>А &amp; Б</p>'), 'А & Б');
  assert.equal(extractPage('<a>Контакты</a>', 'https://hotel.example/').links.length, 0);
});

test('quick research confirms identity, real sources and deterministic configurable score', async () => {
  const f = fixture(hotelRoutes);
  const result = await f.research(project, { kind: 'quick', settings });
  assert.equal(result.officialSite.status, 'verified');
  assert.equal(result.business.industry, 'hotel');
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[1].url, 'https://hotel.example/contacts');
  assert.equal(result.status, 'complete');
  assert.equal(result.signals[0].id, 'industry_hotel');
  assert.ok(result.opportunities.some(item => item.serviceId === 'booking'));
  for (const item of [...result.signals, ...result.opportunities]) {
    assert.ok(item.evidence.length);
    for (const source of item.evidence) { assert.ok(source.url.startsWith('https://hotel.example/')); assert.equal(source.checkedAt, new Date(STAMP).toISOString()); assert.ok(source.quote); }
  }
  assert.ok(result.opportunities.every(item => item.hypothesis === true));
  assert.equal(result.score.components.length, 5);
  assert.ok(result.score.total >= 60 && result.score.total <= 100);
  assert.equal(result.score.priority, 'high');
  assert.equal(f.requests.some(request => request.url.includes('/checkout')), false);
  const weighted = scoreResearch(result, { ...settings, scoreWeights: { fit: 100, opportunity: 0, contacts: 0, freshness: 0, confidence: 0 } }, { now: STAMP });
  assert.equal(weighted.total, 100);
  const excluded = scoreResearch(result, { ...settings, industryProfiles: ['restaurant'], scoreWeights: { fit: 100, opportunity: 0, contacts: 0, freshness: 0, confidence: 0 } }, { now: STAMP });
  assert.equal(excluded.total, 0);
  const zeroWeights = { fit: 0, opportunity: 0, contacts: 0, freshness: 0, confidence: 0 };
  assert.equal(scoreResearch(result, { ...settings, scoreWeights: zeroWeights, deepThreshold: 0 }, { now: STAMP }).priority, 'high');
  assert.equal(scoreResearch(result, { ...settings, scoreWeights: zeroWeights, deepThreshold: 100 }, { now: STAMP }).priority, 'low');
  assert.equal(scoreResearch(result, { ...settings, scoreWeights: { fit: 100, opportunity: 0, contacts: 0, freshness: 0, confidence: 0 }, deepThreshold: 100 }, { now: STAMP }).priority, 'high');
});

test('fresh cache avoids network; deep extends quick and never returns quick as deep', async () => {
  const f = fixture(hotelRoutes);
  const quick = await f.research(project, { kind: 'quick', settings });
  const count = f.requests.length;
  const reused = await f.research(project, { kind: 'quick', settings, previous: { quick } });
  assert.equal(reused.cache.reused, true);
  assert.equal(reused.usage.httpRequests, 0);
  assert.equal(f.requests.length, count);
  const deep = await f.research(project, { kind: 'deep', settings, previous: { quick } });
  assert.equal(deep.kind, 'deep');
  assert.ok(deep.pages.length > quick.pages.length);
  assert.ok(deep.usage.cacheHits >= 1);
  assert.ok(deep.pages.some(page => page.url.endsWith('/rooms')));
});

test('force rechecks and stale etag 304 preserves content with a new check', async () => {
  const f = fixture({ ...hotelRoutes, 'https://hotel.example/': { text: hotel, headers: { etag: '"fixture-v1"' } } });
  const quick = await f.research(project, { kind: 'quick', settings });
  await f.research(project, { kind: 'quick', settings, previous: { quick }, force: true });
  assert.equal(f.requests.filter(request => request.url === project.site).length, 2);
  const stale = { ...quick, expiresAt: '2026-01-01T00:00:00Z' };
  const revalidation = fixture({ ...hotelRoutes, 'https://hotel.example/': { status: 304 } });
  const result = await revalidation.research(project, { kind: 'quick', settings, previous: { quick: stale } });
  assert.equal(result.pages[0].contentHash, quick.pages[0].contentHash);
  assert.equal(revalidation.requests.find(request => request.url === project.site).headers['if-none-match'], '"fixture-v1"');
});

test('robots blocks page and unavailable data creates no fabricated deficiency or score', async () => {
  const f = fixture({ 'https://hotel.example/robots.txt': 'User-agent: *\nDisallow: /' });
  const result = await f.research(project, { settings });
  assert.equal(result.status, 'unknown');
  assert.equal(result.officialSite.status, 'unknown');
  assert.equal(result.score.priority, 'unknown');
  assert.equal(result.score.total, 0);
  assert.equal(result.opportunities.length, 0);
  assert.equal(result.business.industry, 'unknown');
  assert.equal(result.signals.length, 0);
  assert.ok(result.limitations.some(item => item.code === 'ROBOTS_DENIED'));
  assert.equal(f.requests.some(item => item.url === project.site), false);
});

test('same name in another city and uncorroborated single-word brand remain candidates', async () => {
  const f = fixture({ 'https://collision.example/': '<title>Мир — ресторан</title><p>Ресторан Мир, Санкт-Петербург. Меню и столики. Мы ждём гостей каждый день. Вы можете посмотреть меню и выбрать столик для вашего события.</p>' });
  const result = await f.research({ company: 'Мир', city: 'Казань', site: 'https://collision.example/' }, { settings });
  assert.equal(result.officialSite.status, 'candidate');
  assert.equal(result.score.total, 0);
  assert.equal(result.opportunities.length, 0);
  const noCity = await f.research({ company: 'Мир', site: 'https://collision.example/' }, { settings });
  assert.equal(noCity.officialSite.status, 'candidate');
});

test('same-origin contact page can corroborate company with limited quick budget', async () => {
  const f = fixture({ 'https://brand.example/': '<title>Северная звезда</title><h1>Северная звезда — гостиница</h1><p>Проживание и номера, завтрак. Забронировать номер.</p><a href="/contacts">Контакты</a>', 'https://brand.example/contacts': contacts });
  const result = await f.research({ company: 'Северная звезда', city: 'Казань', site: 'https://brand.example/' }, { settings });
  assert.equal(result.officialSite.status, 'verified');
  assert.equal(result.pages.length, 2);
  assert.ok(result.officialSite.evidence.some(item => item.url.endsWith('/contacts')));
});

test('public linked site can be discovered from matching directory; arbitrary links cannot', async () => {
  const directory = '<title>Северная звезда</title><p>Северная звезда, Казань. Телефон +7 (843) 555-12-34.</p><a href="https://hotel.example/">Официальный сайт</a><a href="https://ad.example/">Реклама</a>';
  const f = fixture({ ...hotelRoutes, 'https://2gis.ru/fixture': directory });
  const result = await f.research({ ...project, site: '', source_url: 'https://2gis.ru/fixture' }, { settings });
  assert.equal(result.officialSite.url, project.site);
  assert.equal(result.officialSite.source, 'public_link');
  assert.ok(result.officialSite.evidence.some(item => item.url === 'https://2gis.ru/fixture'));
  assert.equal(f.requests.some(item => item.url.includes('ad.example')), false);
});

test('corporate email supplies a candidate but needs company corroboration; consumer email excluded', async () => {
  assert.equal(officialCandidates({ email: 'owner@gmail.com' }).length, 0);
  const f = fixture(hotelRoutes);
  const found = await f.research({ ...project, site: '', email: 'hello@hotel.example' }, { settings });
  assert.equal(found.officialSite.status, 'verified');
  assert.equal(found.officialSite.source, 'email_domain');
  const mismatch = fixture({ 'https://other.example/': '<title>Unrelated Company</title><p>Contact: hello@other.example. Different company.</p>' });
  const result = await mismatch.research({ company: 'Северная звезда', email: 'hello@other.example' }, { settings });
  assert.equal(result.officialSite.status, 'candidate');
});

test('JavaScript fallback is explicit, protected callback supplied, missing renderer stays unknown', async () => {
  const shell = '<title>Северная звезда</title><div id="app"></div><script src="/app.js"></script>';
  let rendered = 0;
  const yes = fixture({ ...hotelRoutes, 'https://hotel.example/': shell }, { renderer: async (url, options) => { assert.equal(typeof options.fetcher, 'function'); assert.equal(typeof options.checkUrl, 'function'); rendered++; return { html: hotel, url }; } });
  const result = await yes.research(project, { settings });
  assert.equal(rendered, 1);
  assert.equal(result.technical.browser, 'rendered');
  assert.equal(result.usage.browserPages, 1);
  assert.equal(result.officialSite.status, 'verified');
  const no = fixture({ 'https://hotel.example/': shell });
  const unavailable = await no.research(project, { settings });
  assert.equal(unavailable.technical.browser, 'unavailable');
  assert.equal(unavailable.officialSite.status, 'candidate');
  assert.equal(unavailable.score.total, 0);
  assert.equal(unavailable.usage.browserPages, 0);
  assert.ok(unavailable.limitations.some(item => item.code === 'RENDERER_UNAVAILABLE'));
});

test('research propagates abort and handles site HTTP errors without invented site claims', async () => {
  const f = fixture({ 'https://hotel.example/': { status: 503, text: '' } });
  const result = await f.research(project, { settings });
  assert.equal(result.officialSite.status, 'unknown');
  assert.ok(result.limitations.some(item => item.code === 'RATE_LIMITED'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.research(project, { settings, signal: controller.signal }), { code: 'REQUEST_ABORTED' });
});

test('banquet/restaurant/general profiles derive from actual text and text budget is bounded', async () => {
  for (const [industry, description] of [['banquet', 'Банкетный зал, свадьбы и торжества.'], ['restaurant', 'Ресторан, меню и кухня.'], ['general', 'Мастерская ремонта мебели и работа с заказами.']]) {
    const f = fixture({ 'https://company.example/': `<title>Северная звезда</title><p>Северная звезда, Казань. ${description} ${'Работаем каждый день. '.repeat(100)}</p>` });
    const result = await f.research({ company: 'Северная звезда', city: 'Казань', site: 'https://company.example/' }, { settings: { ...settings, maxInputTokens: 500 } });
    assert.equal(result.business.industry, industry);
    assert.ok(result.pages.reduce((sum, page) => sum + page.text.length, 0) <= 1500);
  }
});

test('optional PSI uses one fixed endpoint with header key and retains only measured result', async () => {
  const f = fixture(hotelRoutes, { env: { LEAD_PSI_ENABLED: '1', LEAD_PAGESPEED_KEY: 'fixture-not-a-real-key' } });
  // Fixture's default 404 exercises truthful unavailability without a live call.
  const result = await f.research(project, { settings, kind: 'deep' });
  assert.equal(result.technical.pageSpeed.status, 'unavailable');
  const psi = f.requests.find(item => item.url.startsWith('https://www.googleapis.com/pagespeedonline/'));
  assert.ok(psi);
  assert.equal(psi.headers['X-Goog-Api-Key'], 'fixture-not-a-real-key');
  assert.equal(JSON.stringify(result).includes('fixture-not-a-real-key'), false);
  const off = fixture(hotelRoutes);
  await off.research(project, { settings, kind: 'deep' });
  assert.equal(off.requests.some(item => item.url.includes('googleapis.com')), false);
});

test('page budget counts candidate, source and contact attempts, not only accepted evidence pages', async () => {
  const sites = Array.from({ length: 5 }, (_, index) => `https://candidate${index}.example/`);
  const routes = Object.fromEntries(sites.map(url => [url, '<title>Unrelated business</title><p>Insufficient evidence.</p>']));
  const f = fixture(routes);
  const result = await f.research({ company: 'Северная звезда', city: 'Казань', sites }, { settings: { ...settings, maxPagesQuick: 1 } });
  assert.equal(f.requests.filter(request => new URL(request.url).pathname !== '/robots.txt').length, 1);
  assert.equal(result.usage.pagesAttempted, 1);
  assert.ok(result.limitations.some(item => item.code === 'PAGE_BUDGET'));
  const sourced = fixture({ ...hotelRoutes, 'https://2gis.ru/fixture': '<title>Северная звезда</title><p>Северная звезда, Казань.</p><a href="https://hotel.example/">Официальный сайт</a>' });
  const discovery = await sourced.research({ company: 'Северная звезда', city: 'Казань', source_url: 'https://2gis.ru/fixture' }, { settings: { ...settings, maxPagesQuick: 1 } });
  assert.equal(discovery.usage.pagesAttempted, 1);
  assert.equal(sourced.requests.some(request => request.url === 'https://hotel.example/'), false);
});

test('deep reuse cannot relabel old quick evidence or renew its expiry', async () => {
  const f = fixture(hotelRoutes);
  const quick = await f.research(project, { kind: 'quick', settings });
  quick.checkedAt = '2026-09-11T08:00:00.000Z'; quick.expiresAt = '2026-10-11T08:00:00.000Z';
  for (const page of quick.pages) page.checkedAt = quick.checkedAt;
  const result = await f.research(project, { kind: 'deep', settings: { ...settings, maxPagesDeep: 1 }, previous: { quick } });
  assert.equal(result.checkedAt, quick.checkedAt);
  assert.equal(result.expiresAt, quick.expiresAt);
  assert.equal(result.analyzedAt, new Date(STAMP).toISOString());
  assert.ok(result.score.components.find(item => item.id === 'freshness').value < 1);
});

test('malformed repeated HTML and pathological email text parse in bounded time', () => {
  const started = performance.now();
  assert.equal(plainText('<script>'.repeat(60000)), '');
  const anchors = extractPage('<a>'.repeat(60000), 'https://safe.example/');
  assert.equal(anchors.links.length, 0);
  const email = extractPage('<p>' + 'a.'.repeat(240000) + '@</p>', 'https://safe.example/');
  assert.equal(email.features.emails.length, 0);
  assert.ok(performance.now() - started < 1000);
});
