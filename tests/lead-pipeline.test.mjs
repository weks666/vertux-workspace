import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createDatabase,createSqlStore,insertProject,organizationId,productId,ownerId} from './lead-store-runtime/harness.mjs';
import {createLeadHandler} from '../lead-server/handler.mjs';
import {createLeadWorker} from '../lead-server/worker.mjs';
import {createResearcher} from '../lead-server/research.mjs';

// SQL, API, crawler, scoring, worker and materials are real implementation.
// Identity, public website responses and paid provider are synthetic adapters.
test('import -> quick -> manual deep -> grounded draft -> edit -> reply -> opt-out -> purge with real Postgres and HTTP',async()=>{
  const db=await createDatabase(),store=createSqlStore(db),origin='https://workspace.example.com';
  const user={id:ownerId,app_metadata:{nexus_managed:true,nexus_access:'active',nexus_organization_id:organizationId,nexus_product_id:productId,role:'owner'}};
  const handle=createLeadHandler({config:{enabled:true,organizationId,productId,usageSalt:'isolated-test-private-salt-'.repeat(3),origins:[origin],models:['openai/gpt-4.1-mini'],aiAvailable:true,maxDailyBudgetUsd:5,maxCompanyBudgetUsd:1},store,authenticate:async()=>user});
  const server=createServer(async(req,res)=>{
    const response=await handle(new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,body:req,duplex:'half'}));
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}/webhook/vertux-lead-intelligence`;
  async function action(body){const res=await fetch(endpoint,{method:'POST',headers:{Origin:origin,Authorization:'Bearer isolated-session-not-real','Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();return {status:res.status,...data};}
  const requested=[];
  const website=async url=>{
    const parsed=new URL(url);assert.equal(parsed.hostname,'lead-fixture.example.com');requested.push(parsed.pathname);
    const html=parsed.pathname==='/robots.txt'?'User-agent: *\nAllow: /\n':parsed.pathname==='/rooms'?'<html><title>Тестовый отель Северная Долина — номера</title><body>Тестовый отель Северная Долина, Москва. Номера и проживание, семейный отдых с детьми. Бронирование по телефону +7 (000) 000-00-01. <a href="/contact">Контакты</a></body></html>':parsed.pathname==='/contact'?'<html><title>Контакты — Северная Долина</title><body>Тестовый отель Северная Долина. Москва. Работаем ежедневно. Телефон +7 (000) 000-00-01, email info@example.com. <form>Обратная связь</form></body></html>':'<html><title>Тестовый отель Северная Долина</title><body>Москва. Тестовый отель Северная Долина предлагает проживание и завтраки. Номера для семьи с детьми. Забронировать можно по телефону +7 (000) 000-00-01. <a href="/rooms">Номера и бронирование</a><a href="/contact">Контакты</a></body></html>';
    return {url,status:200,text:html,headers:{'content-type':parsed.pathname==='/robots.txt'?'text/plain':'text/html'},bytes:Buffer.byteLength(html),durationMs:1};
  };
  let paidCalls=0;
  const provider={async ready(){},quote(){return 1000000;},async complete(model,prompt){paidCalls++;const input=JSON.parse(prompt.messages[1].content);return {text:JSON.stringify({serviceId:input.services[0],evidenceIds:[input.facts[0].id],approach:'discovery',questionIds:['current_process','next_step'],objectionIds:['budget']}),usage:{prompt_tokens:400,completion_tokens:80,total_tokens:480,cost:0.0001}};}};
  const worker=createLeadWorker({store,provider,researchCompany:createResearcher({fetcher:website,renderer:null,env:{}})});
  try{
    assert.equal((await action({action:'settings',settings:{autoDeep:false,dailyBudgetUsd:1,companyBudgetUsd:0.1,aiEnabled:true}})).status,200);
    const projectId=await insertProject(db,501,{company:'Тестовый отель Северная Долина',city:'Москва',site:'https://lead-fixture.example.com'});
    let detail=await action({action:'detail',projectId});assert.equal(detail.jobs.filter(j=>j.kind==='quick').length,1,'server import trigger creates job without browser hook');
    await worker.tick();await worker.drain();
    detail=await action({action:'detail',projectId});assert.ok(detail.lead.quick,'quick result persisted');assert.equal(detail.lead.quick.officialSite.status,'verified');assert.equal(paidCalls,0);assert.ok(detail.lead.score.components.length);assert.match(detail.lead.materials.proposal,/гипотеза/);
    const quickPages=detail.lead.quick.pages.length;
    const enqueued=await action({action:'enqueue',projectId,kind:'deep'});assert.equal(enqueued.status,200);
    const duplicate=await action({action:'enqueue',projectId,kind:'deep'});assert.equal(duplicate.job.id,enqueued.job.id);
    await worker.tick();await worker.drain();
    detail=await action({action:'detail',projectId});assert.equal(detail.lead.deep.ai.status,'generated');assert.equal(paidCalls,1);assert.ok(detail.lead.deep.pages.length>=quickPages);assert.match(detail.lead.materials.summary,/lead-fixture.example.com/);
    const overview=await action({action:'overview'});assert.equal(overview.analytics.processedQuick,1);assert.equal(overview.analytics.processedDeep,1);assert.equal(overview.usage.costNanos,100000);assert.equal(overview.usage.reservedNanos,0);
    const revision=detail.lead.materials_revision,materials={...detail.lead.materials,emailBody:'Ручной вариант менеджера'};
    assert.equal((await action({action:'materials',projectId,revision,materials})).status,200);
    assert.equal((await action({action:'materials',projectId,revision,materials})).status,409,'stale write never overwrites newer edit');
    assert.equal((await action({action:'reply',projectId,text:'Спасибо, но не пишите нам больше.'})).reply.classification,'refusal');
    detail=await action({action:'detail',projectId});assert.equal(detail.lead.opted_out,true);assert.equal(detail.replies.length,1);
    assert.equal((await action({action:'enqueue',projectId,kind:'deep',force:true})).ok,false);
    assert.equal((await action({action:'purge',projectId})).status,200);
    detail=await action({action:'detail',projectId});assert.equal(detail.lead.quick,null);assert.equal(detail.lead.materials,null);assert.equal(detail.replies.length,0);assert.equal((await db.query('SELECT count(*) AS n FROM public.projects WHERE id=$1',[projectId])).rows[0].n,1);
    assert.equal((await action({action:'overview'})).usage.costNanos,100000,'privacy purge cannot erase real cost');
    assert.ok(requested.includes('/robots.txt'));
  }finally{await worker.stop();await new Promise(resolve=>server.close(resolve));await db.close();}
});
