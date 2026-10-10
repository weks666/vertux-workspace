import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { safeFetch, normalizePublicUrl, createRobotsGuard, ResearchFetchError, raceAbort } from './safe-fetch.mjs';
import { scoreResearch } from './scoring.mjs';
import { createBrowserRenderer } from './browser-renderer.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const clamp = (value, fallback, low, high) => Number.isFinite(Number(value)) ? Math.max(low, Math.min(high, Number(value))) : fallback;
const socialOrDirectory = host => /(?:^|\.)(?:2gis\.[a-z.]+|yandex\.[a-z.]+|ya\.ru|google\.[a-z.]+|vk\.com|vk\.ru|t\.me|telegram\.me|ok\.ru|instagram\.com|facebook\.com|wa\.me|whatsapp\.com|tripadvisor\.[a-z.]+|booking\.com|zoon\.ru|avito\.ru)$/i.test(host);
const stripControls = value => String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
const cleanText = (value, max = 48000) => stripControls(value).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const hiddenTags = new Set(['script', 'style', 'noscript', 'template', 'svg']);
const blockTags = new Set(['title', 'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'li', 'br', 'td', 'form']);
function readMarkup(html, maxChars) {
  const body = [], anchors = [], forms = [], meta = Object.create(null), stack = [];
  let bodyLength = 0, title = '', inTitle = false, blocked = 0, anchor = null, form = null, nodes = 0;
  const append = value => { if (bodyLength < maxChars) { const part = value.slice(0, maxChars - bodyLength); body.push(part); bodyLength += part.length; } };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (++nodes > 100000) throw new ResearchFetchError('HTML_TOO_COMPLEX');
      const hidden = hiddenTags.has(name) || Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test((attrs.style || '').slice(0, 2048));
      stack.push({ name, hidden }); if (hidden) blocked++;
      if (blocked) return;
      if (blockTags.has(name)) append(' ');
      if (name === 'title') inTitle = true;
      if (name === 'meta' && (attrs.name || attrs.property)) meta[(attrs.name || attrs.property).toLowerCase().slice(0, 100)] = cleanText(attrs.content || '', 700);
      if (name === 'a' && anchors.length < 150) anchor = { href: stripControls(attrs.href || '').slice(0, 2049), text: '', depth: stack.length };
      if (name === 'form') form = { text: '', search: /(?:search|login|sign.?in)/i.test(`${attrs.role || ''} ${attrs.action || ''}`), depth: stack.length };
      if (name === 'input' && form && ['search', 'password'].includes((attrs.type || '').toLowerCase())) form.search = true;
    },
    ontext(value) {
      if (blocked) return;
      append(value);
      if (inTitle) title = (title + value).slice(0, 300);
      if (anchor) anchor.text = (anchor.text + value).slice(0, 200);
      if (form) form.text = (form.text + value).slice(0, 1500);
    },
    onclosetag(name) {
      if (name === 'a' && anchor?.depth === stack.length) { anchors.push({ href: anchor.href, text: cleanText(anchor.text, 200) }); anchor = null; }
      if (name === 'form' && form?.depth === stack.length) { forms.push({ text: cleanText(form.text, 1500), search: form.search }); form = null; }
      if (name === 'title') inTitle = false;
      const entry = stack.pop(); if (entry?.hidden) blocked = Math.max(0, blocked - 1);
      if (!blocked && blockTags.has(name)) append(' ');
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(String(html).slice(0, 1024 * 1024));
  return { text: cleanText(body.join(''), maxChars), title: cleanText(title, 300), meta, anchors, forms };
}
export function plainText(html, maxLength = 48000) {
  return readMarkup(html, Math.max(0, maxLength)).text;
}
function publicUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = normalizePublicUrl(value, base);
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}
function candidateUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const input = value.trim();
  return publicUrl(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
}
function asValues(value) { return Array.isArray(value) ? value.flatMap(asValues) : typeof value === 'string' ? value.split(/[;\n]/).map(item => item.trim()).filter(Boolean) : []; }
export function officialCandidates(project) {
  const values = [
    ...asValues(project.site).map(value => ({ value, source: 'site', trust: 0.75 })),
    ...asValues(project.contacts?.sites).map(value => ({ value, source: 'contacts.sites', trust: 0.7 })),
    ...asValues(project.sites).map(value => ({ value, source: 'sites', trust: 0.7 })),
  ];
  for (const email of [project.email, ...asValues(project.contacts?.emails)]) {
    const domain = typeof email === 'string' ? email.match(/^[^\s@]+@([a-z0-9.-]+\.[a-z]{2,})$/i)?.[1]?.toLowerCase() : null;
    if (domain && !/^(?:gmail|googlemail|yandex|ya|mail|bk|list|inbox|rambler|outlook|hotmail|live|msn|icloud|me|mac|yahoo|proton|protonmail|aol|gmx|qq|163)\./i.test(domain)) values.push({ value: `https://${domain}/`, source: 'email_domain', trust: 0.45 });
  }
  const seen = new Set();
  return values.flatMap(entry => {
    const url = candidateUrl(entry.value);
    if (!url || socialOrDirectory(new URL(url).hostname) || seen.has(url)) return [];
    seen.add(url); return [{ url, source: entry.source, trust: entry.trust }];
  }).slice(0, 5);
}

export function extractPage(html, url, { checkedAt = new Date().toISOString(), maxChars = 48000, status = 200, durationMs = null, bytes = 0, headers = {}, rendered = false } = {}) {
  const raw = String(html).slice(0, 1024 * 1024);
  const parsed = readMarkup(raw, Math.max(0, maxChars));
  const { title, meta } = parsed;
  const links = []; const contactAttributes = [];
  for (const attr of parsed.anchors) {
    const text = attr.text;
    if (/^(?:tel:|mailto:)/i.test(attr.href || '')) {
      const contact = (attr.href || '').split('?')[0].slice(0, 150);
      if (!/[<>\r\n]/.test(contact)) contactAttributes.push(contact);
      continue;
    }
    const href = publicUrl(attr.href, url);
    if (href && !links.some(link => link.url === href)) links.push({ url: href, text });
  }
  const bodyText = parsed.text;
  const extras = [...new Set(contactAttributes)].slice(0, 15);
  for (const link of links.filter(link => /(?:^|\.)(?:t\.me|wa\.me|whatsapp\.com|vk\.com)$/i.test(new URL(link.url).hostname)).slice(0, 5)) extras.push(link.url);
  if (meta.generator) extras.push(meta.generator);
  const text = `${bodyText}${extras.length ? ` Из атрибутов страницы: ${extras.join('; ')}` : ''}`.slice(0, maxChars);
  const phones = [...new Set((text.match(/(?:\+\d[\d ()-]{8,22}\d|\b8[ (]\d[\d ()-]{8,19}\d)/g) || []).filter(value => value.replace(/\D/g, '').length >= 10))].slice(0, 10);
  const emails = [...new Set(text.split(/\s+/).flatMap(token => {
    if (token.length > 320 || !token.includes('@')) return [];
    const value = token.replace(/^mailto:/i, '').replace(/^[([{"']+|[.,;:!?)}\]"']+$/g, '');
    return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,6}$/i.test(value) ? [value] : [];
  }))].slice(0, 10);
  const technologies = [];
  const markers = [['WordPress', /(?:wp-content\/|wp-includes\/|content=["']WordPress)/i], ['Tilda', /(?:tildacdn\.|tilda-blocks|t-records)/i], ['1C-Битрикс', /(?:\/bitrix\/|bitrix24)/i], ['Wix', /(?:wixstatic\.com|wix-code)/i], ['Next.js', /(?:\/_next\/|__NEXT_DATA__)/i], ['React', /(?:react-dom|data-reactroot)/i], ['Vue', /(?:vue\.runtime|data-v-[a-f0-9]{6,})/i]];
  for (const [name, pattern] of markers) if (pattern.test(raw)) technologies.push({ name, confidence: 0.8, basis: 'public_markup', url });
  const features = {
    phones, emails,
    contactForm: parsed.forms.some(form => !form.search && /(?:обратн|заявк|связ|contact|request|booking|бронир)/i.test(form.text)),
    booking: /(?:забронировать|бронировать|бронирование|book\s+(?:now|a\s+table|a\s+room)|reserve)/i.test(text),
    messenger: links.some(link => /(?:^|\.)(?:t\.me|wa\.me|whatsapp\.com|vk\.com)$/i.test(new URL(link.url).hostname)),
    menu: /(?:меню|\bmenu\b)/i.test(text),
    hours: /(?:режим работы|часы работы|работаем|opening hours|ежедневно)/i.test(text),
    faq: /(?:частые вопросы|часто задаваемые|вопросы и ответы|\bfaq\b)/i.test(text),
  };
  return { url, title, text, contentHash: hash(text), checkedAt, status, durationMs, bytes, rendered,
    description: meta.description || meta['og:description'] || '', links, features, technologies,
    etag: typeof headers.etag === 'string' ? headers.etag.slice(0, 512) : null,
    lastModified: typeof headers['last-modified'] === 'string' ? headers['last-modified'].slice(0, 512) : null,
    needsJavaScript: bodyText.length < 180 && /(?:<script\b|enable javascript|включите javascript|id=["'](?:root|app|__next)["'])/i.test(raw),
  };
}

function identity(project, page, { requireName = false } = {}) {
  const normalize = value => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const company = normalize(project.company || project.name);
  const nameWords = company.split(' ').filter(word => word.length >= 3 && !['ооо', 'ао', 'ип', 'гостиница', 'отель', 'ресторан', 'кафе', 'банкетный', 'зал'].includes(word));
  const title = normalize(`${page.title} ${page.text.slice(0, 1800)}`);
  const fullText = normalize(page.text);
  const name = nameWords.length > 0 && nameWords.filter(word => title.split(' ').includes(word)).length / nameWords.length >= 0.7;
  const phones = [project.phone, ...asValues(project.contacts?.phones)].filter(Boolean).map(value => String(value).replace(/\D/g, '').slice(-10)).filter(value => value.length === 10);
  const phone = (page.features?.phones || []).some(value => phones.includes(value.replace(/\D/g, '').slice(-10)));
  const emails = [project.email, ...asValues(project.contacts?.emails)].filter(Boolean).map(value => String(value).toLowerCase());
  const email = (page.features?.emails || []).some(value => emails.includes(value.toLowerCase()));
  const city = normalize(project.city);
  const cityMatch = city.length >= 3 && (` ${fullText} `).includes(` ${city} `);
  const addressWords = normalize(project.address).split(' ').filter(word => word.length >= 3 && !['улица', 'ул', 'дом', 'россия'].includes(word));
  const addressMatch = addressWords.length >= 2 && addressWords.filter(word => fullText.split(' ').includes(word)).length / addressWords.length >= 0.8;
  const distinctiveTitle = !city && !project.address && nameWords.filter(word => word.length >= 4).length >= 2 && normalize(page.title).includes(company);
  const matched = (!requireName || name) && (phone || email || (name && (cityMatch || addressMatch || distinctiveTitle)));
  return { matched, nameMatched: name, confidence: !matched ? 0.35 : phone || email ? 0.95 : distinctiveTitle ? 0.75 : 0.9,
    reason: !matched ? name ? 'Название совпадает, но принадлежность сайта этой компании не подтверждена контактами или местоположением.' : requireName && (phone || email) ? 'Контакт найден на предполагаемом домене, но название компании не подтверждено.' : 'Одного URL из карточки недостаточно для подтверждения принадлежности сайта.' : phone || email ? 'Публичный контакт совпадает с карточкой компании.' : distinctiveTitle ? 'Отличительное составное название совпадает с заголовком сайта; география не указана в карточке.' : 'Название и местоположение компании совпадают с содержанием сайта.' };
}
function quoteFor(page, expression, fallback = '') {
  const match = expression ? page.text.match(expression) : null;
  if (!match) return (fallback || page.title || page.text).slice(0, 220);
  const index = Math.max(0, match.index - 65);
  return page.text.slice(index, Math.min(page.text.length, match.index + match[0].length + 115)).trim();
}
const evidence = (page, quote, confidence = 0.85) => ({ url: page.url, quote: String(quote).slice(0, 350), checkedAt: page.checkedAt, confidence });
function factsFor(pages, officialSite) {
  if (officialSite.status !== 'verified') return { business: { industry: 'unknown', description: '', services: [], audience: [] }, signals: [], opportunities: [] };
  const signals = [], opportunities = [];
  const signal = (id, label, page, expression, confidence = 0.85, fallback) => {
    if (signals.some(item => item.id === id)) return;
    signals.push({ id, label, evidence: [evidence(page, quoteFor(page, expression, fallback), confidence)], confidence, hypothesis: false });
  };
  for (const page of pages) {
    const f = page.features || {};
    if (f.phones?.length) signal('phone', 'Телефон', page, null, 0.95, f.phones[0]);
    if (f.emails?.length) signal('email', 'Email', page, null, 0.95, f.emails[0]);
    if (f.contactForm) signal('contact_form', 'Форма обращения', page, /(?:заявк|связ|contact|request|бронир)/i, 0.8);
    if (f.booking) signal('booking', 'Упоминание бронирования', page, /(?:забронировать|бронировать|бронирование|book\s+(?:now|a\s+table|a\s+room)|reserve)/i, 0.9);
    if (f.messenger) {
      const link = page.links.find(link => /(?:^|\.)(?:t\.me|wa\.me|whatsapp\.com|vk\.com)$/i.test(new URL(link.url).hostname));
      // Quote the published anchor; the destination is retained as a separate attribute.
      signal('messenger', 'Мессенджер или соцсеть', page, null, 0.85, link.text || link.url);
    }
    if (f.menu) signal('menu', 'Меню', page, /(?:меню|\bmenu\b)/i);
    if (f.hours) signal('hours', 'Режим работы', page, /(?:режим работы|часы работы|работаем|opening hours|ежедневно)/i);
    if (f.faq) signal('faq', 'Ответы на частые вопросы', page, /(?:частые вопросы|часто задаваемые|вопросы и ответы|\bfaq\b)/i);
  }
  let industry = 'unknown', industryPage = null, industryExpression = null;
  const profiles = [['banquet', /(?:банкет|свадеб|торжеств|banquet|wedding venue)/i], ['hotel', /(?:отел[ьяею]|гостиниц|проживание|\bhotel\b|\brooms?\b)/i], ['restaurant', /(?:ресторан|кафе|\brestaurant\b|\bcafe\b)/i]];
  for (const [profile, expression] of profiles) {
    const page = pages.find(page => expression.test(page.text));
    if (page) { industry = profile; industryPage = page; industryExpression = expression; break; }
  }
  if (industryPage) signal(`industry_${industry}`, { hotel: 'Гостиничный бизнес', restaurant: 'Ресторанный бизнес', banquet: 'Банкеты и события' }[industry], industryPage, industryExpression);
  else if (pages.some(page => page.text.length >= 180)) industry = 'general';
  const services = [];
  const servicePatterns = [['Проживание', /(?:проживание|номера|accommodation|rooms)/i], ['Банкеты', /(?:банкеты|банкетов|банкетный|banquets?)/i], ['Свадьбы', /(?:свадьб|свадеб|weddings?)/i], ['Питание и меню', /(?:меню|завтрак|кухня|menu|breakfast)/i], ['Доставка', /(?:доставка|доставки|delivery)/i], ['Конференции', /(?:конференц|conference)/i], ['Спа', /(?:\bspa\b|спа|массаж)/i]];
  for (const [label, pattern] of servicePatterns) if (pages.some(page => pattern.test(page.text))) services.push(label);
  const audience = [];
  for (const [label, pattern] of [['Семьи с детьми', /(?:семь[яеи].{0,20}дет|с детьми)/i], ['Корпоративные клиенты', /(?:корпоратив|business guests)/i], ['Туристы', /(?:турист|tourists?)/i]]) if (pages.some(page => pattern.test(page.text))) audience.push(label);
  const addOpportunity = (id, label, serviceId, ids, confidence = 0.7) => {
    const supporting = signals.filter(item => ids.includes(item.id));
    if (!supporting.length || officialSite.status !== 'verified') return;
    opportunities.push({ id, label, serviceId, confidence, hypothesis: true, evidence: supporting.flatMap(item => item.evidence).slice(0, 3) });
  };
  if (['hotel', 'restaurant', 'banquet'].includes(industry) && signals.some(item => item.id === 'booking')) addOpportunity('direct_booking', 'Обсудить удобство прямого бронирования и передачи заявок менеджеру.', 'booking', ['booking', `industry_${industry}`], 0.8);
  if (signals.filter(item => ['phone', 'email', 'contact_form', 'messenger'].includes(item.id)).length >= 2) addOpportunity('contact_workflow', 'Уточнить, нужен ли единый учёт обращений из опубликованных каналов связи.', 'crm', ['phone', 'email', 'contact_form', 'messenger'], 0.8);
  if (signals.some(item => ['faq', 'hours', 'booking'].includes(item.id))) addOpportunity('routine_questions', 'Проверить, какие повторяющиеся вопросы и подтверждения можно автоматизировать.', 'automation', ['faq', 'hours', 'booking'], 0.65);
  if (services.length >= 2 && industryPage) addOpportunity('service_pages', 'Обсудить, нужны ли отдельные страницы для представленных услуг и событий.', 'website', [`industry_${industry}`, 'menu', 'booking'], 0.65);
  const order = id => id.startsWith('industry_') ? 0 : ['booking', 'menu', 'faq', 'hours'].includes(id) ? 1 : 2;
  signals.sort((a, b) => order(a.id) - order(b.id));
  return { business: { industry, description: (pages[0]?.description || pages[0]?.text || '').slice(0, 450), services, audience }, signals, opportunities };
}

const limitationMessages = {
  ROBOTS_DENIED: 'Страница запрещена правилами robots.txt.', ROBOTS_UNAVAILABLE: 'Правила robots.txt не удалось получить; обход приостановлен.',
  PRIVATE_ADDRESS: 'Адрес не прошёл проверку публичной сети.', UNSAFE_HOST: 'Адрес не является допустимым публичным сайтом.',
  REQUEST_TIMEOUT: 'Сайт не ответил в пределах времени проверки.', REQUEST_FAILED: 'Не удалось безопасно получить страницу.',
  DNS_FAILED: 'Не удалось разрешить публичный адрес сайта.', RATE_LIMITED: 'Сайт ограничил частоту запросов; повтор возможен позже.',
  CRAWL_DELAY: 'Задержка сайта превышает время одной проверки.', BODY_TOO_LARGE: 'Размер страницы превышает безопасный лимит.',
  RENDERER_UNAVAILABLE: 'Для JavaScript-страницы нужен настроенный изолированный браузер.', BROWSER_FAILED: 'Изолированный браузер не завершил проверку.',
  HTTP_BUDGET: 'Достигнут лимит сетевых запросов исследования.', JS_CONTENT_UNKNOWN: 'Содержимое JavaScript-страницы не удалось подтвердить.',
  HTTP_UNAVAILABLE: 'Страница вернула ошибку HTTP.', NON_HTML: 'Источник не является HTML-страницей.',
  INPUT_LIMIT: 'Исследование ограничено лимитом текста.',
  PAGE_BUDGET: 'Достигнут лимит страниц, включая проверку кандидатов и источников.',
};

export function createResearcher({ fetcher = safeFetch, renderer, now = Date.now, env = process.env } = {}) {
  const defaultRenderer = renderer === undefined ? createBrowserRenderer({ env }) : renderer;
  return async function researchCompany(project, { kind = 'quick', settings = {}, previous = null, signal, force = false } = {}) {
    if (!['quick', 'deep'].includes(kind)) throw new ResearchFetchError('INVALID_KIND');
    if (signal?.aborted) throw new ResearchFetchError('REQUEST_ABORTED');
    const checkedAt = new Date(now()).toISOString();
    const maxPages = Math.floor(clamp(kind === 'deep' ? settings.maxPagesDeep : settings.maxPagesQuick, kind === 'deep' ? 6 : 2, 1, 12));
    const timeoutMs = clamp(settings.requestTimeoutMs, 12000, 500, 30000);
    const minDelayMs = clamp(settings.requestsPerHostDelayMs, 1000, 0, 60000);
    const maxChars = Math.floor(clamp(settings.maxInputTokens, 12000, 500, 40000) * 3);
    const staleDays = clamp(settings.staleDays, 30, 1, 365);
    const inputHash = hash(JSON.stringify([project.company, project.site, project.sites, project.source_url, project.phone, project.email, project.contacts]));
    const configHash = hash(JSON.stringify({ kind, maxPages, maxChars, scoreWeights: settings.scoreWeights, industryProfiles: settings.industryProfiles, deepThreshold: settings.deepThreshold }));
    const old = previous?.schemaVersion === 1 ? previous : previous?.[kind];
    if (!force && old?.kind === kind && old.cache?.inputHash === inputHash && old.cache?.configHash === configHash && Date.parse(old.expiresAt) > now()) {
      return { ...structuredClone(old), score: scoreResearch(old, settings, { now: now() }), usage: { httpRequests: 0, browserPages: 0, cacheHits: old.pages?.length || 0, pagesAttempted: 0 }, cache: { ...old.cache, reused: true } };
    }
    const previousPages = [...(old?.pages || []), ...(kind === 'deep' ? previous?.quick?.pages || [] : [])];
    const pages = [], limitations = [], usage = { httpRequests: 0, browserPages: 0, cacheHits: 0 };
    let pageAttempts = 0; const pageReads = new Map();
    let remainingChars = maxChars; const maxRequests = maxPages * 6 + 10;
    const addLimit = (code, url, extra = {}) => { if (!limitations.some(item => item.code === code && item.url === url)) limitations.push({ code, message: limitationMessages[code] || 'Данные недоступны в безопасном режиме проверки.', ...(url ? { url } : {}), ...extra }); };
    const onRequest = () => { signal?.throwIfAborted(); if (usage.httpRequests >= maxRequests) throw new ResearchFetchError('HTTP_BUDGET'); usage.httpRequests++; };
    const robots = createRobotsGuard(fetcher, { signal, timeoutMs, minDelayMs, onRequest, now });
    const request = (url, options = {}) => fetcher(url, { signal, timeoutMs, minDelayMs, maxBytes: 1024 * 1024, beforeRequest: robots.check, ...options,
      onRequest: event => { onRequest(); options.onRequest?.(event); } });
    const technical = { robots: 'respected', browser: 'not_needed', pageSpeed: { status: 'not_configured' }, transport: fetcher === safeFetch ? 'dns_pinned_public_only' : 'injected_test_transport' };
    function readPage(url, options = {}) {
      if (pageReads.has(url)) return pageReads.get(url);
      if (pageAttempts >= maxPages) return Promise.reject(new ResearchFetchError('PAGE_BUDGET'));
      pageAttempts++;
      const pending = readPageUncached(url, options); pageReads.set(url, pending); return pending;
    }
    async function readPageUncached(url, { allowBrowser = true } = {}) {
      await robots.check(url);
      const cached = previousPages.find(page => page.url === url && page.contentHash === hash(page.text) && page.features && page.links);
      const freshQuick = kind === 'deep' && previous?.quick?.pages?.includes(cached) && Date.parse(previous.quick.expiresAt) > now() && previous.quick.cache?.inputHash === inputHash;
      if (!force && freshQuick) { usage.cacheHits++; return { ...structuredClone(cached), cached: true, cacheExpiresAt: previous.quick.expiresAt }; }
      const response = await request(url, { headers: cached ? { 'if-none-match': cached.etag, 'if-modified-since': cached.lastModified } : {} });
      if (response.status === 304 && cached) { usage.cacheHits++; return { ...structuredClone(cached), checkedAt, cached: true, cacheExpiresAt: null }; }
      if (response.status < 200 || response.status >= 300) throw new ResearchFetchError('HTTP_UNAVAILABLE', { status: response.status });
      const contentType = response.headers?.['content-type'] || '';
      if (contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) throw new ResearchFetchError('NON_HTML');
      let page = extractPage(response.text, response.url || url, { checkedAt, maxChars: Math.max(0, remainingChars), status: response.status, headers: response.headers, durationMs: response.durationMs, bytes: response.bytes });
      if (page.needsJavaScript && allowBrowser) {
        technical.browser = 'needed';
        if (defaultRenderer) {
          try {
            const rendered = await raceAbort(defaultRenderer(page.url, { signal, timeoutMs, maxBytes: 1024 * 1024, fetcher: request, checkUrl: robots.check, maxRequests: Math.min(35, maxRequests - usage.httpRequests) }), signal);
            if (!rendered || typeof rendered.html !== 'string') throw new ResearchFetchError('BROWSER_FAILED');
            usage.browserPages++;
            const renderedPage = extractPage(rendered.html, rendered.url || page.url, { checkedAt, maxChars: Math.max(0, remainingChars), rendered: true, status: 200, bytes: Buffer.byteLength(rendered.html) });
            if (renderedPage.text.length > page.text.length) page = renderedPage;
            technical.browser = page.text.length >= 180 ? 'rendered' : 'incomplete';
          } catch (cause) { if (signal?.aborted) throw new ResearchFetchError('REQUEST_ABORTED'); addLimit(cause.code || 'BROWSER_FAILED', page.url); technical.browser = 'unavailable'; }
        } else { addLimit('RENDERER_UNAVAILABLE', page.url); technical.browser = 'unavailable'; }
        if (page.text.length < 180) addLimit('JS_CONTENT_UNKNOWN', page.url);
      }
      if (cached?.contentHash === page.contentHash) usage.cacheHits++;
      return page;
    }
    const acceptPage = page => {
      if (pages.some(item => item.url === page.url)) return;
      if (page.text.length > remainingChars) {
        const text = page.text.slice(0, Math.max(0, remainingChars));
        page = { ...page, text, contentHash: hash(text), truncated: true,
          features: { ...page.features, phones: (page.features.phones || []).filter(phone => text.includes(phone)), emails: (page.features.emails || []).filter(email => text.includes(email)) } };
      }
      pages.push(page); remainingChars -= page.text.length;
    };
    const candidates = officialCandidates(project);
    const sourceUrl = candidateUrl(project.source_url);
    let sourceDiscovered = false;
    async function discoverSource() {
      sourceDiscovered = true;
      if (!sourceUrl) return;
      try {
        const source = await readPage(sourceUrl, { allowBrowser: false });
        const sourceIdentity = identity(project, source);
        if (sourceIdentity.matched && !socialOrDirectory(new URL(source.url).hostname)) candidates.push({ url: source.url, source: 'source_url', trust: 0.6, page: source });
        if (sourceIdentity.matched) for (const link of source.links) {
          if (/(?:официальн.{0,12}сайт|веб.?сайт|website|official.{0,12}site)/i.test(link.text) && !socialOrDirectory(new URL(link.url).hostname)) candidates.push({ url: link.url, source: 'public_link', trust: 0.65, sourceEvidence: evidence(source, link.text, 0.75) });
        }
      } catch (cause) { if (signal?.aborted) throw new ResearchFetchError('REQUEST_ABORTED'); addLimit(cause.code || 'REQUEST_FAILED', sourceUrl, cause.retryAt ? { retryAt: cause.retryAt } : {}); }
    }
    if (!candidates.length) await discoverSource();
    let officialSite = { url: null, status: 'unknown', confidence: 0, reason: 'Подтверждённый официальный сайт не найден в карточке и доступных публичных ссылках.' };
    let chosen = null, corroboratingPage = null;
    for (let candidateIndex = 0; candidateIndex < 6; candidateIndex++) {
      if (candidateIndex >= candidates.length && !sourceDiscovered) await discoverSource();
      const candidate = candidates[candidateIndex]; if (!candidate) break;
      if (pages.length >= maxPages || remainingChars <= 0) break;
      try {
        const page = candidate.page || await readPage(candidate.url);
        let match = identity(project, page, { requireName: candidate.source === 'email_domain' }), contactPage = null;
        if (!match.matched && match.nameMatched && maxPages > 1) {
          const contact = page.links.find(link => new URL(link.url).origin === new URL(page.url).origin && /(?:contact|контакт|связ)/i.test(`${link.text} ${new URL(link.url).pathname}`));
          if (contact && contact.url !== page.url) {
            try {
              contactPage = await readPage(contact.url);
              if (new URL(contactPage.url).origin === new URL(page.url).origin) match = identity(project, { ...page, text: `${page.text} ${contactPage.text}`, features: { phones: [...page.features.phones, ...contactPage.features.phones], emails: [...page.features.emails, ...contactPage.features.emails] } }, { requireName: candidate.source === 'email_domain' });
              else contactPage = null;
            } catch (cause) { if (signal?.aborted) throw new ResearchFetchError('REQUEST_ABORTED'); addLimit(cause.code || 'REQUEST_FAILED', contact.url); }
          }
        }
        if (socialOrDirectory(new URL(page.url).hostname)) { addLimit('OFFICIAL_SITE_UNCONFIRMED', page.url); continue; }
        const verified = match.matched;
        if (verified || !chosen) {
          chosen = page;
          corroboratingPage = contactPage;
          officialSite = { url: page.url, status: verified ? 'verified' : 'candidate', confidence: verified ? match.confidence : 0.35, reason: match.reason, source: candidate.source,
            evidence: [evidence(page, quoteFor(page, null), match.confidence), ...(contactPage ? [evidence(contactPage, quoteFor(contactPage, null), match.confidence)] : []), ...(candidate.sourceEvidence ? [candidate.sourceEvidence] : [])] };
        }
        if (verified) break;
      } catch (cause) { if (signal?.aborted) throw new ResearchFetchError('REQUEST_ABORTED'); addLimit(cause.code || 'REQUEST_FAILED', candidate.url, cause.retryAt ? { retryAt: cause.retryAt } : {}); if (cause.code === 'PAGE_BUDGET') break; }
    }
    if (chosen) acceptPage(chosen);
    if (corroboratingPage && pages.length < maxPages) acceptPage(corroboratingPage);
    if (chosen && officialSite.status === 'verified') {
      const origin = new URL(chosen.url).origin;
      const pending = chosen.links.filter(link => new URL(link.url).origin === origin).sort((a, b) => pageRelevance(b) - pageRelevance(a));
      const attempted = new Set([chosen.url]);
      while (pending.length && pages.length < maxPages && pageAttempts < maxPages && remainingChars >= 500) {
        const link = pending.shift(); if (attempted.has(link.url) || pageRelevance(link) === 0) continue;
        attempted.add(link.url);
        try {
          const page = await readPage(link.url);
          if (new URL(page.url).origin !== origin) { addLimit('EXTERNAL_REDIRECT', link.url); continue; }
          acceptPage(page);
          if (kind === 'deep') pending.push(...page.links.filter(next => new URL(next.url).origin === origin && !attempted.has(next.url)).sort((a, b) => pageRelevance(b) - pageRelevance(a)));
        } catch (cause) { if (signal?.aborted) throw new ResearchFetchError('REQUEST_ABORTED'); addLimit(cause.code || 'REQUEST_FAILED', link.url, cause.retryAt ? { retryAt: cause.retryAt } : {}); if (cause.code === 'RATE_LIMITED' || cause.code === 'HTTP_BUDGET') break; }
      }
    }
    if (remainingChars < 500) addLimit('INPUT_LIMIT');
    const facts = factsFor(pages, officialSite);
    const evidenceDate = Math.min(now(), ...pages.map(page => Date.parse(page.checkedAt)).filter(Number.isFinite));
    const evidenceExpiry = Math.min(evidenceDate + staleDays * 86400000, ...pages.map(page => Date.parse(page.cacheExpiresAt)).filter(Number.isFinite));
    const result = { schemaVersion: 1, kind, status: officialSite.status === 'verified' ? (limitations.length ? 'partial' : 'complete') : pages.length ? 'partial' : 'unknown', checkedAt: new Date(evidenceDate).toISOString(), analyzedAt: checkedAt,
      expiresAt: new Date(evidenceExpiry).toISOString(), officialSite, ...facts, pages, limitations,
      technologies: officialSite.status === 'verified' ? [...new Map(pages.flatMap(page => page.technologies || []).map(item => [item.name, item])).values()] : [], technical,
      usage: { ...usage, pagesAttempted: pageAttempts }, cache: { inputHash, configHash, reused: false },
    };
    if (kind === 'deep' && officialSite.status === 'verified' && env.LEAD_PSI_ENABLED === '1') result.technical.pageSpeed = await pageSpeed(officialSite.url, { fetcher, signal, timeoutMs, onRequest, now, env });
    result.usage = { ...usage, pagesAttempted: pageAttempts };
    result.score = scoreResearch(result, settings, { now: now() });
    return result;
  };
}
function pageRelevance(link) {
  const text = `${new URL(link.url).pathname} ${link.text}`;
  if (/(?:logout|login|sign.?in|cart|checkout|basket|личный|кабинет|корзин|оплат|privacy|policy|terms|политик|\.pdf(?:$|\?))/i.test(text)) return 0;
  if (/(?:contact|контакт|связ)/i.test(text)) return 10;
  if (/(?:booking|брони|reservation|menu|меню|services|услуг|rooms|номер|banquet|банкет)/i.test(text)) return 8;
  if (/(?:about|о нас|о компании|conference|конференц|faq|вопрос)/i.test(text)) return 5;
  return 0;
}

async function pageSpeed(url, { fetcher, signal, timeoutMs, onRequest, now, env }) {
  // Explicit opt-in only. Optional key is origin-scoped and header-only; it never
  // enters URLs, stored evidence, logs or page output. No paid AI provider.
  try {
    const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.searchParams.set('url', url); endpoint.searchParams.set('strategy', 'mobile'); endpoint.searchParams.set('category', 'performance');
    const response = await fetcher(endpoint.href, { signal, timeoutMs, maxBytes: 4 * 1024 * 1024, minDelayMs: 1000, onRequest, accept: 'application/json', googleApiKey: env.LEAD_PAGESPEED_KEY });
    if (response.status !== 200) return { status: 'unavailable', reason: 'PSI_HTTP_ERROR' };
    const parsed = JSON.parse(response.text), score = parsed.lighthouseResult?.categories?.performance?.score;
    if (!Number.isFinite(score)) return { status: 'unavailable', reason: 'PSI_NO_SCORE' };
    return { status: 'measured', strategy: 'mobile', performance: Math.round(score * 100), checkedAt: new Date(now()).toISOString(), source: 'Google PageSpeed Insights', url,
      limitation: 'Лабораторный замер одной страницы; не оценка всей компании.' };
  } catch { return { status: 'unavailable', reason: 'PSI_REQUEST_FAILED' }; }
}

let productionResearcher;
export function researchCompany(project, options = {}) {
  if (options.fetcher || Object.hasOwn(options, 'renderer') || options.now || options.env) return createResearcher(options)(project, options);
  productionResearcher ||= createResearcher();
  return productionResearcher(project, options);
}
