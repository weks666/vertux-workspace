import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readLeadConfig,createAuthenticator} from '../lead-server/run.mjs';

test('real server entrypoint works behind a release symlink, disabled worker performs no network',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lead-entrypoint-test-')),linked=join(dir,'current');
  symlinkSync(fileURLToPath(new URL('../lead-server',import.meta.url)),linked,process.platform==='win32'?'junction':'dir');
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const child=spawn(process.execPath,[join(linked,'run.mjs')],{env:{...process.env,LEAD_ENABLED:'false',LEAD_SUPABASE_URL:'https://database.example.invalid',LEAD_SUPABASE_SERVICE_KEY:'fixture-not-real-service-key',LEAD_SUPABASE_ANON_KEY:'fixture-not-real-anon-key',LEAD_ORGANIZATION_ID:'11111111-1111-4111-8111-111111111111',LEAD_PRODUCT_ID:'22222222-2222-4222-8222-222222222222',LEAD_USAGE_SALT:'fixture-only-private-usage-salt-'.repeat(2),LEAD_OPENROUTER_KEY:'',LEAD_BROWSER_IMAGE:'',LEAD_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  try{
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Entry stopped before listening');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout')),6000);timer.unref();})]);
    const health=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(health.status,200);assert.equal((await health.json()).alive,true);
    const response=await fetch(`http://127.0.0.1:${port}/webhook/vertux-lead-intelligence`,{method:'POST',headers:{Origin:'https://weks666.github.io','Content-Type':'application/json'},body:'{"action":"overview"}'});
    assert.equal(response.status,503);assert.equal((await response.json()).error,'lead_service_disabled');
    assert.equal((await fetch(`http://127.0.0.1:${port}/lead-server/.env`)).status,404);
  }finally{
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.match(basename(dir),/^lead-entrypoint-test-/);rmSync(dir,{recursive:true,force:true});
  }
});
test('configuration refuses unsafe origins and auth forwards bearer only to fixed server destination',async()=>{
  assert.throws(()=>readLeadConfig({LEAD_SUPABASE_URL:'http://internal',LEAD_SUPABASE_SERVICE_KEY:'fixture',LEAD_SUPABASE_ANON_KEY:'fixture'}),/HTTPS/);
  let seen;
  const auth=createAuthenticator({supabaseUrl:'https://database.example.com',anonKey:'fixture-public',fetcher:async(url,options)=>{seen={url,options};return Response.json({id:'fixture-id',app_metadata:{role:'viewer'}});}});
  assert.equal((await auth('Bearer fixture-only-session')).app_metadata.role,'viewer');assert.equal(seen.url,'https://database.example.com/auth/v1/user');assert.equal(seen.options.redirect,'error');
});
