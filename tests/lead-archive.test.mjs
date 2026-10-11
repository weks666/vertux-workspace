import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDatabase,createSqlStore,insertProject,uuid,managerId,viewerId,foreignId,research} from './lead-store-runtime/harness.mjs';

test('archiving preserves CRM and materials, fences work, and restores prior exclusion',async t=>{
 const db=await createDatabase();t.after(()=>db.close());const store=createSqlStore(db);
 const id=await insertProject(db,1);const raw={calls:[{at:'2026-10-01T12:00:00Z',out:'later'}],next_call:'2026-10-12T12:00:00Z'};
 await db.query('UPDATE public.projects SET raw=$1,lead_batch_id=$2,lead_batch_name=$3 WHERE id=$4',[raw,'old-run','Old run',id]);
 const job=await store.claim('fixture');assert.equal(job.project_id,id);
 await db.query('UPDATE public.workspace_lead_records SET materials=$1 WHERE project_id=$2',[{summary:'Retain this'},id]);
 await db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE authenticated');await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[managerId]);await tx.query('UPDATE public.projects SET archived_at=now() WHERE id=$1',[id]);});
 let detail=await store.detail(id);assert.equal(detail.lead.excluded,true);assert.equal(detail.jobs[0].status,'cancelled');assert.equal(detail.lead.materials.summary,'Retain this');
 assert.deepEqual((await db.query('SELECT raw FROM public.projects WHERE id=$1',[id])).rows[0].raw,raw);
 await assert.rejects(store.complete(job.id,job.worker_id,research()),{code:'stale_lease'});
 await assert.rejects(store.enqueue(id,'deep'),{code:'excluded'});
 await store.savePolicy(id,{excluded:false,optedOut:false});assert.equal((await store.detail(id)).lead.excluded,true);
 assert.equal(await store.claim('fixture'),null);
 await db.query('UPDATE public.projects SET archived_at=NULL WHERE id=$1',[id]);
 detail=await store.detail(id);assert.equal(detail.lead.excluded,false);assert.equal(detail.lead.archived_previous_excluded,null);
 assert.equal(detail.events.filter(e=>['company_archived','company_restored'].includes(e.kind||e.event)).length,2);
 await store.savePolicy(id,{excluded:true,optedOut:true});
 await db.query('UPDATE public.projects SET archived_at=now() WHERE id=$1',[id]);await db.query('UPDATE public.projects SET archived_at=NULL WHERE id=$1',[id]);
 detail=await store.detail(id);assert.equal(detail.lead.excluded,true);assert.equal(detail.lead.opted_out,true);
});

test('archive uses existing project RLS and rollback retains project content',async t=>{
 const db=await createDatabase();t.after(()=>db.close());const id=await insertProject(db,2);
 for(const actor of [viewerId,foreignId])await db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE authenticated');await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor]);assert.equal((await tx.query('UPDATE public.projects SET archived_at=now() WHERE id=$1 RETURNING id',[id])).rows.length,0);});
 await db.query('UPDATE public.projects SET archived_at=now(),lead_batch_id=$1,lead_batch_name=$2 WHERE id=$3',['fixture','Fixture',id]);
 await db.exec(await readFile(new URL('../supabase/rollback/lead-batches-archive.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('SELECT company FROM public.projects WHERE id=$1',[id])).rows[0].company,'Fixture 2');
 assert.equal((await db.query('SELECT excluded FROM public.workspace_lead_records WHERE project_id=$1',[id])).rows[0].excluded,false);
});

test('fresh curated imports avoid automatic duplicate research but allow manual Deep',async t=>{
 const db=await createDatabase();t.after(()=>db.close());const id=await insertProject(db,3);
 await db.query("UPDATE public.workspace_lead_jobs SET status='cancelled' WHERE project_id=$1",[id]);
 await db.query("UPDATE public.workspace_lead_records SET quick=$1,score=$2,expires_at=now()+interval '30 days' WHERE project_id=$3",[{...research(),kind:'curated'},{total:100},id]);
 await db.exec("UPDATE public.workspace_lead_settings SET config=jsonb_set(config,'{scheduleTime}','\"00:00\"')");
 assert.equal((await createSqlStore(db).schedule()).deep,0);
 const enqueue=async(manual)=> (await db.query("SELECT workspace_private.lead_enqueue(organization_id,product_id,project_id,'deep',false,0,$1) result FROM public.workspace_lead_records WHERE project_id=$2",[manual,id])).rows[0].result;
 assert.equal(await enqueue(false),null);assert.equal((await enqueue(true)).manual,true);
 await db.query("UPDATE public.workspace_lead_jobs SET status='cancelled' WHERE project_id=$1",[id]);
 await db.query("UPDATE public.workspace_lead_records SET expires_at=now()-interval '1 day' WHERE project_id=$1",[id]);
 assert.equal((await enqueue(false)).status,'queued');
});
