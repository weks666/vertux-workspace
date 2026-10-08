/* ISOLATED PREVIEW ONLY. Loaded instead of auth.js by preview-server.mjs. */
(function(){
  const params=new URLSearchParams(location.search),manager=params.has('manager'),viewer=params.has('viewer');
  const clone=v=>structuredClone(v);
  const rows=[
    {id:'fixture-1',company:'Тестовый банкетный зал',city:'Санкт-Петербург',phone:'8 (000) 000-00-01',niche:'Банкетный зал',stage:'new',type:'redesign',processed:true,rating:4.8,call_script:'Здравствуйте! Подскажите, кто отвечает за заявки на корпоративы?',gen_prompt:'Локальный макет банкетной площадки. Все данные тестовые.',context:'Тестовая карточка для проверки интерфейса.',issues:'Пример наблюдения: условия банкета на одной странице.',raw:{next_call:'2026-08-09',calls:[]}},
    {id:'fixture-2',company:'Оплаченный тестовый проект',city:'Казань',phone:'8 (000) 000-00-02',niche:'Ресторан',stage:'paid',processed:true,raw:{calls:[],money:{amount:15000.5,percent:35,paid_at:'2026-10-01T12:00:00'}}},
    {id:'fixture-3',company:'Согласованный тестовый проект',city:'Владимир',phone:'8 (000) 000-00-03',niche:'Банкетный зал',stage:'agreed',processed:false,raw:{money:{amount:25000,percent:30}}},
    {id:'fixture-4',company:'Завтрашний тестовый звонок',city:'Москва',phone:'8 (000) 000-00-04',niche:'Ресторан',stage:'contacted',processed:false,raw:{next_call:new Date(Date.now()+86400000).toISOString()}}
  ].map(r=>({...r,updated_at:'2026-10-01T12:00:00.000Z'}));
  const finances=rows.filter(r=>r.raw.money).map(r=>({project_id:r.id,money:r.raw.money,updated_at:r.updated_at}));
  rows.forEach(r=>{delete r.raw.money;});
  const state=window.__fixture={rows,finances,aiRequests:[],failAI:false,failDB:false,speechStarts:0,speechAborts:0,switches:[]};
  const client={from(table){
    const financeTable=table==='workspace_project_finance';
    let patch=null,insert=null,filters=[],columns='*',range=null;
    const query={select(c){columns=c;return this;},order(){return this;},range(a,b){range=[a,b];return this;},eq(k,v){filters.push([k,v]);return this;},is(k,v){filters.push([k,v]);return this;},update(v){patch=v;return this;},insert(v){insert=v;return this;},single(){return execute(true);},maybeSingle(){return execute(true);},then(resolve,reject){return execute(false).then(resolve,reject);}};
    async function execute(single){
      if(state.failDB)return {data:null,error:{message:'Изолированная ошибка базы'}};
      if(financeTable&&(manager||viewer))return {data:single?null:[],error:(patch||insert)?{code:'42501',message:'Нет доступа к деньгам'}:null};
      const source=financeTable?finances:rows;
      if(insert)for(const row of Array.isArray(insert)?insert:[insert])source.push({...clone(row),...(financeTable?{}:{id:'fixture-'+crypto.randomUUID()}),updated_at:row.updated_at||new Date().toISOString()});
      let matched=source.filter(r=>filters.every(([k,v])=>r[k]===v));
      if(range)matched=matched.slice(range[0],range[1]+1);
      if(patch)matched.forEach(r=>Object.assign(r,clone(patch)));
      const result=matched.map(r=>columns.startsWith('*,finance:')?{...r,finance:manager||viewer?null:finances.find(f=>f.project_id===r.id)||null}:columns==='*'?r:Object.fromEntries(columns.split(',').map(k=>[k,r[k]])));
      return {data:clone(single?result[0]||null:result),error:null};
    }
    return query;
  }};
  window.VCAuth={client:()=>client,enabled:()=>true,nexusRequired:()=>true,nexusManaged:()=>true,nexusOrigin:()=> 'https://nexus.vertux.online',
    async currentUser(){return {id:'fixture-user',name:'Тестовый менеджер',email:'fixture@example.invalid',role:viewer?'наблюдатель':manager?'менеджер':'основатель',roleKey:viewer?'viewer':manager?'manager':'owner',can:{edit:!viewer,finance:!manager&&!viewer}};},
    openNexus(destination){state.switches.push(destination);},async signOut(){state.signedOut=true;}
  };
  const overview={capabilities:{viewCommercialDetails:!manager,createSupportTicket:true,replySupportTicket:false},module:{sections:['subscription','support','access']},product:{name:'Локальный Workspace',id:'fixture-product'},organization:{name:'Тестовая организация'},
    subscription:{status:'trial',planName:'Тестовый тариф',features:['Только локальная проверка'],priceSnapshot:null},usage:{totals:[],events:[]},support:{tickets:[],canCreate:false},
    access:{members:[{id:'fixture-user',name:'Тестовый менеджер',email:'fixture@example.invalid',role:'manager',status:'active',accessMode:'all'}],invitations:[],availableProducts:[],canManage:false,grantableRoles:[]}};
  window.nexusProduct={service:{async config(){return {ok:true,data:{moduleVersion:'1.2.2',contractVersion:2,assetUrl:'https://nexus.vertux.online/service-module/v1.2.2/vertux-service-center.js'}};},async overview(){return {ok:true,data:clone(overview)};}}};
  const validate=window.VC.exactHttpsAssetUrl;
  window.VC.exactHttpsAssetUrl=(...args)=>{const url=validate(...args);return url?'/__service/vertux-service-center.js':'';};
  const load=window.VC.loadData;
  window.VC.loadData=async()=>{const result=await load();window.VC.CONFIG.aiActive=!params.has('offline-ai');return result;};
  window.VC.probeAI=async()=>{window.VC.CONFIG.aiActive=!state.failAI;return !state.failAI;};
  window.VC.aiCall=async(mode,payload)=>{
    state.aiRequests.push(clone({mode,...payload}));await new Promise(r=>setTimeout(r,100));
    if(state.failAI)throw new Error('Тестовая ошибка: сервис временно недоступен.');
    return {ok:true,text:mode==='roleplay'?'ТЕСТОВЫЙ ОТВЕТ: Что именно вы предлагаете?':'ТЕСТОВЫЙ РАЗБОР: уточните дату, число гостей и следующий шаг.'};
  };
  window.SpeechRecognition=class{
    start(){state.speechStarts++;state.speech=this;}abort(){state.speechAborts++;}
  };
  const banner=document.createElement('div');banner.className='fixture-banner';banner.textContent='Локальный стенд · вымышленные данные · ответы ИИ имитируются';document.body.prepend(banner);
})();
