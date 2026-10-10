#!/usr/bin/env node
import net from 'node:net';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Install this file as /broker/docker and prepend /broker to the API's PATH.
// This adapter has no Docker socket or daemon credentials. The root-owned broker
// independently enforces its exact grammar before constructing any command.
export function runDockerProxy({ argv = process.argv.slice(2), socketPath = process.env.LEAD_BROWSER_BROKER_SOCKET || '/run/vertux-lead-browser/broker.sock', input = process.stdin, output = process.stdout, connect = options => net.createConnection(options), timeoutMs = 50000 } = {}) {
  return new Promise(resolve => {
    let connection, timer, connectTimer, ended = false, inputBytes = 0, outputBytes = 0;
    const finish = code => {
      if (ended) return; ended = true;
      clearTimeout(timer); clearTimeout(connectTimer);
      input.unpipe?.(connection); input.pause?.();
      connection?.unpipe?.(output); connection?.destroy();
      input.off?.('data', countInput);
      input.off?.('error', fail);
      if (code && !output.destroyed) output.write('{"type":"error","code":"RENDERER_UNAVAILABLE"}\n');
      resolve(code);
    };
    const fail = () => finish(1);
    const countInput = chunk => { inputBytes += Buffer.byteLength(chunk); if (inputBytes > 16 * 1024 * 1024) fail(); };
    const header = JSON.stringify({ argv }) + '\n';
    if (!Array.isArray(argv) || argv.length > 40 || argv.some(arg => typeof arg !== 'string' || arg.length > 300) || !['run', 'rm'].includes(argv[0]) || Buffer.byteLength(header) > 8192 || !/^\/[A-Za-z0-9_./-]{1,100}$/.test(socketPath) || socketPath.split('/').includes('..')) { fail(); return; }
    timer = setTimeout(fail, Math.max(100, Math.min(50000, Number(timeoutMs) || 50000)));
    connectTimer = setTimeout(fail, 2000);
    try { connection = connect({ path: socketPath }); }
    catch { fail(); return; }
    connection.on('error', fail);
    connection.on('end', () => finish(0));
    connection.on('close', () => finish(0));
    connection.on('data', chunk => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > 8 * 1024 * 1024) fail(); });
    connection.once('connect', () => {
      if (ended) return;
      clearTimeout(connectTimer);
      connection.write(header);
      connection.pipe(output, { end: false });
      input.on('data', countInput);
      input.on('error', fail);
      input.pipe(connection);
    });
  });
}

let isMain = false;
try { isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isMain) {
  process.exitCode = await runDockerProxy();
  process.stdin.destroy();
}
