/* ISOLATED UI FIXTURE. Never loaded by production index.html. No HTTP/provider calls. */
(function(){
  const params=new URLSearchParams(location.search),viewer=params.has('viewer'),manager=params.has('manager');
  const state=window.__fixture,clone=value=>structuredClone(value),now=()=>new Date().toISOString();
  const settings={enabled:true,paused:false,autoQuick:true,autoDeep:true,dailyQuick:500,dailyDeep:50,deepThreshold:60,scheduleTime:'09:00',timezone:'Europe/Moscow',staleDays:30,retentionDays:90,concurrency:2,maxAttempts:3,maxPagesQuick:2,maxPagesDeep:6,requestTimeoutMs:12000,requestsPerHostDelayMs:1000,aiEnabled:false,quickModel:'openai/gpt-4.1-mini',deepModel:'openai/gpt-4.1-mini',dailyBudgetUsd:0,companyBudgetUsd:0,maxInputTokens:12000,maxOutputTokens:1800,industryProfiles:['hotel','restaurant','banquet','general'],scoreWeights:{fit:25,opportunity:30,contacts:20,freshness:10,confidence:15},communication:{mode:'drafts',dailySendLimit:0}};
  const evidence={url:'https://example.invalid/banquet',quote:'Тестовый источник: на странице опубликованы вместимость зала и телефон для бронирования.',checkedAt:now(),confidence:.93};
  function research(projectId,kind){
    const first=projectId==='fixture-1',low=projectId==='fixture-4';
    return {schemaVersion:1,kind,status:'complete',checkedAt:now(),expiresAt:new Date(Date.now()+30*864e5).toISOString(),
      officialSite:{url:'https://example.invalid/'+projectId,status:'verified',confidence:.93,reason:'Вымышленный сайт для изолированной проверки интерфейса.'},
      business:{industry:first?'banquet':'restaurant',description:'Тестовая компания. Данные вымышлены и используются только для локальной проверки интерфейса.',services:['Банкеты','Корпоративы'],audience:'Организаторы корпоративных мероприятий'},
      pages:[{url:evidence.url,title:'Тестовая страница банкета',checkedAt:now(),contentHash:'fixture-only'}],
      signals:[{id:'contact',label:'Опубликован телефон для бронирования',confidence:.93,hypothesis:false,evidence:[clone(evidence)]}],
      opportunities:[{id:'booking',label:'Обсудить сбор пожеланий к мероприятию через форму',serviceId:'booking',confidence:.72,hypothesis:true,evidence:[clone(evidence)]}],
      limitations:['Это изолированные тестовые данные. Реальный сайт не посещался.','Конверсия заявок не измерялась.'],technologies:['HTML'],technical:{httpStatus:200,responseTimeMs:120},
      score:{total:low?20:first?78:50,priority:low?'low':first?'high':'medium',components:[{id:'fit',label:'Соответствие Vertux',value:20,max:25,reason:'В тестовой карточке указаны банкетные услуги.'},{id:'opportunity',label:'Возможности',value:20,max:30,reason:'Гипотеза привязана к опубликованному контакту.'},{id:'contacts',label:'Контакты',value:20,max:20,reason:'Телефон доступен.'},{id:'freshness',label:'Актуальность',value:10,max:10,reason:'Исследование свежее.'},{id:'confidence',label:'Достоверность',value:8,max:15,reason:'Часть вопросов требует обсуждения.'}],reasons:['Есть проверяемый контакт и сценарий для обсуждения.'],services:[{id:'booking',label:'Онлайн-запись',reason:'Можно уточнить, удобно ли собирать пожелания к мероприятию через форму.',evidenceIds:['contact']}]},ai:{status:kind==='deep'?'disabled':'not_requested'},usage:{httpRequests:2,browserPages:0}};
  }
  function materials(){return {summary:'Тестовая банкетная площадка. В источнике указан телефон для бронирования.',proposal:'Предлагаем обсудить форму заявки на банкет: дату, число гостей и пожелания. Нужность решения стоит проверить с менеджером.',callScript:'Здравствуйте! Удобно уточнить, как вы принимаете запросы на банкеты? Какие сведения приходится спрашивать повторно? Если это актуально, покажем вариант формы.',emailSubject:'Вопрос о заявках на банкеты',emailBody:'Здравствуйте! На странице банкета указан телефон. Подскажите, удобно ли вам собирать дату и число гостей через форму? Можем обсудить небольшой вариант для вашего процесса.',icebreaker:'Уточняю, как устроено бронирование банкетов.',followUps:['Здравствуйте! Возвращаюсь к вопросу формы заявки. Если тема неактуальна, больше писать не будем.']};}
  const lead=(id,kind)=>{const r=research(id,kind);return {project_id:id,status:'complete',quick:kind==='quick'?r:null,deep:kind==='deep'?r:null,score:r.score,checked_at:r.checkedAt,expires_at:r.expiresAt,materials:kind==='deep'?materials():{},materials_revision:kind==='deep'?1:0,excluded:false,opted_out:false,contact_permission:null,updated_at:now()};};
  const fixture=state.lead={settings,leads:[lead('fixture-1','deep'),lead('fixture-2','quick'),lead('fixture-4','quick')],jobs:[{id:'job-failed',project_id:'fixture-3',kind:'quick',status:'failed',attempts:1,error_code:'request_timeout',progress:{}},{id:'job-paused',project_id:'fixture-2',kind:'deep',status:'paused',attempts:0,progress:{}},{id:'job-done',project_id:'fixture-1',kind:'deep',status:'completed',attempts:1,progress:{stage:'completed'}}],events:[],replies:[],requests:[],fail:false,conflictOnce:false,pageSize:1,
    capabilities:{canEdit:!viewer,canConfigure:!viewer&&!manager,models:['openai/gpt-4.1-mini'],aiAvailable:false,maxDailyBudgetUsd:0,maxCompanyBudgetUsd:0,delivery:'drafts_only',replyIngestion:'manual'},usage:{day:new Date().toISOString().slice(0,10),timezone:'Europe/Moscow',costNanos:0,reservedNanos:0,inputTokens:0,outputTokens:0,companyCount:0}};
  Object.assign(settings,{aiProvider:params.has('chatgpt')?'chatgpt_plan':'openrouter',dailyPlanRequests:10});
  fixture.capabilities.chatgpt={available:true,connected:false,planUsageEnabled:false,canManage:!viewer&&!manager,models:[],requiresLocalConnection:true,requiresLocalSetup:true,setupInstruction:'Подключение требует первого входа через локальный помощник на твоём компьютере. После входа сервер сможет использовать разрешённые лимиты.',accountLabel:null};
  Object.assign(fixture.usage,{planRequests:0,planCompletedRequests:0,planReservedRequests:0,planUncertainRequests:0,planInputTokens:0,planOutputTokens:0,dailyPlanRequests:10});
  fixture.connectChatgpt=()=>Object.assign(fixture.capabilities.chatgpt,{connected:true,planUsageEnabled:true,requiresLocalSetup:false,accountLabel:'Тестовый аккаунт <script>window.leaked=true</script>',models:[{id:'fixture-account-model',label:'Модель тестового аккаунта'}]});
  if(params.has('chatgpt-active')){settings.aiProvider='chatgpt_plan';settings.aiEnabled=true;settings.deepModel='fixture-account-model';fixture.connectChatgpt();}
  function event(kind,projectId){fixture.events.unshift({id:crypto.randomUUID(),kind,project_id:projectId,created_at:now()});}
  function ensureLead(id){let l=fixture.leads.find(l=>l.project_id===id);if(!l){l={project_id:id,status:'unknown',quick:null,deep:null,score:null,materials:{},materials_revision:0,excluded:false,opted_out:false,updated_at:now()};fixture.leads.push(l);}return l;}
  ensureLead('fixture-3').status='error';
  fixture.complete=id=>{const j=fixture.jobs.find(j=>j.id===id);if(!j)return;Object.assign(j,{status:'completed',progress:{stage:'completed'}});const l=ensureLead(j.project_id),r=research(j.project_id,j.kind);Object.assign(l,{[j.kind]:r,status:'complete',score:r.score,checked_at:r.checkedAt,expires_at:r.expiresAt,updated_at:now()});if(j.kind==='deep'){l.materials=materials();l.materials_revision++;}event('completed',j.project_id);};
  window.VC.leadConfigured=()=>!params.has('lead-unconfigured');
  window.VC.leadCall=async(action,payload={})=>{
    fixture.requests.push(clone({action,...payload}));await new Promise(resolve=>setTimeout(resolve,25));
    if(fixture.nextError?.action===action){const code=fixture.nextError.code;fixture.nextError=null;const error=new Error('Изолированная ошибка провайдера.');error.code=code;throw error;}
    if(fixture.fail||params.has('lead-offline'))throw new Error('Изолированная ошибка: сервис исследований недоступен.');
    if(viewer&&!['overview','detail','chatgpt_status'].includes(action))throw new Error('Для этого действия недостаточно прав.');
    if(manager&&['settings','purge'].includes(action))throw new Error('Для этого действия недостаточно прав.');
    let result={ok:true};
    if(action==='overview'){
      const summary=l=>({...Object.fromEntries(['project_id','status','checked_at','expires_at','excluded','opted_out','updated_at','materials_revision'].map(k=>[k,l[k]])),industry:l.deep?.business?.industry||l.quick?.business?.industry,
        quick:l.quick?{kind:l.quick.kind,status:l.quick.status,business:{industry:l.quick.business.industry},ai:l.quick.ai}:null,
        deep:l.deep?{kind:l.deep.kind,status:l.deep.status,business:{industry:l.deep.business.industry},ai:l.deep.ai}:null,
        score:l.score?{total:l.score.total,priority:l.score.priority,services:l.score.services.map(s=>({id:s.id,label:s.label}))}:null});
      const all=fixture.leads.filter(l=>(!payload.cursor||l.project_id>payload.cursor)&&(!payload.since||new Date(l.updated_at)>=new Date(payload.since))).sort((a,b)=>a.project_id.localeCompare(b.project_id)),size=Math.min(payload.limit||1000,fixture.pageSize);
      const paged=all.slice(0,size),meta={leads:paged.map(summary),total:fixture.leads.length,nextCursor:all.length>size?paged.at(-1).project_id:null,serverTime:now()};
      if(payload.cursor)return clone({...result,...meta});
      const counts=Object.fromEntries(['high','medium','low','unknown'].map(k=>[k,fixture.leads.filter(l=>(l.score?.priority||'unknown')===k).length]));
      Object.assign(result,{settings:fixture.settings,jobs:fixture.jobs,events:fixture.events,capabilities:fixture.capabilities,usage:fixture.usage,analytics:{processedQuick:fixture.leads.filter(l=>l.quick).length,processedDeep:fixture.leads.filter(l=>l.deep).length,priorityCounts:counts,replyCounts:Object.fromEntries(['interest','details','refusal','later','unknown'].map(k=>[k,fixture.replies.filter(r=>r.classification===k).length]))}},meta);
    }else if(action==='detail'){Object.assign(result,{lead:fixture.leads.find(l=>l.project_id===payload.projectId)||null,jobs:fixture.jobs.filter(j=>j.project_id===payload.projectId),events:fixture.events.filter(e=>e.project_id===payload.projectId),replies:fixture.replies.filter(r=>r.project_id===payload.projectId)});
    }else if(action==='enqueue'){
      const l=ensureLead(payload.projectId);if(l.excluded||l.opted_out)throw new Error('Компания исключена из обработки.');
      let j=fixture.jobs.find(j=>j.project_id===payload.projectId&&j.kind===payload.kind&&['queued','running','paused'].includes(j.status));
      if(!j&&!payload.force&&l[payload.kind]&&new Date(l[payload.kind].expiresAt)>new Date())return clone({ok:true,job:fixture.jobs.find(j=>j.project_id===payload.projectId&&j.kind===payload.kind&&j.status==='completed')||null});
      if(!j){j={id:crypto.randomUUID(),project_id:payload.projectId,kind:payload.kind,status:'queued',attempts:0,progress:{},force:payload.force===true};fixture.jobs.unshift(j);event('queued',payload.projectId);}l.status='queued';l.updated_at=now();result.job=j;
    }else if(action==='job'){
      const j=fixture.jobs.find(j=>j.id===payload.jobId);if(!j)throw new Error('Задача не найдена.');j.status={pause:'paused',resume:'queued',retry:'queued',cancel:'cancelled'}[payload.operation];if(payload.operation==='retry')j.error_code=null;const l=ensureLead(j.project_id);l.status=j.status;l.updated_at=now();result.job=j;event('job_'+payload.operation,j.project_id);
    }else if(action==='chatgpt_status'){result.chatgpt=fixture.capabilities.chatgpt;
    }else if(action==='chatgpt_disconnect'){
      if(!fixture.capabilities.chatgpt.canManage)throw new Error('Подпиской управляет только её владелец.');
      Object.assign(fixture.capabilities.chatgpt,{connected:false,planUsageEnabled:false,models:[],accountLabel:null,requiresLocalSetup:true});fixture.settings.aiEnabled=false;result.chatgpt=fixture.capabilities.chatgpt;
    }else if(action==='settings'){Object.assign(fixture.settings,payload.settings);result.settings=fixture.settings;event('settings_changed');
    }else if(action==='materials'){
      const l=ensureLead(payload.projectId);if(fixture.conflictOnce){fixture.conflictOnce=false;l.materials_revision++;throw new Error('Материалы уже изменены в другом окне. Твой текст сохранён на экране; скопируй его и загрузи актуальную версию.');}
      if(payload.revision!==l.materials_revision)throw new Error('Конфликт версии материалов.');l.materials=clone(payload.materials);l.materials_revision++;l.updated_at=now();result.lead=l;event('materials_edited',payload.projectId);
    }else if(action==='policy'){
      const l=ensureLead(payload.projectId);Object.assign(l,{excluded:payload.excluded,opted_out:payload.optedOut,contact_permission:payload.contactPermission,updated_at:now()});result.lead=l;event('policy_changed',payload.projectId);
    }else if(action==='reply'){
      const t=payload.text.toLowerCase(),classification=/не пиш|отказ|не интересно/.test(t)?'refusal':/позже|месяц/.test(t)?'later':/подроб|стоим|цен/.test(t)?'details':/интерес|давайте/.test(t)?'interest':'unknown';
      const reply={id:crypto.randomUUID(),project_id:payload.projectId,text:payload.text,classification,confidence:.8,suggestedReply:classification==='refusal'?'Спасибо, больше не будем беспокоить.':'Спасибо за ответ. Уточним задачу и согласуем следующий шаг.',nextAction:classification==='refusal'?'Прекратить контакты':'Проверить ответ и согласовать следующий шаг',optOut:classification==='refusal',created_at:now()};
      fixture.replies.unshift(reply);if(reply.optOut){const l=ensureLead(payload.projectId);l.opted_out=true;l.status='opted_out';l.updated_at=now();}result.reply=reply;event('reply_classified',payload.projectId);
    }else if(action==='purge'){
      Object.assign(ensureLead(payload.projectId),{status:'purged',quick:null,deep:null,score:null,materials:null,excluded:true,checked_at:null,expires_at:null,updated_at:now()});fixture.jobs=fixture.jobs.filter(j=>j.project_id!==payload.projectId);fixture.replies=fixture.replies.filter(r=>r.project_id!==payload.projectId);result.deleted=true;
    }else throw new Error('Неизвестное тестовое действие.');
    return clone(result);
  };
})();
