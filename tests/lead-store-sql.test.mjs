import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {PGlite,createDatabase,createSqlStore,insertProject,uuid,organizationId,productId,ownerId,managerId,viewerId,foreignId,research} from './lead-store-runtime/harness.mjs';

test('isolated Postgres migration and durable queue semantics',async t=>{
  const db=await createDatabase();
  t.after(()=>db.close());
  const store=createSqlStore(db);
  await t.test('structural RLS and RPC ACL checks',async()=>{
    await db.exec(await readFile(new URL('../supabase/tests/lead_intelligence.sql',import.meta.url),'utf8'));
  });
  await t.test('real authenticated import queues without granting client writes',async()=>{
    await db.transaction(async tx=>{
      await tx.exec('SET LOCAL ROLE authenticated');
      await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[managerId]);
      await tx.query('INSERT INTO public.projects(id,company,site) VALUES($1,$2,$3)',[uuid(98),'Authenticated fixture','https://fixture.test']);
    });
    assert.equal((await store.detail(uuid(98))).jobs[0].kind,'quick');
    for(const [n,metadata] of [[91,{role:'platform_admin'}],[92,{nexus_product_id:uuid(999)}],[93,{nexus_organization_id:uuid(999)}]]) {
      const id=uuid(n);
      await db.query('INSERT INTO auth.users(id,raw_app_meta_data) VALUES($1,$2)',[id,{role:'owner',nexus_managed:true,nexus_access:'active',nexus_organization_id:organizationId,nexus_product_id:productId,...metadata}]);
      await db.transaction(async tx=>{
        await tx.exec('SET LOCAL ROLE authenticated'); await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[id]);
        assert.equal((await tx.query('SELECT * FROM public.workspace_lead_records')).rows.length,0);
      });
      await assert.rejects(store.withActor(id).overview(),{code:'scope_mismatch'});
    }
    await db.query('DELETE FROM public.projects WHERE id=$1',[uuid(98)]);
  });
  await t.test('defaults and defensive settings validation',async()=>{
    assert.equal((await store.getSettings()).dailyQuick,500);
    assert.equal((await store.getSettings()).aiProvider,'openrouter');
    assert.equal((await store.getSettings()).dailyPlanRequests,10);
    for(const patch of [{concurrency:0},{dailyQuick:-1},{communication:{mode:'send',dailySendLimit:1}},{aiEnabled:'yes'},{timezone:'Fake/Zone'},{scoreWeights:{fit:100}},{unknown:true},{aiProvider:'automatic'},{dailyPlanRequests:0},{dailyPlanRequests:51},{dailyPlanRequests:1.5}]) {
      await assert.rejects(store.saveSettings(patch),{code:'invalid_settings'});
    }
    await store.withActor(ownerId).saveSettings({dailyQuick:500,concurrency:2});
    await assert.rejects(store.withActor(managerId).saveSettings({paused:true}),{code:'scope_mismatch'});
    await assert.rejects(store.withActor(viewerId).enqueue(uuid(1),'quick'),{code:'scope_mismatch'});
  });

  await t.test('existing import trigger deduplicates and source updates invalidate leases',async()=>{
    await insertProject(db,1);
    const original=(await store.detail(uuid(1))).jobs[0];
    assert.equal(original.kind,'quick');
    assert.equal((await store.enqueue(uuid(1),'quick')).id,original.id);
    await db.query('UPDATE public.projects SET notes=$1 WHERE id=$2',['manager note',uuid(1)]);
    assert.equal((await store.detail(uuid(1))).jobs.length,1);
    const claimed=await store.claim('worker-a');
    assert.match(claimed.worker_id,/^worker-a:[0-9a-f-]{36}$/);
    assert.equal(claimed.project.id,uuid(1));
    await db.query('UPDATE public.projects SET site=$1 WHERE id=$2',['https://new.fixture.test',uuid(1)]);
    await assert.rejects(store.complete(claimed.id,claimed.worker_id,research()),{code:'stale_lease'});
    assert.equal((await store.detail(uuid(1))).jobs.filter(j=>j.status==='queued').length,1);
  });

  await t.test('global concurrency and per-company serialization',async()=>{
    await insertProject(db,2); await insertProject(db,3);
    const claims=await Promise.all([store.claim('one'),store.claim('two'),store.claim('three')]);
    assert.equal(claims.filter(Boolean).length,2);
    assert.equal(new Set(claims.filter(Boolean).map(j=>j.project_id)).size,2);
    for(const j of claims.filter(Boolean)) await store.complete(j.id,j.worker_id,research());
  });

  await t.test('fencing rejects former worker after restart and caps retries',async()=>{
    const j=await store.claim('same'); assert.ok(j);
    await db.query("UPDATE public.workspace_lead_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[j.id]);
    assert.equal(await store.claim('same'),null);
    await db.query("UPDATE public.workspace_lead_jobs SET next_run_at=now()-interval '1 second' WHERE id=$1",[j.id]);
    const reclaimed=await store.claim('same'); assert.notEqual(reclaimed.worker_id,j.worker_id);
    await assert.rejects(store.heartbeat(j.id,j.worker_id,{}),{code:'stale_lease'});
    await assert.rejects(store.complete(j.id,j.worker_id,research()),{code:'stale_lease'});
    await store.fail(reclaimed.id,reclaimed.worker_id,'fixture_network_error');
    await db.query("UPDATE public.workspace_lead_jobs SET next_run_at=now()-interval '1 second' WHERE id=$1",[j.id]);
    const last=await store.claim('same'); const failed=await store.fail(last.id,last.worker_id,'fixture_network_error');
    assert.equal(failed.status,'failed'); assert.equal(failed.attempts,3);
    assert.equal(await store.claim('same'),null);
  });

  await t.test('pause resume cancel and manual low-score deep',async()=>{
    let j=await store.enqueue(uuid(1),'deep');
    assert.equal((await store.controlJob(j.id,'pause')).status,'paused');
    assert.equal(await store.claim('paused'),null);
    await store.controlJob(j.id,'resume');
    j=await store.claim('resumed');
    await store.controlJob(j.id,'cancel');
    await assert.rejects(store.complete(j.id,j.worker_id,research('deep')),{code:'stale_lease'});
    await store.controlJob(j.id,'retry');
    j=await store.claim('retry'); await store.complete(j.id,j.worker_id,research('deep',10));
    assert.equal((await store.detail(uuid(1))).lead.deep.score.total,10);
  });

  await t.test('daily counters survive failed and cancelled jobs',async()=>{
    const counts=(await db.query('SELECT quick_started FROM public.workspace_lead_daily')).rows[0];
    await store.saveSettings({dailyQuick:counts.quick_started});
    await store.enqueue(uuid(2),'quick',{force:true});
    assert.equal(await store.claim('daily-cap'),null);
    await store.saveSettings({dailyQuick:500});
  });

  await t.test('optimistic materials edits survive background completion',async()=>{
    const j=await store.claim('materials');
    const detail=await store.detail(j.project_id);
    await store.withActor(managerId).saveMaterials(j.project_id,detail.lead.materials_revision,{summary:'Manager draft',followUps:[]});
    await assert.rejects(store.saveMaterials(j.project_id,detail.lead.materials_revision,{summary:'stale'}),{code:'revision_conflict'});
    await store.complete(j.id,j.worker_id,research());
    assert.equal((await store.detail(j.project_id)).lead.materials.summary,'Manager draft');
  });

  await t.test('atomic budget reservations, persistent uncertainty, and idempotency',async()=>{
    await store.saveSettings({aiEnabled:true,dailyBudgetUsd:0.1,companyBudgetUsd:0.08});
    const request={requestId:'budget-one',projectId:uuid(1),costNanos:60000000,inputTokens:100,outputTokens:10,model:'openai/gpt-4.1-mini'};
    const reserved=await store.reserveUsage(request); assert.equal(reserved.duplicate,false);
    assert.equal((await createSqlStore(db).reserveUsage(request)).duplicate,true);
    await assert.rejects(store.reserveUsage({...request,costNanos:1}),{code:'idempotency_conflict'});
    const race=await Promise.allSettled([store.reserveUsage({...request,requestId:'budget-two',projectId:uuid(2),costNanos:30000000}),store.reserveUsage({...request,requestId:'budget-three',projectId:uuid(3),costNanos:30000000})]);
    assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(race.filter(x=>x.status==='rejected')[0].reason.code,'budget_exceeded');
    await store.settleUsage(request.requestId,{state:'uncertain'});
    await assert.rejects(store.settleUsage(request.requestId,{state:'released'}),{code:'invalid_transition'});
    await assert.rejects(store.reserveUsage({...request,requestId:'company-cap',costNanos:25000000}),{code:'budget_exceeded'});
    await store.settleUsage(request.requestId,{state:'settled',costNanos:10000000,inputTokens:50,outputTokens:5});
    await store.settleUsage(request.requestId,{state:'settled',costNanos:10000000,inputTokens:50,outputTokens:5});
    await assert.rejects(store.settleUsage(request.requestId,{state:'settled',costNanos:0}),{code:'idempotency_conflict'});
    const report=await store.overview();
    assert.equal(report.usage.costNanos,10000000); assert.equal(report.usage.reservedNanos,30000000);
    await assert.rejects(store.reserveUsage({...request,requestId:'lower-server-cap',costNanos:10000,dailyCapNanos:20000000,companyCapNanos:80000000}),{code:'budget_exceeded'});
    await assert.rejects(store.reserveUsage({...request,requestId:'zero-server-cap',costNanos:10000,dailyCapNanos:0}),{code:'budget_exceeded'});
    await assert.rejects(store.reserveUsage({...request,requestId:'fraction',costNanos:1.5}),{code:'invalid_usage'});
    await assert.rejects(store.reserveUsage({...request,requestId:'text-cost',costNanos:'500'}),{code:'invalid_usage'});
  });

  await t.test('refusal cancels research, purge preserves CRM and spent budget',async()=>{
    const j=await store.enqueue(uuid(1),'quick',{force:true});
    await store.withActor(managerId).addReply(uuid(1),{classification:'refusal',suggestedReply:'Acknowledged',nextAction:'stop'});
    assert.equal((await store.detail(uuid(1))).lead.opted_out,true);
    assert.equal((await store.detail(uuid(1))).jobs.find(x=>x.id===j.id).status,'cancelled');
    await assert.rejects(store.enqueue(uuid(1),'deep',{force:true}),{code:'opted_out'});
    await assert.rejects(store.withActor(managerId).purge(uuid(1)),{code:'scope_mismatch'});
    await store.withActor(ownerId).purge(uuid(1));
    const d=await store.detail(uuid(1)); assert.equal(d.lead.quick,null); assert.equal(d.lead.deep,null); assert.equal(d.lead.materials,null); assert.deepEqual(d.replies,[]); assert.deepEqual(d.jobs,[]);
    assert.equal((await store.getProject(uuid(1))).id,uuid(1));
    assert.equal((await store.overview()).usage.costNanos,10000000);
    await db.query('UPDATE public.projects SET company=$1 WHERE id=$2',['Changed after purge',uuid(1)]);
    assert.equal((await store.detail(uuid(1))).jobs.length,0);
  });

  await t.test('daily schedule is once-per-local-day and ranks deep candidates',async()=>{
    const started=(await db.query('SELECT deep_started FROM public.workspace_lead_daily')).rows[0].deep_started;
    await store.saveSettings({autoQuick:false,autoDeep:true,dailyDeep:started+1,scheduleTime:'00:00'});
    await insertProject(db,4); await insertProject(db,5);
    await db.query('UPDATE public.workspace_lead_records SET quick=$1,score=$2 WHERE project_id=$3',[research(),{total:75,priority:'high'},uuid(4)]);
    await db.query('UPDATE public.workspace_lead_records SET quick=$1,score=$2 WHERE project_id=$3',[research(),{total:95,priority:'high'},uuid(5)]);
    assert.equal((await store.schedule()).ran,true); assert.equal((await store.schedule()).ran,false);
    assert.equal((await store.detail(uuid(5))).jobs.find(j=>j.kind==='deep').priority,95);
    assert.equal((await store.detail(uuid(4))).jobs.filter(j=>j.kind==='deep').length,0);
  });

  await t.test('scope, fresh RLS, and no authenticated worker impersonation',async()=>{
    await assert.rejects(createSqlStore(db,{organizationId:uuid(999)}).overview(),{code:'scope_mismatch'});
    await assert.rejects(store.withActor(foreignId).overview(),{code:'scope_mismatch'});
    await assert.rejects(store.withActor(ownerId).claim('spoof'),{code:'scope_mismatch'});
    await db.transaction(async tx=>{
      await tx.exec('SET LOCAL ROLE authenticated');
      await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[managerId]);
      assert.ok((await tx.query('SELECT * FROM public.workspace_lead_records')).rows.length>0);
    });
    for(const sql of ["UPDATE public.workspace_lead_settings SET config='{}'",'DELETE FROM public.workspace_lead_jobs',`SELECT public.workspace_lead_rpc('${organizationId}','${productId}','claim','{"workerId":"spoof"}')`]) {
      await assert.rejects(db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE authenticated'); await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ownerId]); await tx.exec(sql);}),/permission denied/);
    }
    await db.query("UPDATE auth.users SET raw_app_meta_data=jsonb_set(raw_app_meta_data,'{nexus_access}','\"suspended\"') WHERE id=$1",[ownerId]);
    await db.transaction(async tx=>{
      await tx.exec('SET LOCAL ROLE authenticated'); await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
      await tx.exec(`SELECT set_config('request.jwt.claims','{"app_metadata":{"role":"owner","nexus_access":"active"}}',true)`);
      assert.equal((await tx.query('SELECT * FROM public.workspace_lead_records')).rows.length,0);
    });
    await assert.rejects(store.withActor(ownerId).saveSettings({paused:true}),{code:'scope_mismatch'});
  });
  await t.test('compact cursor pages and incremental updates do not silently truncate',async()=>{
    const first=await store.overview({limit:2});
    assert.equal(first.total,5); assert.equal(first.leads.length,2); assert.ok(first.nextCursor); assert.ok(first.serverTime);
    assert.ok(!('materials' in first.leads[0])); assert.ok(!('pages' in (first.leads[1].quick||{})));
    const next=await store.overview({cursor:first.nextCursor,limit:2});
    assert.equal(next.leads.length,2); assert.ok(!('usage' in next));
    const end=await store.overview({cursor:next.nextCursor,limit:2}); assert.equal(end.nextCursor,null); assert.equal(end.leads.length,1);
    assert.equal(new Set([...first.leads,...next.leads,...end.leads].map(x=>x.project_id)).size,5);
    await store.savePolicy(uuid(2),{excluded:true});
    const changed=await store.overview({since:first.serverTime});
    assert.equal(changed.total,5); assert.equal(changed.leads.length,1); assert.equal(changed.leads[0].project_id,uuid(2));
    await assert.rejects(store.overview({limit:1001}),{code:'invalid_payload'});
  });
  await t.test('rollback preserves existing CRM and finance security',async()=>{
    await db.exec(await readFile(new URL('../supabase/rollback/lead-intelligence.sql',import.meta.url),'utf8'));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.projects')).rows[0].n,5);
    assert.equal((await db.query("SELECT to_regclass('public.workspace_lead_records') AS gone")).rows[0].gone,null);
    assert.ok((await db.query("SELECT to_regprocedure('workspace_private.current_role()') AS present")).rows[0].present);
    assert.ok((await db.query("SELECT to_regclass('public.workspace_project_finance') AS present")).rows[0].present);
  });
});

