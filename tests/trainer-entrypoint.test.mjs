import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';

test('version symlink starts the real entrypoint and rejects unauthenticated traffic without paid calls',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'workspace-entry-test-'));
  const linked=join(dir,'current');symlinkSync(fileURLToPath(new URL('../trainer-server',import.meta.url)),linked,process.platform==='win32'?'junction':'dir');
  const free=createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
  const child=spawn(process.execPath,[join(linked,'run.mjs')],{env:{...process.env,TRAINER_ENABLED:'true',TRAINER_PRODUCT_ID:'fixture-product',TRAINER_ORGANIZATION_ID:'fixture-org',TRAINER_USAGE_SALT:'fixture-only-private-salt-'.repeat(2),TRAINER_OPENROUTER_KEY:'fixture-no-provider-requests',TRAINER_MODEL:'openai/gpt-4.1-mini',TRAINER_MAX_KEY_USD:'5',TRAINER_TOTAL_BUDGET_USD:'5',TRAINER_SUPABASE_ANON_KEY:'fixture-key',TRAINER_DAILY_TOKENS:'100000',TRAINER_USER_DAILY_TOKENS:'10000',TRAINER_REQUESTS_PER_MINUTE:'10',TRAINER_BUDGET_DB:join(dir,'budget.sqlite'),TRAINER_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  try{
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('entrypoint exited before listening');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),5000);timer.unref();})]);
    const response=await fetch('http://127.0.0.1:'+port+'/webhook/vertux-ai-trainer',{method:'POST',headers:{Origin:'https://weks666.github.io','Content-Type':'application/json'},body:'{"mode":"health"}'});
    assert.equal(response.status,401);assert.equal((await response.json()).error,'not_authenticated');
  }finally{
    if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.match(basename(dir),/^workspace-entry-test-/);
    rmSync(dir,{recursive:true,force:true});
  }
});
