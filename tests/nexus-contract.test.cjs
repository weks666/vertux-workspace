const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('nexus-product.json'));
const app = read('app.js');
const auth = read('auth.js');
const data = read('data.js');
const html = read('index.html');
const sw = read('sw.js');

assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.product.primaryWorkspace, true);
assert.equal(manifest.identity.contract, 'nexus-product-scoped/v1');
assert.equal(manifest.identity.browserLaunch, 'one-time-fragment-ticket');
assert.equal(manifest.identity.tokensInUrl, false);
assert.equal(manifest.serviceModule.system, true);
assert.equal(manifest.serviceModule.removable, false);
assert.equal(manifest.serviceModule.version, '1.2.0');
assert.equal(manifest.serviceModule.rollbackTarget, '1.1.0');
assert.deepEqual(manifest.serviceModule.sections, ['subscription', 'support', 'access']);
assert.equal(manifest.serviceModule.usage, 'measured-only');

for (const section of ['subscription', 'support', 'access']) {
  assert.match(app, new RegExp(`\\{id:'${section}',\\s*label:'[^']+',\\s*service:true\\}`));
}
assert.doesNotMatch(app.slice(0, app.indexOf('const ICONS')), /\{id:'(?:team|shield)'/);
assert.match(app, /service-module\/v1\.2\/vertux-service-center\.js/);
assert.match(app, /profileBtn/);
assert.match(app, /productSwitcher/);

assert.match(data, /nexusRequired:\s*true/);
assert.match(auth, /nexusLaunch/);
assert.match(auth, /history\.replaceState/);
assert.match(auth, /\/api\/product-launch\/exchange/);
assert.match(auth, /sessionStorage\.setItem\(BROWSER_SESSION_KEY/);
assert.doesNotMatch(auth, /localStorage\.setItem\(BROWSER_SESSION_KEY/);
assert.match(auth, /\/api\/product-session\/status/);
assert.match(auth, /\/api\/product-session\/logout/);

assert.match(html, /id="profileBtn"/);
assert.match(html, /id="productSwitcher"/);
assert.match(sw, /vertux-workspace-v16/);
assert.match(sw, /manifest\.webmanifest/);
assert.doesNotMatch(html, /https?:\/\/(?:cdn\.jsdelivr|unpkg|cdnjs)\./);

console.log('Nexus product contract checks passed');
