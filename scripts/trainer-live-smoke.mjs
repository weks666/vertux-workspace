// Operator-only: execute on the Nexus host, never in a browser or ordinary tests.
// It uses scoped, temporary Auth sessions and synthetic dialog text only.
// --allow-paid explicitly permits four completions within the persistent server cap.
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
const paid=process.argv.includes('--allow-paid');
const readEnv=path=>Object.fromEntries(fs.readFileSync(path,'utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).replace(/^['"]|['"]$/g,'')];}));
const nexus=readEnv('/etc/vertux-nexus/nexus.env'),trainer=readEnv('/etc/vertux-workspace-trainer/operator.env');
const base=nexus.NEXUS_VERTUX_WORKSPACE_SUPABASE_URL.replace(/\/$/,''),adminKey=nexus.NEXUS_VERTUX_WORKSPACE_SUPABASE_SERVICE_ROLE;
const endpoint='https://nexus.vertux.online/api/workspace-trainer',origin='https://weks666.github.io';
async function auth(path,body,token=adminKey){
  const r=await fetch(base+'/auth/v1'+path,{method:body?'POST':'GET',headers:{apikey:trainer.TRAINER_SUPABASE_ANON_KEY,Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('Auth '+path.split('?')[0]+' HTTP '+r.status);
  return r.status===204?{}:r.json();
}
async function session(user){
  const link=await auth('/admin/generate_link',{type:'magiclink',email:user.email});
  const props=link.properties||link;
  const verified=await auth('/verify',{type:props.verification_type||'magiclink',token_hash:props.hashed_token},trainer.TRAINER_SUPABASE_ANON_KEY);
  if(!verified.access_token)throw Error('Temporary session not returned');return verified.access_token;
}
async function call(token,body,override={}){
  const start=Date.now();
  const r=await fetch(endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+token,...override},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  return {status:r.status,data:await r.json(),ms:Date.now()-start};
}
const tokens=[];
try{
  const found=await auth('/admin/users?per_page=50');
  const scoped=(found.users||[]).filter(u=>u.app_metadata?.nexus_product_id===trainer.TRAINER_PRODUCT_ID&&u.app_metadata?.nexus_organization_id===trainer.TRAINER_ORGANIZATION_ID&&u.app_metadata?.nexus_access==='active');
  const owner=scoped.find(u=>u.app_metadata.role==='owner'),manager=scoped.find(u=>u.app_metadata.role==='manager');
  if(!owner||!manager)throw Error('Expected scoped roles unavailable');
  const ownerToken=await session(owner);tokens.push(ownerToken);
  const managerToken=await session(manager);tokens.push(managerToken);
  const health=await call(ownerToken,{mode:'health'});
  if(health.status!==200||!health.data.ready)throw Error('Owner health failed: '+health.status+' '+health.data.error);
  const managerHealth=await call(managerToken,{mode:'health'});
  if(managerHealth.status!==200)throw Error('Manager health failed');
  if((await call(ownerToken,{mode:'health'},{Origin:'https://foreign.example.invalid'})).status!==403)throw Error('Foreign origin accepted');
  const results=[];let replayStatus=null,finance=null;
  if(process.argv.includes('--finance')){
    const counts={};
    for(const [role,token] of [['owner',ownerToken],['manager',managerToken]]){
      const r=await fetch(base+'/rest/v1/projects?select=id,raw_money:raw->money,finance:workspace_project_finance(project_id)&limit=500',{headers:{apikey:trainer.TRAINER_SUPABASE_ANON_KEY,Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw Error('Finance join '+role+' HTTP '+r.status);
      const rows=await r.json();
      if(!Array.isArray(rows)||rows.some(p=>p.raw_money!==null))throw Error('Legacy raw finance is still exposed');
      counts[role]={projects:rows.length,visibleFinance:rows.filter(p=>p.finance!==null).length};
      if(role==='manager'&&counts[role].visibleFinance!==0)throw Error('Manager can read finance through project join');
      const direct=await fetch(base+'/rest/v1/workspace_project_finance?select=project_id&limit=500',{headers:{apikey:trainer.TRAINER_SUPABASE_ANON_KEY,Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
      if(!direct.ok)throw Error('Direct finance read '+role+' HTTP '+direct.status);
      const visible=await direct.json();
      if(role==='manager'&&visible.length!==0)throw Error('Manager can read finance directly');
      counts[role].directFinance=visible.length;
    }
    if(counts.owner.projects!==counts.manager.projects||counts.owner.projects<1)throw Error('Role project visibility mismatch');
    finance={status:'LIVE_REST_READ_VERIFIED',...counts,productionWrites:0};
  }
  if(paid){
    const transcript='Менеджер: Здравствуйте, удобно задать один вопрос про заявки на корпоративы? Клиент: У нас уже есть сайт. Менеджер: Понял. Можно ли на нём сразу уточнить дату и количество гостей? Клиент: Сейчас это обсуждаем по телефону. Менеджер: Могу показать короткий пример формы, чтобы проверить, пригодится ли она вам.';
    const history=[{who:'m',text:'Здравствуйте, удобно коротко уточнить, как вы принимаете заявки на корпоративы?'},{who:'c',text:'У нас уже есть сайт, что вы предлагаете?'},{who:'m',text:'Я предлагаю сначала посмотреть, удобно ли гостю оставить дату и число участников. Если это уже работает, переделка не нужна.'}];
    let last;
    for(const mode of ['suffler','review','roleplay','debrief']){
      last={mode,requestId:randomUUID(),niche:'Вымышленная банкетная площадка для проверки',city:'Тестовый город',transcript,history};
      const r=await call(ownerToken,last);
      if(r.status!==200||!r.data.text)throw Error(mode+' failed: '+r.status+' '+r.data.error);
      results.push({mode,status:r.status,latencyMs:r.ms,answerChars:r.data.text.length,answerSha256:createHash('sha256').update(r.data.text).digest('hex'),sample:r.data.text.slice(0,160),budget:r.data.budget});
    }
    replayStatus=(await call(ownerToken,last)).status;
    if(replayStatus!==409)throw Error('Replay was not rejected');
  }
  console.log(JSON.stringify({status:paid?'LIVE_AI_VERIFIED':'LIVE_HEALTH_VERIFIED',checkedAt:new Date().toISOString(),model:trainer.TRAINER_MODEL,origin,ownerHealth:200,managerHealth:200,foreignOrigin:403,replayStatus,paidRequests:results.length,budgetBefore:health.data.budget,budgetAfter:results.at(-1)?.budget||health.data.budget,results,finance,realLeadTranscriptsSent:0}));
}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
finally{
  for(const token of tokens){
    try{await fetch(base+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:trainer.TRAINER_SUPABASE_ANON_KEY,Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});}catch{}
  }
}
