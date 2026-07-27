/* Vertux Workspace — вход (Supabase Auth).
 * Пока CONFIG.supabaseUrl пуст — авторизация выключена (демо-режим, локальная работа).
 * Как заполнишь URL+anon key — включается экран входа и аккаунты. */
(function () {
  'use strict';
  let client = null;
  let nexusBootstrapPromise = null;
  let nexusGuardTimer = null;
  let lastNexusError = '';

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

  function nexusBridge() {
    const identity = window.nexusProduct && window.nexusProduct.identity;
    return identity && typeof identity.status === 'function' && typeof identity.bootstrap === 'function'
      ? identity
      : null;
  }

  function nexusManaged() {
    return !!nexusBridge();
  }

  function bridgeError(result, fallback) {
    const error = result && result.error;
    const value = new Error((error && error.message) || fallback);
    value.code = (error && error.code) || 'NEXUS_IDENTITY_FAILED';
    return value;
  }

  function startNexusGuard() {
    if (nexusGuardTimer || !nexusBridge()) return;
    nexusGuardTimer = window.setInterval(async function () {
      try {
        const result = await nexusBridge().status();
        if (!result || result.ok !== true || result.data.active !== false) return;
        const c = init();
        if (c) await c.auth.signOut({ scope: 'local' }).catch(function () {});
        sessionStorage.setItem('vertux-nexus-access-message', result.data.reason || 'Доступ к Workspace приостановлен в Nexus.');
        location.reload();
      } catch (_) {
        // Временный сетевой сбой не завершает рабочую сессию.
      }
    }, 30000);
  }

  async function ensureNexusSession() {
    const bridge = nexusBridge();
    if (!bridge || !enabled()) return null;
    if (nexusBootstrapPromise) return nexusBootstrapPromise;
    nexusBootstrapPromise = (async function () {
      const c = init();
      const existing = await c.auth.getSession();
      const existingUserId = existing.data && existing.data.session && existing.data.session.user
        ? String(existing.data.session.user.id || '')
        : '';
      const status = await bridge.status();
      if (status && status.ok === true && status.data.active === true
        && status.data.externalSubject && status.data.externalSubject === existingUserId) {
        lastNexusError = '';
        startNexusGuard();
        return existing.data.session;
      }

      const result = await bridge.bootstrap();
      if (!result || result.ok !== true) throw bridgeError(result, 'Nexus не смог подготовить вход в Workspace');
      const accessToken = String(result.data && result.data.accessToken || '');
      const refreshToken = String(result.data && result.data.refreshToken || '');
      if (!accessToken || !refreshToken) throw new Error('Nexus вернул неполную сессию Workspace');
      const applied = await c.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      if (applied.error || !applied.data || !applied.data.session) {
        throw applied.error || new Error('Workspace отклонил связанную сессию');
      }
      lastNexusError = '';
      startNexusGuard();
      return applied.data.session;
    })().catch(function (error) {
      lastNexusError = error && error.message ? error.message : 'Не удалось войти через Vertux Nexus';
      nexusBootstrapPromise = null;
      throw error;
    });
    return nexusBootstrapPromise;
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
    if (nexusManaged()) {
      try {
        await ensureNexusSession();
      } catch (_) {
        return null;
      }
    }
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
    await init().auth.signOut({ scope: 'local' });
  }

  function lastError() {
    const stored = sessionStorage.getItem('vertux-nexus-access-message');
    if (stored) {
      sessionStorage.removeItem('vertux-nexus-access-message');
      return stored;
    }
    return lastNexusError;
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
    nexusManaged: nexusManaged, lastError: lastError,
  };
})();