test('automatic deep continuation waits for Quick results and reranks same-day candidates',async t=>{
  const db=await createDatabase(); t.after(()=>db.close()); const store=createSqlStore(db);
  await store.saveSettings({scheduleTime:'00:00',dailyQuick:3,dailyDeep:1});
  for(let n=21;n<=23;n++)await insertProject(db,n);
  assert.equal((await store.schedule()).deepDeferred,true);
  let j=await store.claim('quick-a'); await store.complete(j.id,j.worker_id,research('quick',65));
  assert.equal((await store.schedule()).deepDeferred,true);
  j=await store.claim('quick-b'); await store.complete(j.id,j.worker_id,research('quick',85));
  j=await store.claim('quick-c'); await store.complete(j.id,j.worker_id,research('quick',95));
  const result=await store.schedule(); assert.equal(result.deepDeferred,false); assert.equal(result.deep,1);
  assert.equal((await store.detail(uuid(23))).jobs.filter(x=>x.kind==='deep'&&x.status==='queued').length,1);
  await db.query('UPDATE public.workspace_lead_records SET score=$1 WHERE project_id=$2',[{total:99,priority:'high'},uuid(22)]);
  assert.equal((await store.schedule()).deep,1);
  assert.equal((await store.detail(uuid(23))).jobs.find(x=>x.kind==='deep').status,'cancelled');
  j=await store.claim('deep'); assert.equal(j.kind,'deep'); assert.equal(j.project_id,uuid(22));
  await store.complete(j.id,j.worker_id,research('deep',99));
  assert.equal((await store.schedule()).deep,0); assert.equal(await store.claim('capped'),null);
});

