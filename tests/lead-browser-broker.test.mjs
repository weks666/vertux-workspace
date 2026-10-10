import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { runDockerProxy } from '../deploy/lead-docker-proxy.mjs';
import { createBrowserRenderer } from '../lead-server/browser-renderer.mjs';

test('Python broker fixtures use socket pairs and synthetic subprocesses without Docker', { timeout: 30000 }, async () => {
  let rendererArgs;
  const render = createBrowserRenderer({ env: { LEAD_BROWSER_IMAGE: 'sha256:' + 'a'.repeat(64), LEAD_BROWSER_SECCOMP_PROFILE: '/etc/vertux-lead-browser/seccomp.json' }, spawnImpl: (_command, args) => {
    const child = new EventEmitter(); child.unref = () => {};
    if (args[0] === 'rm') return child;
    rendererArgs = args;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.once('data', () => child.stdout.write('{"type":"result","url":"https://synthetic.example/","html":"Fixture"}\n'));
    return child;
  } });
  await render('https://synthetic.example/', { checkUrl: async () => {} });
  const result = await new Promise((done, reject) => {
    const child = spawn(process.env.LEAD_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [resolve(import.meta.dirname, 'lead-browser-broker-fixtures.py')], { cwd: resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', LEAD_TEST_RENDERER_ARGV: JSON.stringify(rendererArgs) } });
    let output = '';
    for (const source of [child.stdout, child.stderr]) source.on('data', chunk => { output += chunk; if (output.length > 50000) { child.kill(); reject(new Error('Fixture output limit')); } });
    child.on('error', reject);
    child.on('exit', code => done({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Ran 8 tests/);
  assert.match(result.output, /\bOK\b/);
});

class FixtureSocket extends Duplex {
  constructor(onWrite) { super(); this.writes = ''; this.onWrite = onWrite; }
  _read() {}
  _write(chunk, _encoding, callback) { this.writes += chunk.toString(); callback(); this.onWrite?.(this); }
}

test('proxy writes one bounded argv header then preserves browser JSONL in both directions', async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = '', replied = false;
  output.on('data', chunk => { text += chunk; });
  const socket = new FixtureSocket(current => {
    if (!replied && current.writes.includes('"type":"init"')) {
      replied = true;
      queueMicrotask(() => { current.push('{"type":"result","url":"https://synthetic.example/","html":"<h1>Fixture</h1>"}\n'); current.push(null); });
    }
  });
  const argv = ['run', '--name', 'fixture'];
  input.write('{"type":"init","url":"https://synthetic.example/"}\n');
  const pending = runDockerProxy({ argv, socketPath: '/fixture/broker.sock', input, output, connect: options => { assert.deepEqual(options, { path: '/fixture/broker.sock' }); queueMicrotask(() => socket.emit('connect')); return socket; } });
  assert.equal(await pending, 0);
  assert.equal(socket.writes, JSON.stringify({ argv }) + '\n{"type":"init","url":"https://synthetic.example/"}\n');
  assert.equal(JSON.parse(text).type, 'result');
  input.destroy(); output.destroy();
});

test('proxy rejects unsupported commands, connection failures and timeouts with stable error only', async () => {
  for (const options of [
    { argv: ['exec', 'unrelated', 'sh'], connect: () => { throw new Error('must not connect'); } },
    { argv: ['run'], connect: () => { throw new Error('private credential-like diagnostic'); } },
    { argv: ['run'], timeoutMs: 100, connect: () => new FixtureSocket() },
  ]) {
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    output.on('data', chunk => { text += chunk; });
    const code = await runDockerProxy({ ...options, socketPath: '/fixture/broker.sock', input, output });
    assert.equal(code, 1);
    assert.equal(text, '{"type":"error","code":"RENDERER_UNAVAILABLE"}\n');
    input.destroy(); output.destroy();
  }
});
