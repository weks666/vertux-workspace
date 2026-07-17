/* Vertux Workspace — вход (Supabase Auth).
 * Пока CONFIG.supabaseUrl пуст — авторизация выключена (демо-режим, локальная работа).
 * Как заполнишь URL+anon key — включается экран входа и аккаунты. */
(function () {
  'use strict';
  let client = null;

  function enabled() {
    const c = window.VC && window.VC.CONFIG;
    return !!(c && c.supabaseUrl && c.supabaseAnonKey && window.supabase);
  }

  function init() {
    if (!enabled()) return null;
    if (!client) {
      client = window.supabase.createClient(window.VC.CONFIG.supabaseUrl, window.VC.CONFIG.supabaseAnonKey);
    }
    return client;
  }

  /* Уровни доступа. Роль хранится в app_metadata — её пишет только сервер,
     сам пользователь поменять себе роль не может. */
  const ROLES = {
    owner:   { label: 'основатель',    invite: true,  roles: true,  edit: true,  finance: true  },
    admin:   { label: 'администратор', invite: true,  roles: false, edit: true,  finance: true  },
    manager: { label: 'менеджер',      invite: false, roles: false, edit: true,  finance: false },
    viewer:  { label: 'наблюдатель',   invite: false, roles: false, edit: false, finance: false },
  };

  async function currentUser() {
    if (!enabled()) return { email: 'демо-режим', name: 'Степан', roleKey: 'owner', role: ROLES.owner.label, can: ROLES.owner, demo: true };
    const c = init();
    const { data } = await c.auth.getSession();
    const u = data && data.session && data.session.user;
    if (!u) return null;
    const meta = u.user_metadata || {};
    const app = u.app_metadata || {};
    const key = ROLES[app.role] ? app.role : 'viewer';
    return { id: u.id, email: u.email, name: meta.name || u.email.split('@')[0], roleKey: key, role: ROLES[key].label, can: ROLES[key] };
  }

  async function signIn(email, password) {
    const c = init();
    if (!c) throw new Error('Вход не настроен');
    const { data, error } = await c.auth.signInWithPassword({ email: email, password: password });
    if (error) throw error;
    return data;
  }

  /* Регистрация ТОЛЬКО через серверную функцию: она проверяет код приглашения
     и создаёт аккаунт админским ключом. Прямая регистрация в Supabase запрещена. */
  async function signUpWithCode(email, password, name, code) {
    const c = window.VC.CONFIG;
    const res = await fetch(c.supabaseUrl + '/functions/v1/register-with-code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': c.supabaseAnonKey,
        'Authorization': 'Bearer ' + c.supabaseAnonKey,
      },
      body: JSON.stringify({ email: email, password: password, name: name, code: code }),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.error) throw new Error(data.error || 'register_failed');
    return data;
  }

  /* Генерация одноразового кода приглашения (только для залогиненных — защищено RLS) */
  async function createInvite(role, note) {
    const c = init();
    if (!c) throw new Error('Вход не настроен');
    const { data: u } = await c.auth.getUser();
    if (!u || !u.user) throw new Error('Нужно войти');
    const r = ROLES[role] ? role : 'manager';
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = 'VRTX-' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(function (b) { return alphabet[b % alphabet.length]; }).join('');
    const { error } = await c.from('invite_codes').insert({ code: code, created_by: u.user.id, role: r, note: note || null });
    if (error) throw error;
    return code;
  }

  async function listInvites() {
    const c = init();
    if (!c) return [];
    const { data } = await c.from('invite_codes')
      .select('code, created_at, used_by, used_at, note, role')
      .order('created_at', { ascending: false }).limit(20);
    return data || [];
  }

  async function signOut() {
    if (!enabled()) return;
    await init().auth.signOut();
  }

  function humanError(e) {
    const m = (e && e.message ? e.message : String(e)).toLowerCase();
    if (m.includes('code_not_found')) return 'Код приглашения не найден — проверьте, что ввели его целиком';
    if (m.includes('code_used')) return 'Этот код уже использован. Попросите новый';
    if (m.includes('weak_password')) return 'Пароль слишком короткий — минимум 8 символов';
    if (m.includes('bad_input')) return 'Заполните почту, пароль и код приглашения';
    if (m.includes('create_failed')) return 'Не удалось создать аккаунт — возможно, эта почта уже занята';
    if (m.includes('signup_disabled')) return 'Регистрация возможна только по коду приглашения';
    if (m.includes('invalid login')) return 'Неверная почта или пароль';
    if (m.includes('failed to fetch') || m.includes('networkerror')) {
      return 'Не удаётся связаться с сервером аккаунтов. Если Supabase на http:// — браузер его блокирует, нужен https.';
    }
    if (m.includes('email not confirmed')) return 'Почта не подтверждена';
    return e && e.message ? e.message : 'Не удалось войти';
  }

  window.VCAuth = {
    ROLES: ROLES, client: init,
    enabled: enabled, currentUser: currentUser, signIn: signIn,
    signUpWithCode: signUpWithCode, createInvite: createInvite, listInvites: listInvites,
    signOut: signOut, humanError: humanError,
  };
})();