test('lead status follows recovery and controls without hiding other pending work',async t=>{
  const db=await createDatabase(); t.after(()=>db.close()); const store=createSqlStore(db);
  await store.saveSettings({maxAttempts:1,autoDeep:false}); await insertProject(db,24);
  const quick=(await store.detail(uuid(24))).jobs[0];
  await store.controlJob(quick.id,'pause'); assert.equal((await store.detail(uuid(24))).lead.status,'paused');
  const deep=await store.enqueue(uuid(24),'deep'); assert.equal((await store.detail(uuid(24))).lead.status,'queued');
  await store.controlJob(deep.id,'cancel'); assert.equal((await store.detail(uuid(24))).lead.status,'paused');
  await store.controlJob(quick.id,'resume'); assert.equal((await store.detail(uuid(24))).lead.status,'queued');
  let j=await store.claim('expired'); assert.equal((await store.detail(uuid(24))).lead.status,'researching');
  await db.query("UPDATE public.workspace_lead_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[j.id]);
  assert.equal(await store.claim('recover'),null);
  assert.equal((await store.detail(uuid(24))).lead.status,'error');
  assert.equal((await store.overview()).leads.find(x=>x.project_id===uuid(24)).status,'error');
  await store.controlJob(quick.id,'retry'); j=await store.claim('retry');
  await store.enqueue(uuid(24),'deep'); assert.equal((await store.detail(uuid(24))).lead.status,'researching');
  await store.complete(j.id,j.worker_id,research()); assert.equal((await store.detail(uuid(24))).lead.status,'queued');
  j=await store.claim('cancel'); await store.controlJob(j.id,'cancel');
  assert.equal((await store.detail(uuid(24))).lead.status,'cancelled');
  await store.savePolicy(uuid(24),{excluded:true}); assert.equal((await store.detail(uuid(24))).lead.status,'excluded');
  await store.savePolicy(uuid(24),{excluded:false}); assert.equal((await store.detail(uuid(24))).lead.status,'completed');
});

test('privacy retention runs while paused and only drops expired research page content',async t=>{
  const db=await createDatabase(); t.after(()=>db.close()); const store=createSqlStore(db);
  await store.saveSettings({autoQuick:false,paused:true,retentionDays:7}); await insertProject(db,31);
  const old={...research(),checkedAt:new Date(Date.now()-90*86400000).toISOString()};
  await db.query('UPDATE public.workspace_lead_records SET quick=$1,deep=$2 WHERE project_id=$3',[old,research('deep'),uuid(31)]);
  await store.addReply(uuid(31),{classification:'interest',text:'fixture private text'});
  await db.exec("UPDATE public.workspace_lead_replies SET created_at=now()-interval '90 days'; UPDATE public.workspace_lead_events SET created_at=now()-interval '90 days'");
  assert.equal((await store.schedule()).ran,false);
  const result=await store.detail(uuid(31)); assert.ok(!('pages' in result.lead.quick)); assert.ok(result.lead.deep.pages.length); assert.equal(result.replies.length,0); assert.equal(result.events.length,0);
});

test('ChatGPT plan uses persistent request quota with actual tokens and no USD charges',async t=>{
  const db=await createDatabase(); t.after(()=>db.close()); const store=createSqlStore(db);
  await store.withActor(ownerId).saveSettings({autoQuick:false,aiProvider:'chatgpt_plan',dailyPlanRequests:2,aiEnabled:true,dailyBudgetUsd:0,companyBudgetUsd:0});
  await assert.rejects(store.withActor(managerId).saveSettings({dailyPlanRequests:50}),{code:'scope_mismatch'});
  for(const n of [51,52])await insertProject(db,n);
  const request={requestId:'plan-one',projectId:uuid(51),provider:'chatgpt_plan',kind:'plan',costNanos:0,inputTokens:100,outputTokens:20,model:'gpt-5.4'};
  const reservation=await store.reserveUsage(request);
  assert.equal(reservation.provider,'chatgpt_plan'); assert.equal(reservation.kind,'plan'); assert.equal(reservation.duplicate,false); assert.equal(reservation.reserved_nanos,0);
  assert.equal((await store.reserveUsage(request)).duplicate,true);
  await assert.rejects(store.reserveUsage({...request,provider:'openrouter',kind:'api'}),{code:'idempotency_conflict'});
  await assert.rejects(store.reserveUsage({...request,requestId:'wrong-provider',provider:'openrouter',kind:'api'}),{code:'ai_provider_mismatch'});
  await assert.rejects(store.reserveUsage({...request,requestId:'wrong-kind',kind:'api'}),{code:'invalid_usage'});
  await assert.rejects(store.reserveUsage({...request,requestId:'fabricated-cost',costNanos:1}),{code:'invalid_usage'});
  await assert.rejects(store.settleUsage(request.requestId,{state:'settled',costNanos:1,inputTokens:60,outputTokens:10}),{code:'invalid_usage'});
  await store.settleUsage(request.requestId,{state:'settled',costNanos:0,inputTokens:60,outputTokens:10});
  const race=await Promise.allSettled([
    store.reserveUsage({...request,requestId:'plan-two',projectId:uuid(52)}),
    store.reserveUsage({...request,requestId:'plan-three',projectId:uuid(52)})
  ]);
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(race.find(x=>x.status==='rejected').reason.code,'plan_quota_exceeded');
  const held=race.find(x=>x.status==='fulfilled').value;
  await store.settleUsage(held.request_id,{state:'uncertain'});
  await assert.rejects(store.settleUsage(held.request_id,{state:'released'}),{code:'invalid_transition'});
  await assert.rejects(store.reserveUsage({...request,requestId:'quota-held'}),{code:'plan_quota_exceeded'});
  let report=await store.overview();
  assert.equal(report.usage.planRequests,2); assert.equal(report.usage.planCompletedRequests,1); assert.equal(report.usage.planUncertainRequests,1);
  assert.equal(report.usage.planInputTokens,60); assert.equal(report.usage.planOutputTokens,10);
  assert.equal(report.usage.apiRequests,0); assert.equal(report.usage.costNanos,0); assert.equal(report.usage.reservedNanos,0); assert.equal(report.usage.companyCount,0); assert.deepEqual(report.usage.companies,[]);
  const beforePause=await store.getSettings();
  await assert.rejects(store.withActor(ownerId).suspendAI(),{code:'scope_mismatch'});
  const paused=await store.suspendAI();
  assert.deepEqual(paused,{...beforePause,aiEnabled:false});
  assert.deepEqual(await store.suspendAI(),paused);
  assert.equal((await store.overview()).events.filter(event=>event.kind==='ai_suspended').length,1);
  await assert.rejects(store.reserveUsage({...request,requestId:'provider-paused'}),{code:'ai_disabled'});
  await store.saveSettings({aiEnabled:true});
  await store.saveSettings({dailyPlanRequests:3});
  await assert.rejects(store.reserveUsage({...request,requestId:'server-cap',dailyPlanCap:2}),{code:'plan_quota_exceeded'});
  await assert.rejects(store.reserveUsage({...request,requestId:'server-zero',dailyPlanCap:0}),{code:'plan_quota_exceeded'});
  await assert.rejects(store.reserveUsage({...request,requestId:'server-fraction',dailyPlanCap:2.5}),{code:'invalid_usage'});
  await store.reserveUsage({...request,requestId:'released-slot'});
  await store.settleUsage('released-slot',{state:'released'});
  await assert.rejects(store.reserveUsage({...request,requestId:'not-refunded'}),{code:'plan_quota_exceeded'});
  await store.purge(uuid(52));
  assert.equal((await store.overview()).usage.planRequests,3);
  // A new local spending date gets its own quota; yesterday's uncertainty stays.
  await db.exec("UPDATE public.workspace_lead_usage SET usage_date=usage_date-1 WHERE provider='chatgpt_plan'");
  await store.reserveUsage({...request,requestId:'next-day'});
  assert.equal((await store.overview()).usage.planRequests,1);
  await assert.rejects(store.saveSettings({aiProvider:'openrouter'}),{code:'invalid_settings'});
  await store.saveSettings({aiProvider:'openrouter',dailyBudgetUsd:0.01,companyBudgetUsd:0.01});
  const apiSettings=await store.getSettings();
  assert.deepEqual(await store.suspendAI(),apiSettings);
  await assert.rejects(store.reserveUsage({...request,requestId:'plan-disabled'}),{code:'ai_provider_mismatch'});
  const api={requestId:'paid-api',projectId:uuid(51),provider:'openrouter',kind:'api',costNanos:9000000,inputTokens:100,outputTokens:20,model:'openai/gpt-4.1-mini'};
  await store.reserveUsage(api);
  await assert.rejects(store.reserveUsage({...api,requestId:'paid-cap',costNanos:2000000}),{code:'budget_exceeded'});
  await store.settleUsage(api.requestId,{state:'settled',costNanos:5000000,inputTokens:80,outputTokens:8});
  report=await store.overview();
  assert.equal(report.usage.apiRequests,1); assert.equal(report.usage.costNanos,5000000); assert.equal(report.usage.planRequests,1);
  assert.equal(report.usage.companies.length,1); assert.equal(report.usage.companies[0].costNanos,5000000);
});

test('reservations and fenced leases survive a physical database restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lead-store-test-')); let db;
  try {
    db=await createDatabase(directory); let store=createSqlStore(db);
    await store.saveSettings({autoDeep:false,aiEnabled:true,dailyBudgetUsd:0.1,companyBudgetUsd:0.1}); await insertProject(db,41);
    const j=await store.claim('persisted-worker');
    const request={requestId:'persistent-charge',projectId:uuid(41),jobId:j.id,workerId:j.worker_id,costNanos:60000000,inputTokens:100,outputTokens:10,model:'openai/gpt-4.1-mini'};
    await assert.rejects(store.reserveUsage({...request,workerId:'wrong-fence'}),{code:'stale_lease'});
    await store.reserveUsage(request); await db.close(); db=null;
    db=new PGlite(directory); store=createSqlStore(db);
    const duplicate=await store.reserveUsage(request); assert.equal(duplicate.state,'reserved'); assert.equal(duplicate.duplicate,true);
    assert.equal((await store.overview()).usage.reservedNanos,60000000);
    await db.query("UPDATE public.workspace_lead_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[j.id]);
    await store.claim('restarted-worker');
    await db.query("UPDATE public.workspace_lead_jobs SET next_run_at=now()-interval '1 second' WHERE id=$1",[j.id]);
    const recovered=await store.claim('restarted-worker'); assert.equal(recovered.id,j.id); assert.notEqual(recovered.worker_id,j.worker_id);
    await assert.rejects(store.complete(j.id,j.worker_id,research()),{code:'stale_lease'});
    await store.settleUsage(request.requestId,{state:'settled',costNanos:110000000,inputTokens:100,outputTokens:10});
    assert.equal((await store.overview()).usage.costNanos,110000000);
    await assert.rejects(store.reserveUsage({...request,requestId:'cap-after-overquote',workerId:recovered.worker_id,costNanos:1}),{code:'budget_exceeded'});
    await store.saveSettings({aiProvider:'chatgpt_plan',dailyPlanRequests:1});
    const plan={...request,requestId:'persistent-plan',workerId:recovered.worker_id,provider:'chatgpt_plan',kind:'plan',costNanos:0};
    await store.reserveUsage(plan); await store.settleUsage(plan.requestId,{state:'uncertain'});
    await db.close(); db=null; db=new PGlite(directory); store=createSqlStore(db);
    assert.equal((await store.reserveUsage(plan)).duplicate,true);
    assert.equal((await store.overview()).usage.planUncertainRequests,1);
    await assert.rejects(store.reserveUsage({...plan,requestId:'plan-after-restart'}),{code:'plan_quota_exceeded'});
    const beforeSuspend=await store.getSettings(); await store.suspendAI();
    await db.close(); db=null; db=new PGlite(directory); store=createSqlStore(db);
    assert.deepEqual(await store.getSettings(),{...beforeSuspend,aiEnabled:false});
    await assert.rejects(store.reserveUsage({...plan,requestId:'disabled-after-restart'}),{code:'ai_disabled'});
  } finally {
    if(db)await db.close();
    const safe=resolve(directory);
    if(dirname(safe)===resolve(tmpdir())&&basename(safe).startsWith('lead-store-test-'))await rm(safe,{recursive:true,force:true});
  }
});
