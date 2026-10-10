import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {createChatGPTLoopback} from '../lead-server/chatgpt-loopback.mjs';

test('local OAuth helper binds callback to the browser transaction and never serves credentials',async t=>{
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin=`http://127.0.0.1:${port}`;let calls=0;
  const credentials={async begin({redirectUri}){assert.equal(redirectUri,origin+'/auth/callback');return {authorizationUrl:'https://auth.openai.com/api/accounts/authorize?state=fixture-state',expiresAt:new Date(Date.now()+60000).toISOString()};},async callback(input){calls++;assert.equal(input.code,'fixture-code');return {connected:true};}};
  const helper=await createChatGPTLoopback({credentials,port});t.after(()=>helper.close());
  assert.equal((await fetch(origin+'/auth/start',{method:'POST',headers:{Origin:'https://foreign.test'},redirect:'manual'})).status,403);
  const start=await fetch(origin+'/auth/start',{method:'POST',headers:{Origin:origin},redirect:'manual'});assert.equal(start.status,303);
  const cookie=start.headers.get('set-cookie').split(';')[0];assert.match(start.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  const path=origin+'/auth/callback?state=fixture-state&code=fixture-code';
  assert.equal((await fetch(path)).status,400);assert.equal(calls,0);
  const accepted=await fetch(path,{headers:{Cookie:cookie}});assert.equal(accepted.status,200);assert.match(await accepted.text(),/ChatGPT подключён/);assert.equal(calls,1);
  assert.equal((await fetch(path,{headers:{Cookie:cookie}})).status,400);assert.equal(calls,1);
  assert.equal((await fetch(origin+'/chatgpt-auth.json')).status,404);
});
