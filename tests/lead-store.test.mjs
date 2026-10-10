import test from 'node:test';
import assert from 'node:assert/strict';
import {createLeadStore} from '../lead-server/store.mjs';

const config={supabaseUrl:'https://database.example.test',serviceKey:'ISOLATED_TEST_KEY',organizationId:'organization',productId:'product'};
test('store makes scoped service RPC with actor and database policy aliases',async()=>{
  let called;
  const store=createLeadStore({...config,fetcher:async(url,init)=>{called={url,init,body:JSON.parse(init.body)};return Response.json({excluded:true});}});
  await store.withActor('actor').savePolicy('project',{opted_out:true,contact_permission:{basis:'request'}});
  assert.equal(called.url,'https://database.example.test/rest/v1/rpc/workspace_lead_rpc');
  assert.equal(called.init.redirect,'error');
  assert.equal(called.body.p_organization_id,'organization');
  assert.equal(called.body.p_payload.actorId,'actor');
  assert.equal(called.body.p_payload.optedOut,true);
  assert.deepEqual(called.body.p_payload.contactPermission,{basis:'request'});
});
test('store preserves safe domain failures without exposing upstream body',async()=>{
  for(const [message,expected,status] of [['budget_exceeded','budget_exceeded',409],['plan_quota_exceeded','plan_quota_exceeded',409],['ai_provider_mismatch','ai_provider_mismatch',409],['revision_conflict','revision_conflict',409],['not_found','not_found',404],['scope_mismatch','scope_mismatch',403],['invalid_settings','invalid_settings',400],['private upstream error with credential','store_unavailable',503]]) {
    const store=createLeadStore({...config,fetcher:async()=>Response.json({message,code:'P0001'},{status:400})});
    await assert.rejects(store.overview(),{message:expected,code:expected,status});
  }
});
test('ambiguous network failure does not retry mutations',async()=>{
  let attempts=0;
  const store=createLeadStore({...config,fetcher:async()=>{attempts++;throw new Error('sensitive transport details');}});
  await assert.rejects(store.reserveUsage({requestId:'id'}),{code:'store_unavailable'});
  assert.equal(attempts,1);
});
test('invalid endpoint and oversized upstream response are rejected',async()=>{
  assert.throws(()=>createLeadStore({...config,supabaseUrl:'http://remote.example.test'}),{code:'invalid_store_configuration'});
  assert.throws(()=>createLeadStore({...config,supabaseUrl:'https://user:pass@remote.example.test'}),{code:'invalid_store_configuration'});
  const store=createLeadStore({...config,fetcher:async()=>new Response(new Uint8Array(24*1024*1024+1))});
  await assert.rejects(store.overview(),{code:'invalid_store_response'});
});
