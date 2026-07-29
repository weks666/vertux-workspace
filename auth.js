/* Vertux Workspace — вход (Supabase Auth).
 * Пока CONFIG.supabaseUrl пуст — авторизация выключена (демо-режим, локальная работа).
 * Как заполнишь URL+anon key — включается экран входа и аккаунты. */
(function () {
  'use strict';
  let client = null;
  let nexusBootstrapPromise = null;
  let nexusGuardTimer = null;
  let lastNexusError = '';
  const BROWSER_SESSION_KEY = 'vertux_nexus_product_session_v1';
  let pendingBrowserLaunch = null;
  let browserSession = readBrowserSession();

  function nexusOrigin() {
    const value = String(window.VC?.CONFIG?.nexusOrigin || 'https://nexus.vertux.online').replace(/\/+$/u, '');
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === ''
        ? url.origin
        : 'https://nexus.vertux.online';
    } catch (_) {
      return 'https://nexus.vertux.online';
    }
  }

  function nexusRequired() {
    return window.VC?.CONFIG?.nexusRequired === true;
  }

  function readBrowserSession() {
    try {
      const value = JSON.parse(sessionStorage.getItem(BROWSER_SESSION_KEY) || 'null');
      if (!value || typeof value.token !== 'string' || typeof value.productId !== 'string'
        || new Date(value.expiresAt).getTime() <= Date.now()) {
        sessionStorage.removeItem(BROWSER_SESSION_KEY);
        return null;
      }
      return value;
    } catch (_) {
      return null;
    }
  }

  function saveBrowserSession(value) {
    browserSession = value;
    try {
      sessionStorage.setItem(BROWSER_SESSION_KEY, JSON.stringify(value));
    } catch (_) {
      // В приватном режиме сессия всё равно останется в памяти текущей вкладки.
    }
  }

  function clearBrowserSession() {
    browserSession = null;
    try {
      sessionStorage.removeItem(BROWSER_SESSION_KEY);
    } catch (_) {
      // Нет доступного sessionStorage.
    }
  }

  function takeBrowserLaunch() {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    const ticket = String(params.get('nexusLaunch') || '');
    const productId = String(params.get('nexusProduct') || '');
    if (!ticket || !/^[A-Za-z0-9_-]{20,512}$/u.test(ticket)
      || !/^[A-Za-z0-9-]{1,80}$/u.test(productId)) return null;
    const returnHash = String(params.get('returnHash') || '');
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}${returnHash ? `#${encodeURIComponent(returnHash)}` : ''}`);
    } catch (_) {
      location.hash = '';
    }
    return { ticket: ticket, productId: productId };
  }

  pendingBrowserLaunch = takeBrowserLaunch();

  async function productRequest(path, options) {
    const session = browserSession;
    if (!session?.token) {
      return { ok: false, status: 401, error: { code: 'PRODUCT_SESSION_REQUIRED', message: 'Откройте Workspace из Vertux Nexus' } };
    }
    const initOptions = options || {};
    const response = await fetch(nexusOrigin() + path, {
      method: initOptions.method || 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + session.token,
        ...(initOptions.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: initOptions.body === undefined ? undefined : JSON.stringify(initOptions.body),
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
    const payload = await response.json().catch(function () {
      return { ok: false, error: { code: 'NEXUS_RESPONSE_INVALID', message: 'Nexus вернул некорректный ответ' } };
    });
    if (response.status === 401 || response.status === 403) {
      clearBrowserSession();
    }
    return { ...payload, status: response.status };
  }

  async function exchangeBrowserLaunch() {
    if (!pendingBrowserLaunch) {
      throw new Error('Сессия Workspace отсутствует. Откройте продукт из Vertux Nexus.');
    }
    const launch = pendingBrowserLaunch;
    pendingBrowserLaunch = null;
    const response = await fetch(nexusOrigin() + '/api/product-launch/exchange', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: launch.ticket, productId: launch.productId }),
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
    const payload = await response.json().catch(function () {
      return { ok: false, error: { message: 'Nexus вернул некорректный ответ' } };
    });
    if (!response.ok || payload.ok !== true) {
      throw bridgeError(payload, 'Ссылка запуска истекла. Откройте Workspace из Nexus снова.');
    }
    const data = payload.data || {};
    if (!data.productSessionToken || !data.productSessionExpiresAt) {
      throw new Error('Nexus не выдал product-scoped сессию');
    }
    saveBrowserSession({
      token: String(data.productSessionToken),
      expiresAt: String(data.productSessionExpiresAt),
      productId: String(data.productId),
      organizationId: String(data.organizationId),
      user: data.user || null,
      serviceModule: data.serviceModule || null,
    });
    return data;
  }

  function installBrowserBridge() {
    if (window.nexusProduct || (!pendingBrowserLaunch && !browserSession)) return;
    const service = Object.freeze({
      config: function () { return productRequest('/api/product-session/service-config'); },
      overview: function () { return productRequest('/api/product-session/service-center'); },
      createTicket: function (value) { return productRequest('/api/product-session/support', { method: 'POST', body: value || {} }); },
      ticketMessages: function (ticketId) {
        return productRequest('/api/product-session/support/' + encodeURIComponent(String(ticketId || '')) + '/messages');
      },
      replyTicket: function (value) {
        return productRequest('/api/product-session/support/' + encodeURIComponent(String(value?.ticketId || '')) + '/messages', {
          method: 'POST',
          body: { message: value?.message || '' },
        });
      },
      invite: function (value) { return productRequest('/api/product-session/invitations', { method: 'POST', body: value || {} }); },
      revokeInvitation: function (invitationId) {
        return productRequest('/api/product-session/invitations/' + encodeURIComponent(String(invitationId || '')) + '/revoke', {
          method: 'POST',
          body: {},
        });
      },
      setMemberStatus: function (value) {
        return productRequest('/api/product-session/members/' + encodeURIComponent(String(value?.userId || '')) + '/status', {
          method: 'POST',
          body: { status: value?.status || '' },
        });
      },
      updateMemberAccess: function (value) {
        return productRequest('/api/product-session/members/' + encodeURIComponent(String(value?.userId || '')) + '/access', {
          method: 'PATCH',
          body: {
            role: value?.role || '',
            accessMode: value?.accessMode || '',
            productIds: Array.isArray(value?.productIds) ? value.productIds : [],
          },
        });
      },
    });
    window.nexusProduct = Object.freeze({
      close: function (view) {
        const target = view === 'profile' ? 'profile' : view === 'support' ? 'support' : 'launch';
        location.assign(nexusOrigin() + '/#' + target);
        return Promise.resolve({ closed: true, view: target });
      },
      logout: async function () {
        const result = browserSession
          ? await productRequest('/api/product-session/logout', { method: 'POST', body: {} }).catch(function () { return null; })
          : null;
        clearBrowserSession();
        return result || { ok: true, data: { loggedOut: true } };
      },
      copyText: async function (text) {
        try {
          await navigator.clipboard.writeText(String(text || ''));
          return { copied: true };
        } catch (_) {
          return { copied: false };
        }
      },
      identity: Object.freeze({
        status: function () { return productRequest('/api/product-session/status'); },
        bootstrap: function () {
          return exchangeBrowserLaunch().then(function (data) { return { ok: true, data: data }; }).catch(function (error) {
            return { ok: false, error: { code: error.code || 'NEXUS_IDENTITY_FAILED', message: error.message } };
          });
        },
      }),
      service: service,
    });
  }

  installBrowserBridge();

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
        if (result && result.ok === true && result.data.active !== false) return;
        const c = init();
        if (c) await c.auth.signOut({ scope: 'local' }).catch(function () {});
        sessionStorage.setItem(
          'vertux-nexus-access-message',
          result?.data?.reason || result?.error?.message || 'Доступ к Workspace приостановлен в Nexus.',
        );
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
    if (nexusRequired() && !nexusManaged()) return null;
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
    const nexusUser = browserSession?.user || null;
    return {
      id: u.id,
      email: nexusUser?.email || u.email,
      name: nexusUser?.name || meta.name || u.email.split('@')[0],
      nexusUserId: nexusUser?.id || null,
      roleKey: key,
      role: ROLES[key].label,
      can: ROLES[key],
      nexusManaged: nexusManaged(),
      productId: browserSession?.productId || null,
      organizationId: browserSession?.organizationId || null,
    };
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
    if (nexusManaged() && typeof window.nexusProduct?.logout === 'function') {
      await window.nexusProduct.logout().catch(function () {});
    }
    await init().auth.signOut({ scope: 'local' });
    clearBrowserSession();
  }

  function openNexus(view) {
    const target = view === 'profile' ? 'profile' : view === 'support' ? 'support' : 'launch';
    if (typeof window.nexusProduct?.close === 'function') return window.nexusProduct.close(target === 'launch' ? 'products' : target);
    location.assign(nexusOrigin() + '/#' + target);
    return Promise.resolve({ opened: true, view: target });
  }

  function sessionContext() {
    return browserSession ? {
      productId: browserSession.productId,
      organizationId: browserSession.organizationId,
      expiresAt: browserSession.expiresAt,
      user: browserSession.user || null,
    } : null;
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
    nexusManaged: nexusManaged, nexusRequired: nexusRequired, lastError: lastError,
    openNexus: openNexus, sessionContext: sessionContext,
  };
})();
