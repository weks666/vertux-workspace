import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const files=['app.js','data.js','auth.js','workspace-core.js','outreach.js','lead-sales-kit.js','lead-intelligence.js','sw.js',...(await readdir(resolve(root,'lead-server'))).filter(n=>n.endsWith('.mjs')).map(n=>'lead-server/'+n)];
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{cwd:root,encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr||'Syntax check failed\n');process.exit(result.status||1);}}
process.stdout.write(`Syntax checks passed: ${files.length} files.\n`);
