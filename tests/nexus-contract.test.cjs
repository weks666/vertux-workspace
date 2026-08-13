const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('nexus-product.json'));
const app = read('app.js');
const auth = read('auth.js');
const data = read('data.js');
const html = read('index.html');
const styles = read('styles.css');
const sw = read('sw.js');

assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.product.primaryWorkspace, true);
assert.equal(manifest.identity.contract, 'nexus-product-scoped/v1');
assert.equal(manifest.identity.browserLaunch, 'one-time-fragment-ticket');
assert.equal(manifest.identity.tokensInUrl, false);
assert.equal(manifest.serviceModule.system, true);
assert.equal(manifest.serviceModule.removable, false);
assert.equal(manifest.serviceModule.version, '1.2.1');
assert.equal(manifest.serviceModule.rollbackTarget, '1.2.0');
assert.equal(manifest.serviceModule.rollback.version, '1.2.0');
assert.deepEqual(manifest.serviceModule.sections, ['subscription', 'support', 'access']);
assert.equal(manifest.serviceModule.usage, 'measured-only');

for (const section of ['subscription', 'support', 'access']) {
  assert.match(app, new RegExp(`\\{id:'${section}',\\s*label:'[^']+',\\s*service:true\\}`));
}
assert.doesNotMatch(app.slice(0, app.indexOf('const ICONS')), /\{id:'(?:team|shield)'/);
assert.match(app, /service-module\/v1\.2\.1\/vertux-service-center\.js/);
assert.match(app, /data-service-skeleton/);
assert.match(app, /vertux-service-center-ready/);
assert.match(app, /vertux-service-center-error/);
assert.match(app, /module\.setAttribute\('hide-header',''\)/);
assert.match(app, /SERVICE_SECTIONS\.has\(previous\)&&SERVICE_SECTIONS\.has\(view\)[\s\S]*module\.setAttribute\('section',view\)/);
assert.match(styles, /\.service-module-shell\{[^}]*min-height:440px/);
assert.match(styles, /\.service-skeleton\{/);
assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
assert.match(app, /exactHttpsAssetUrl\(/);
assert.match(app, /window\.VCAuth\.nexusOrigin\(\)/);
assert.match(app, /moduleVersion!=='1\.2\.1'/);
assert.match(app, /canonicalAssetUrl=new URL\('\/service-module\/v1\.2\.1\/vertux-service-center\.js'/);
assert.match(app, /safeHttpUrl\(p\.(?:demo|site|vk_link|source_url)\)/);
assert.doesNotMatch(app, /V\.team|renderTeam|renderInvites|V\.shield|wireShield|bridgeCall/);
assert.doesNotMatch(app, /\sonclick=/i);
assert.match(app, /profileBtn/);
assert.match(app, /productSwitcher/);
assert.match(app, /navigator\.serviceWorker\.register\('sw\.js'\)/);

assert.match(data, /nexusRequired:\s*true/);
assert.match(data, /productBridgeOrigin:\s*'https:\/\/workspace\.vertux\.online'/);
assert.match(data, /aiShieldAuthority:\s*false/);
assert.match(data, /const AI_SHIELD_AUTHORIZED=CONFIG\.aiShieldAuthority===true/);
assert.match(data, /if\(!AI_SHIELD_AUTHORIZED\) throw new Error\('AI-тренер отключён до подтверждения Vertux Shield'\)/);
assert.match(data, /AI_SHIELD_AUTHORIZED\?hookActive\(CONFIG\.aiUrl\):Promise\.resolve\(false\)/);
assert.match(data, /function safeHttpUrl\(/);
assert.match(data, /function exactHttpsAssetUrl\(/);
assert.doesNotMatch(data, /\bWIDGETS\b|adminUrl|bridgeUrl|adminCall|adminActive/);
assert.match(auth, /nexusLaunch/);
assert.match(auth, /history\.replaceState/);
assert.match(auth, /\/api\/product-launch\/exchange/);
assert.doesNotMatch(auth, /BROWSER_SESSION_KEY|createInvite|listInvites/);
assert.match(auth, /nexusOrigin:\s*nexusOrigin/);
assert.match(auth, /function sameOriginProductSession\(\)/);
assert.match(auth, /function productBridgeOrigin\(\)/);
assert.match(auth, /function productApiOrigin\(\)/);
assert.match(auth, /fetch\(productApiOrigin\(\) \+ path/);
assert.match(auth, /data\.productSessionTransport === 'http-only-cookie'/);
assert.match(auth, /credentials: cookieTransport \? 'same-origin' : 'omit'/);
assert.doesNotMatch(auth, /sessionStorage\.(?:setItem|getItem)\([^)]*product_session/i);
assert.match(auth, /if \(!pendingBrowserLaunch\) \{\s*const status = await bridge\.status\(\)/);
assert.match(auth, /\/api\/product-session\/status/);
assert.match(auth, /\/api\/product-session\/logout/);
assert.match(auth, /if \(value\?\.requestId\) body\.requestId = value\.requestId/);
assert.doesNotMatch(auth, /nexusProduct\?\.logout\(\)\.catch|nexusProduct\.logout\(\)\.catch/);
assert.match(auth, /Nexus не подтвердил безопасный выход/);
assert.match(app, /async function signOutSafely\(destination\)/);
assert.match(app, /AI-функции тренера отключены до production-проверки Vertux Shield/);
assert.match(app, /Live-транскрипция работает без них/);
assert.doesNotMatch(app, /Workspace увидит его автоматически/);
assert.match(app, /const sttOn=\(\)=>!!\(window\.SpeechRecognition\|\|window\.webkitSpeechRecognition\)/);
assert.match(app, /function trStartSTT\(\)/);
assert.match(app, /id="trMic" \$\{sttOn\(\)\?'':'disabled'\}/);

assert.match(html, /id="profileBtn"/);
assert.match(html, /id="productSwitcher"/);
assert.match(html, /http-equiv="Content-Security-Policy"/);
assert.match(html, /script-src 'self' https:\/\/nexus\.vertux\.online/);
assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
assert.doesNotMatch(html, /\sonclick=/i);
assert.match(sw, /vertux-workspace-v18/);
assert.match(sw, /manifest\.webmanifest/);
assert.match(sw, /const SHELL_URLS = new Set/);
assert.match(sw, /!policy\.includes\('no-store'\)/);
assert.match(sw, /!SHELL_URLS\.has\(u\.href\)/);
assert.doesNotMatch(sw, /u\.origin === location\.origin && e\.request\.method === 'GET'/);
assert.doesNotMatch(html, /https?:\/\/(?:cdn\.jsdelivr|unpkg|cdnjs)\./);

async function browserBridgeExchangeOrigin(pageOrigin) {
  const requests = [];
  const pageLocation = {
    origin: pageOrigin,
    hash: '#nexusLaunch=abcdefghijklmnopqrstuvwxyz123456&nexusProduct=product-1',
    pathname: '/',
    search: '',
    assign() {},
    reload() {},
  };
  const context = {
    URL,
    URLSearchParams,
    Headers,
    Promise,
    Object,
    Array,
    String,
    RegExp,
    JSON,
    Error,
    location: pageLocation,
    history: { replaceState() { pageLocation.hash = ''; } },
    navigator: { clipboard: { async writeText() {} } },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: {
              productId: 'product-1',
              organizationId: 'org-1',
              productSessionToken: pageOrigin.includes('github.io') ? 'legacy-memory-token-value' : undefined,
              productSessionTransport: pageOrigin.includes('github.io') ? 'bearer-memory' : 'http-only-cookie',
              productSessionExpiresAt: '2026-07-29T20:00:00.000Z',
              user: { id: 'user-1', role: 'manager' },
            },
          };
        },
      };
    },
    setInterval() { return 1; },
    clearInterval() {},
  };
  context.window = {
    VC: {
      CONFIG: {
        nexusOrigin: 'https://nexus.vertux.online',
        productBridgeOrigin: 'https://workspace.vertux.online',
        nexusRequired: true,
      },
    },
    setInterval: context.setInterval,
  };
  vm.runInNewContext(auth, context, { filename: 'auth.js' });
  const result = await context.window.nexusProduct.identity.bootstrap();
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  return requests[0];
}

function aiShieldContext(source) {
  const requests = [];
  const context = {
    URL,
    Promise,
    Object,
    Array,
    String,
    RegExp,
    JSON,
    Error,
    Map,
    Date,
    Uint8Array,
    parseFloat,
    parseInt,
    isFinite,
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    console: { warn() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, status: 'ok' }; },
      };
    },
  };
  context.window = {
    VCAuth: { client() { return null; } },
  };
  vm.runInNewContext(source, context, { filename: 'data.js' });
  return { context, requests };
}

async function verifyAiShieldGate() {
  assert.equal((data.match(/aiShieldAuthority:\s*false/g) || []).length, 1);
  const disabled = aiShieldContext(data);
  assert.equal(disabled.context.window.VC.CONFIG.aiShieldAuthority, false);
  await disabled.context.window.VC.loadData();
  assert.equal(disabled.context.window.VC.CONFIG.aiActive, false);
  assert.equal(disabled.requests.length, 0, 'disabled AI must not probe the webhook');

  disabled.context.window.VC.CONFIG.aiShieldAuthority = true;
  await disabled.context.window.VC.loadData();
  await assert.rejects(
    disabled.context.window.VC.aiCall('suffler', { transcript: 'test transcript' }),
    /Vertux Shield/,
  );
  assert.equal(disabled.requests.length, 0, 'runtime CONFIG mutation must not enable the webhook');

  const reviewedSource = data.replace('aiShieldAuthority: false', 'aiShieldAuthority: true');
  const reviewed = aiShieldContext(reviewedSource);
  await reviewed.context.window.VC.loadData();
  assert.equal(reviewed.context.window.VC.CONFIG.aiActive, true);
  assert.equal(reviewed.requests.length, 1, 'tracked reviewed authority may probe the webhook');
}

(async () => {
  await verifyAiShieldGate();
  const legacyRequest = await browserBridgeExchangeOrigin('https://weks666.github.io');
  assert.equal(legacyRequest.url, 'https://nexus.vertux.online/api/product-launch/exchange');
  assert.equal(legacyRequest.options.credentials, 'omit');
  assert.equal(legacyRequest.options.mode, 'cors');

  const managedRequest = await browserBridgeExchangeOrigin('https://workspace.vertux.online');
  assert.equal(managedRequest.url, 'https://workspace.vertux.online/api/product-launch/exchange');
  assert.equal(managedRequest.options.credentials, 'same-origin');
  assert.equal(managedRequest.options.mode, 'same-origin');

  console.log('Nexus product contract checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
