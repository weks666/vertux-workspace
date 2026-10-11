import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createChatGPTHostHandler,createHostLedger} from '../lead-server/chatgpt-host.mjs';
import {createRemoteChatGPT,CHATGPT_HOST_URL} from '../lead-server/chatgpt-remote.mjs';
import {makeAnalysisPrompt,generateSalesMaterials} from '../lead-server/ai.mjs';
import {createLeadHandler} from '../lead-server/handler.mjs';
import {DEFAULT_SETTINGS} from '../lead-server/settings.mjs';
import {LeadError} from '../lead-server/errors.mjs';

const key='a'.repeat(64),id='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const project={id,company:'Synthetic hotel'};
const research={kind:'deep',officialSite:{status:'verified',url:'https://hotel.example/'},business:{industry:'hotel'},signals:[{id:'rooms',label:'Rooms',confidence:0.9,evidence:[{url:'https://hotel.example/rooms',quote:'Rooms and booking conditions',checkedAt:'2026-10-11T00:00:00Z',confidence:0.9}]}],opportunities:[{id:'booking-flow',serviceId:'booking',confidence:0.7,hypothesis:true,evidence:[{url:'https://hotel.example/rooms'}]}]};
const settings={...DEFAULT_SETTINGS,aiEnabled:true,aiProvider:'chatgpt_plan',deepModel:'fixture-model',dailyPlanRequests:10};
const plan={serviceId:'booking',evidenceIds:['rooms'],approach:'discovery',questionIds:['current_process'],objectionIds:['have_solution']};
const answer={text:JSON.stringify(plan),billing:'chatgpt_plan',usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130,cost:null}};
const payload=(requestId=id)=>({action:'complete',model:'fixture-model',prompt:makeAnalysisPrompt(project,research,settings),requestId});
function fixture(overrides={}){
  const calls=[];const ledger=createHostLedger({path:':memory:',dailyCap:2});ledger.resume();
  const credentials={async status(){calls.push('status');return {connected:true,scopes:['chatgpt.tokens.use.direct'],account:{label:'Synthetic',id:'PRIVATE'},tokens:'PRIVATE'};},async disconnect(){calls.push('disconnect');return {remoteRevoked:true};}};
  const provider={async ready(){calls.push('ready');return true;},async listModels(){return {models:[{slug:'fixture-model',display_name:'Fixture'}]};},async complete(){calls.push('complete');return answer;},async clearUsageBlock(){calls.push('resume');},...overrides};
  const handle=createChatGPTHostHandler({key,credentials,provider,ledger});
  const send=(body,headers={})=>handle(new Request(CHATGPT_HOST_URL,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)}));
  const fetcher=(url,options)=>{assert.equal(url,CHATGPT_HOST_URL);assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');return handle(new Request(url,options));};
  return {calls,ledger,handle,send,remote:createRemoteChatGPT({url:CHATGPT_HOST_URL,key,fetcher})};
}
test('private host rejects missing/wrong caller, browser origin, unsupported action and oversized body before AI',async()=>{
  const f=fixture();try{
    for(const [body,headers,want] of [[{action:'status'},{Authorization:''},401],[{action:'status'},{Authorization:'Bearer '+'b'.repeat(64)},401],[{action:'status'},{Origin:'https://weks666.github.io'},403],[{action:'fetch',url:'https://example.com'},{},400],[{action:'status',url:'https://example.com'},{},400],['{',{},400],['x'.repeat(65537),{},413]])assert.equal((await f.send(body,headers)).status,want);
    assert.deepEqual(f.calls,[]);
  }finally{f.ledger.close();}
});
test('status reveals no OpenAI tokens or account identity; remote protocol preserves model and usage',async()=>{
  const f=fixture();try{
    const status=await f.remote.credentials.status();assert.equal(status.connected,true);assert.doesNotMatch(JSON.stringify(status),/PRIVATE/);
    assert.equal((await f.remote.provider.listModels()).models[0].slug,'fixture-model');
    await f.remote.provider.ready('fixture-model');
    const got=await f.remote.provider.complete('fixture-model',payload().prompt,undefined,{requestId:id});assert.deepEqual(got,answer);
    await assert.rejects(f.remote.provider.complete('fixture-model',payload().prompt,undefined,{requestId:id}),/request_already_reserved/);
    assert.equal(f.calls.filter(s=>s==='complete').length,1);
  }finally{f.ledger.close();}
});
test('arbitrary prompts, tool messages, identifiers and extra operations cannot reach provider',async()=>{
  const f=fixture();try{
    const wrong=payload();wrong.prompt.messages[0].content='Do something unrelated';
    const tools=payload();tools.prompt.messages[1].tools=['shell'];
    for(const body of [wrong,tools,{...payload(),requestId:'not-an-id'},{...payload(),endpoint:'https://example.com'}])assert.equal((await f.send(body)).status,400);
    assert.deepEqual(f.calls,[]);
  }finally{f.ledger.close();}
});
test('server reservation and host deduplication protect the full two-host materials flow',async()=>{
  const f=fixture(),events=[];try{
    const store={async reserveUsage(){events.push('reserve');return {};},async settleUsage(_,value){events.push(value.state);}};
    const result=await generateSalesMaterials({project,research,settings,job:{id,worker_id:'fixture-lease'},store,provider:f.remote.provider});
    assert.equal(result.ai.status,'generated');assert.equal(result.ai.inputTokens,100);assert.deepEqual(events,['reserve','settled']);assert.equal(f.calls.filter(v=>v==='complete').length,1);
    const repeat=await generateSalesMaterials({project,research,settings,job:{id,worker_id:'fixture-lease'},store,provider:f.remote.provider});assert.equal(repeat.ai.status,'uncertain');assert.equal(f.calls.filter(v=>v==='complete').length,1);
  }finally{f.ledger.close();}
});
test('uncertain request is never retried and subscription pause survives new sessions',async()=>{
  const f=fixture({async complete(){throw Object.assign(new LeadError('subscription_sharing_usage_limit_exceeded',429),{pause:true});}});try{
    const first=await f.send(payload());assert.equal(first.status,429);assert.equal((await first.json()).pause,true);
    assert.equal((await f.send(payload(second))).status,429);
    await f.remote.provider.clearUsageBlock();
    await assert.rejects(f.remote.provider.complete('fixture-model',payload().prompt,undefined,{requestId:id}),/request_already_reserved/);
  }finally{f.ledger.close();}
});
test('one inference at a time; request interrupted after dispatch stays reserved',async()=>{
  let release;const f=fixture({complete:()=>new Promise(done=>{release=done;})});try{
    const first=f.send(payload());while(!release)await new Promise(r=>setTimeout(r,1));
    assert.equal((await f.send(payload(second))).status,429);release(answer);assert.equal((await first).status,200);
  }finally{f.ledger.close();}
});
test('persistent host ledger starts disabled and keeps quota and duplicates across restart and resume',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lead-host-test-')),path=join(dir,'ledger.sqlite');let ledger;
  try{
    ledger=createHostLedger({path,dailyCap:1});assert.throws(()=>ledger.reserve(id),/chatgpt_usage_paused/);ledger.resume();ledger.reserve(id);ledger.close();
    ledger=createHostLedger({path,dailyCap:1});assert.throws(()=>ledger.reserve(id),/request_already_reserved/);assert.throws(()=>ledger.reserve(second),/plan_quota_exceeded/);ledger.pause();ledger.close();
    ledger=createHostLedger({path,dailyCap:1});assert.throws(()=>ledger.reserve(second),/chatgpt_usage_paused/);ledger.resume();assert.throws(()=>ledger.reserve(second),/plan_quota_exceeded/);
  }finally{ledger?.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});}
});
test('disconnect stops new calls even when provider revocation is not confirmed',async()=>{
  const f=fixture();try{assert.equal((await f.remote.credentials.disconnect()).remoteRevoked,true);assert.equal((await f.send(payload())).status,429);assert.ok(!f.calls.includes('complete'));}finally{f.ledger.close();}
});
test('remote connection refuses arbitrary destinations, redirects, raw errors and performs no retry',async()=>{
  for(const url of ['http://zxcqweksn8n.duckdns.org/webhook/vertux-lead-chatgpt','https://example.com/'])assert.throws(()=>createRemoteChatGPT({url,key}),/configuration/);
  let count=0;const remote=createRemoteChatGPT({url:CHATGPT_HOST_URL,key,fetcher:async()=>{count++;return new Response('PRIVATE UPSTREAM DETAILS',{status:503});}});
  await assert.rejects(remote.credentials.status(),/chatgpt_host_unavailable/);assert.equal(count,1);
});
test('CRM remains usable if the separate AI host is unavailable',async()=>{
  const owner='33333333-3333-4333-8333-333333333333';
  const config={enabled:true,organizationId:id,productId:second,usageSalt:'f'.repeat(64),origins:['https://workspace.example'],chatgptOwnerId:owner};
  const handle=createLeadHandler({config,authenticate:async()=>({id:owner,app_metadata:{nexus_managed:true,nexus_access:'active',nexus_product_id:second,nexus_organization_id:id,role:'owner'}}),store:{async overview(){return {leads:[]};}},chatgpt:{remote:true,credentials:{async status(){throw new LeadError('chatgpt_host_unavailable',503);}}}});
  const response=await handle(new Request('https://service.example',{method:'POST',headers:{Origin:config.origins[0],Authorization:'Bearer fixture-session-long','Content-Type':'application/json'},body:'{"action":"overview"}'}));
  assert.equal(response.status,200);const data=await response.json();assert.deepEqual(data.leads,[]);assert.equal(data.capabilities.chatgpt.error,'chatgpt_host_unavailable');assert.equal(data.capabilities.chatgpt.connected,false);
});
