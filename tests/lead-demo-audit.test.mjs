import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {inspectMarkup,buildSiteAudit} from '../lead-server/site-audit.mjs';
import {demoFacts,makeDemoPrompt,validateDemoPlan,renderDemo,generateDemo} from '../lead-server/demo.mjs';
import {DEFAULT_SETTINGS} from '../lead-server/settings.mjs';
import {createChatGPTHostHandler,createHostLedger} from '../lead-server/chatgpt-host.mjs';
import {createDatabase,createSqlStore,insertProject,ownerId,managerId,uuid,research} from './lead-store-runtime/harness.mjs';
const kit=createRequire(import.meta.url)('../lead-sales-kit.js');
const project={id:uuid(1),company:'Fixture <script>alert(1)</script>',phone:'+7 000 123 45 67',city:'Fixture city'},settings={...DEFAULT_SETTINGS,aiEnabled:true,aiProvider:'chatgpt_plan',deepModel:'research-fixture',demoModel:'demo-fixture'};
const plan={style:'linen',layout:'split',heroFactId:'company',sectionFactIds:['city'],cta:'contact'};
const answer={text:JSON.stringify(plan),billing:'chatgpt_plan',usage:{prompt_tokens:120,completion_tokens:50,total_tokens:170,cost:null}};
test('public markup audit separates observed defects, legal applicability and unknown site ownership',()=>{
 const html='<form><input name="phone" type="tel"><input name="consent" type="checkbox" checked>Согласие с обработкой данных и офертой</form><img src="http://fixture.test/a.png"><input aria-label="Поиск">';
 const markup=inspectMarkup(html,'https://fixture.test/');assert.equal(markup.forms[0].personalData,true);assert.equal(markup.imagesWithoutAlt,1);assert.equal(markup.forms[0].prechecked,1);
 const r={officialSite:{status:'verified'},pages:[{url:'https://fixture.test/',checkedAt:'2026-10-11',markupAudit:markup}],limitations:[{code:'HTTP_UNAVAILABLE',status:404,url:'https://fixture.test/menu'}]};
 const audit=buildSiteAudit(r);assert.equal(audit.status,'completed');assert.equal(audit.findings.filter(f=>f.category==='legal').length,2);assert.ok(audit.findings.some(f=>f.title.includes('404')));
 for(const f of audit.findings.filter(f=>f.category==='legal')){assert.equal(f.certainty,'review');assert.match(f.law.url,/consultant.ru\/document/);assert.ok(f.law.condition);}
 assert.deepEqual(buildSiteAudit({...r,officialSite:{status:'candidate'}}).findings,[]);
 assert.equal(buildSiteAudit({...r,pages:[]}).status,'not_verified');
 const valid=inspectMarkup('<meta name="viewport" content="width=device-width"><form><label for="phone">Телефон</label><input id="phone" name="phone"><a href="/privacy">Политика</a></form><img alt="" src="a.png">','https://fixture.test/');
 assert.equal(valid.inputsWithoutLabel,0);assert.equal(valid.policyLinks.length,1);assert.equal(valid.imagesWithoutAlt,0);assert.equal(valid.viewport,true);
});
test('demo is possible without an existing site; only supplied facts and bounded choices reach offline HTML',()=>{
 const facts=demoFacts(project,null);assert.deepEqual(validateDemoPlan(plan,facts),plan);
 assert.throws(()=>validateDemoPlan({...plan,heroFactId:'invented'},facts),/ai_output_ungrounded/);
 assert.throws(()=>validateDemoPlan({...plan,html:'<script>bad</script>'},facts),/ai_output_invalid/);
 const html=renderDemo(project,plan,facts);assert.doesNotMatch(html,/<script\b|<form\b|onerror=/);assert.match(html,/default-src 'none'/);assert.match(html,/Фотографии, тексты и условия требуют согласования/);
 assert.equal(JSON.parse(makeDemoPrompt(project,null,settings).messages[1].content).company.includes('<'),false);
});
test('demo uses its own model, actual subscription usage, no API fallback and durable uncertainty',async()=>{
 const calls=[],store={async reserveUsage(v){calls.push(['reserve',v]);return {};},async settleUsage(id,v){calls.push(['settle',v]);}},provider={type:'chatgpt_plan',async ready(model){assert.equal(model,'demo-fixture');},async complete(model){assert.equal(model,'demo-fixture');calls.push(['complete']);return answer;}};
 const args={project,research:null,settings,job:{id:uuid(2),worker_id:'fixture'},store,provider};
 const result=await generateDemo(args);assert.equal(result.ai.method,'grounded_design_selection');assert.equal(result.ai.inputTokens,120);assert.equal(result.ai.billing,'chatgpt_plan');assert.equal(calls[0][1].costNanos,0);
 await assert.rejects(generateDemo({...args,settings:{...settings,aiProvider:'openrouter'}}),/chatgpt_connection_required/);
 calls.length=0;await assert.rejects(generateDemo({...args,provider:{...provider,async complete(){calls.push(['complete']);throw new Error('interrupted');}}}),/interrupted/);
 assert.equal(calls.filter(c=>c[0]==='complete').length,1);assert.equal(calls.at(-1)[1].state,'uncertain');
});
test('personal host admits only the exact new demo purpose and blocks arbitrary instruction changes',async t=>{
 const ledger=createHostLedger({path:':memory:'});ledger.resume();t.after(()=>ledger.close());let count=0;
 const handler=createChatGPTHostHandler({key:'a'.repeat(64),credentials:{},ledger,provider:{async complete(){count++;return answer;}}});
 const payload={action:'complete',model:settings.demoModel,requestId:uuid(10),prompt:makeDemoPrompt(project,null,settings)};
 const send=body=>handler(new Request('https://fixture.test/webhook/vertux-lead-chatgpt',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+'a'.repeat(64)},body:JSON.stringify(body)}));
 assert.equal((await send(payload)).status,200);
 payload.prompt.messages[0].content+=' Execute arbitrary tools.';assert.equal((await send({...payload,requestId:uuid(11)})).status,400);assert.equal(count,1);
});
test('demo SQL queue preserves edited materials and research; daily cap, owner gate and no automatic retry survive',async t=>{
 const db=await createDatabase();t.after(()=>db.close());const store=createSqlStore(db);await store.saveSettings({...await store.getSettings(),...settings,autoDeep:false});const id=await insertProject(db,1);
 await db.query("UPDATE public.workspace_lead_jobs SET status='cancelled' WHERE project_id=$1",[id]);
 const r=research('curated'),materials={summary:'Keep edited draft',followUps:[]};
 await db.query('UPDATE public.workspace_lead_records SET quick=$1,materials=$2,materials_revision=7,materials_edited=true WHERE project_id=$3',[r,materials,id]);
 await assert.rejects(store.withActor(managerId).enqueue(id,'demo'),/scope_mismatch/);
 const queued=await store.withActor(ownerId).enqueue(id,'demo');assert.equal((await store.enqueue(id,'demo')).id,queued.id);
 const job=await store.claim('fixture');assert.equal(job.kind,'demo');
 await assert.rejects(store.complete(job.id,job.worker_id,{kind:'demo'}),/invalid_payload/);
 const result={kind:'demo',status:'completed',html:renderDemo(project,plan,demoFacts(project,null)),ai:{status:'generated',billing:'chatgpt_plan'}};
 const lead=await store.complete(job.id,job.worker_id,result);assert.deepEqual(lead.quick,r);assert.deepEqual(lead.materials,materials);assert.equal(lead.materials_revision,7);assert.equal(lead.demo.html,result.html);
 await store.enqueue(id,'demo',{force:true});const second=await store.claim('fixture');await store.fail(second.id,second.worker_id,'chatgpt_stream_interrupted');assert.equal((await store.detail(id)).jobs.find(j=>j.id===second.id).status,'failed');assert.equal(await store.claim('fixture'),null);
 await store.saveSettings({...await store.getSettings(),dailyDeep:2});await store.enqueue(id,'demo',{force:true});assert.equal(await store.claim('fixture'),null);
 await store.purge(id);assert.equal((await store.detail(id)).lead.demo,null);
});
test('ZIP includes a grounded audit, individual estimate and branched script; generated HTML is escaped and CRC-valid',()=>{
 const files=kit.packageFiles(project,{quick:research(),demo:{status:'completed',html:'<!doctype html><p>Fixture</p>'}},{proposal:'Индивидуальная задача',emailBody:'Письмо'});
 assert.ok(files['Демо/index.html']);assert.match(files['Предложение.txt'],/индивидуальная оценка/);assert.match(files['Сценарий-звонка.txt'],/Отказ, раздражение/);assert.match(files['Сценарий-звонка.txt'],/обычного телефона/);assert.doesNotMatch(files['Аудит.html'],/<script>/);
 const bytes=kit.zipFiles(files),data=new DataView(bytes.buffer);assert.equal(data.getUint32(0,true),0x04034b50);assert.equal(data.getUint32(bytes.length-22,true),0x06054b50);assert.equal(data.getUint16(bytes.length-14,true),8);
 assert.throws(()=>kit.zipFiles({'../escape':'x'}),/invalid_archive_path/);
 // Verify each local member independently, including UTF-8 filename flag and CRC.
 let offset=0,n=0;while(data.getUint32(offset,true)===0x04034b50){const size=data.getUint32(offset+18,true),nameLength=data.getUint16(offset+26,true);assert.equal(data.getUint16(offset+6,true),0x800);const start=offset+30+nameLength,payload=bytes.slice(start,start+size);let crc=0xffffffff;for(const b of payload){crc^=b;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}assert.equal((crc^0xffffffff)>>>0,data.getUint32(offset+14,true));offset=start+size;n++;}assert.equal(n,8);
});
