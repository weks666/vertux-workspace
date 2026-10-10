export const SERVICE_CATALOG = Object.freeze({
  website: 'Сайт и посадочные страницы', booking: 'Бронирование и заявки',
  crm: 'CRM и обработка обращений', automation: 'Автоматизация повторяющихся задач',
});
const DEFAULT_WEIGHTS = { fit: 25, opportunity: 30, contacts: 20, freshness: 10, confidence: 15 };
const bounded = value => Math.max(0, Math.min(1, Number(value) || 0));

// This is a prioritisation heuristic, not a purchase probability or a claim that
// a business has a defect. Every commercial hypothesis retains its own evidence.
export function scoreResearch(research, settings = {}, { now = Date.now() } = {}) {
  const verified = research.officialSite?.status === 'verified';
  const signals = (research.signals || []).filter(item => item.evidence?.length);
  const opportunities = (research.opportunities || []).filter(item => item.evidence?.length && SERVICE_CATALOG[item.serviceId]);
  const requested = settings.scoreWeights || {};
  const weights = Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([key, fallback]) => [key, Number.isFinite(Number(requested[key])) ? Math.max(0, Math.min(100, Number(requested[key]))) : fallback]));
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0) || 100;
  const profiles = Array.isArray(settings.industryProfiles) ? settings.industryProfiles : ['hotel', 'restaurant', 'banquet', 'general'];
  const industry = research.business?.industry || 'unknown';
  const contacts = signals.filter(signal => ['phone', 'email', 'contact_form', 'messenger'].includes(signal.id));
  const ageDays = Math.max(0, (Number(now) - Date.parse(research.checkedAt)) / 86400000);
  const fresh = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / Math.max(1, Number(settings.staleDays) || 30)) : 0;
  const confidence = signals.length ? signals.reduce((sum, signal) => sum + bounded(signal.confidence), 0) / signals.length : 0;
  const factors = {
    fit: verified && profiles.includes(industry) ? (industry === 'general' ? 0.5 : 1) : 0,
    opportunity: verified ? Math.min(1, opportunities.reduce((sum, item) => sum + bounded(item.confidence), 0) / 2.5) : 0,
    contacts: verified ? Math.min(1, contacts.length / 2) : 0,
    freshness: verified && research.pages?.length ? fresh : 0,
    confidence: verified ? bounded(confidence * bounded(research.officialSite.confidence)) : 0,
  };
  const labels = { fit: 'Соответствие профилю', opportunity: 'Гипотезы для обсуждения', contacts: 'Публичные способы связи', freshness: 'Актуальность исследования', confidence: 'Подтверждённость данных' };
  const reasons = {
    fit: !verified ? 'Официальный сайт пока не подтверждён.' : profiles.includes(industry) ? `Профиль ${industry} подтверждён содержанием сайта.` : 'Подтверждённая ниша не входит в выбранные профили.',
    opportunity: opportunities.length ? `${opportunities.length} гипотез с источниками; потребность требует разговора с компанией.` : 'Обоснованных коммерческих гипотез недостаточно.',
    contacts: contacts.length ? `На сайте найдены публичные способы связи: ${contacts.map(item => item.label).join(', ')}. Это не согласие на рассылку.` : 'Способы связи на просмотренных страницах не подтверждены.',
    freshness: research.pages?.length ? `Возраст проверки: ${Math.floor(Number.isFinite(ageDays) ? ageDays : 0)} дн.` : 'Нет успешно проверенных страниц.',
    confidence: verified ? 'Оценка учитывает совпадение компании и уверенность в источниках.' : 'Неопределённость не превращается в баллы.',
  };
  const components = Object.keys(DEFAULT_WEIGHTS).map(id => {
    const max = Math.round((weights[id] / weightTotal) * 10000) / 100;
    return { id, label: labels[id], value: Math.round(factors[id] * max * 100) / 100, max, reason: reasons[id] };
  });
  const total = Math.min(100, Math.round(components.reduce((sum, item) => sum + item.value, 0)));
  const services = Object.keys(SERVICE_CATALOG).flatMap(id => {
    const relevant = opportunities.filter(item => item.serviceId === id);
    return relevant.length ? [{ id, label: SERVICE_CATALOG[id], reason: relevant.map(item => item.label).join(' '), evidenceIds: relevant.map(item => item.id) }] : [];
  });
  const threshold = settings.deepThreshold != null && Number.isFinite(Number(settings.deepThreshold)) ? Math.max(0, Math.min(100, Number(settings.deepThreshold))) : 60;
  return { total, priority: !verified ? 'unknown' : total >= threshold ? 'high' : total >= 35 ? 'medium' : 'low', components, reasons: components.map(item => item.reason), services };
}
