const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storage = new Map();
const localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

let clientCalls = 0;
const operations = { inserts: [], upserts: [] };
const client = {
  from(table) {
    assert.equal(table, 'projects');
    return {
      async insert(rows) {
        operations.inserts.push(rows);
        return { error: null };
      },
      async upsert(rows, options) {
        operations.upserts.push({ rows, options });
        return { error: null };
      },
    };
  },
};

const window = {
  crypto: crypto.webcrypto,
  VCAuth: { client: () => { clientCalls += 1; return client; } },
};
const context = vm.createContext({
  window,
  localStorage,
  console,
  fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }),
});
const source = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
vm.runInContext(source, context, { filename: 'data.js' });
const VC = window.VC;

const makeFile = (name, content) => ({
  name,
  async text() { return content; },
  async arrayBuffer() {
    const bytes = Buffer.from(content, 'utf8');
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
});

(async () => {
  const csv = 'Company,Phone,Call_Script,Antigravity_Prompt,Type\nAcme,+70000000000,Script,Prompt,creation\n';
  const file = makeFile('rockefeller.csv', csv);
  const hash = await VC.fileFingerprint(file);
  assert.equal(hash, crypto.createHash('sha256').update(csv).digest('hex'));
  assert.equal(await VC.fileFingerprint(file), hash, 'fingerprint must be stable');

  const rows = await VC.readFileRows(file);
  const format = VC.detectFormat(rows);
  assert.equal(format.id, 'rockfeller');
  const mapped = VC.mapRows(rows, format);
  assert.equal(mapped.rows.length, 1);
  assert.equal(mapped.rows[0].company, 'Acme');
  assert.equal(mapped.rows[0].processed, true);

  const journalEntry = { hash, file: file.name, at: '2026-07-21T10:00:00.000Z' };
  VC.rememberImport(journalEntry);
  assert.deepEqual(
    JSON.parse(JSON.stringify(VC.findImported(hash))),
    journalEntry,
    'successful import journal must find the exact file',
  );

  await assert.rejects(
    VC.runImport({ fresh: [], existing: [], total: 10 }, 'replace'),
    /полная замена отключена/,
  );
  assert.equal(clientCalls, 0, 'replace mode must be rejected before database initialization');

  const meta = {
    batchId: 'batch-test',
    hash,
    file: file.name,
    source: 'rockfeller',
  };
  const report = await VC.runImport({
    fresh: [{ company: 'Fresh', raw: { Company: 'Fresh' } }],
    existing: [{
      id: 'project-1', company: 'Existing', phone: '+71111111111',
      stage: 'agreed', progress: 90, notes: 'keep', demo: 'https://example.test',
      raw: { calls: [{ result: 'ok' }] },
    }],
  }, 'merge', null, meta);

  assert.equal(report.added, 1);
  assert.equal(report.enriched, 1);
  assert.equal(report.batchId, 'batch-test');
  assert.equal(operations.inserts.length, 1);
  assert.equal(operations.inserts[0][0].stage, 'new');
  assert.equal(operations.inserts[0][0].progress, 5);
  assert.equal(operations.inserts[0][0].raw.Company, 'Fresh');
  assert.equal(operations.inserts[0][0].raw._import.batch_id, 'batch-test');
  assert.equal(operations.inserts[0][0].raw._import.file_hash, hash);

  const enriched = operations.upserts[0].rows[0];
  assert.equal(operations.upserts[0].options.onConflict, 'id');
  assert.equal(enriched.id, 'project-1');
  assert.equal(enriched.phone, '+71111111111');
  for (const protectedField of ['stage', 'progress', 'notes', 'demo', 'raw']) {
    assert.equal(protectedField in enriched, false, `${protectedField} must stay untouched`);
  }

  console.log('CSV import safety checks passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
