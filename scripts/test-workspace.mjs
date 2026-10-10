import {readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const files=(await readdir(resolve(root,'tests'))).filter(n=>/\.test\.(?:cjs|mjs)$/.test(n)&&n!=='lead-ui.test.cjs').sort().map(n=>'tests/'+n);
// Every matched suite uses in-memory/fresh temporary data and synthetic network
// adapters. UI suites have separate explicit launchers and isolated servers.
const child=spawn(process.execPath,['--test',...files],{cwd:root,stdio:'inherit'});
child.on('error',()=>{process.stderr.write('Cannot start test runner\n');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
