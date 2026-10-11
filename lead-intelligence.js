/* Lead Intelligence extends the existing Workspace CRM. No provider keys or outbound delivery. */
(function(){
  'use strict';
  const $=(q,r=document)=>r.querySelector(q),$$=(q,r=document)=>Array.from(r.querySelectorAll(q));
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const arr=value=>Array.isArray(value)?value:[];
  const clone=value=>structuredClone(value);
  const STATUS={queued:'В очереди',pending:'В очереди',running:'Исследуется',researching:'Исследуется',complete:'Готово',completed:'Готово',done:'Готово',failed:'Ошибка',error:'Ошибка',retry:'Повтор позже',retry_wait:'Повтор позже',retrying:'Повтор позже',paused:'Приостановлено',cancelled:'Отменено',canceled:'Отменено',ready:'Готово',partial:'Частичные данные',unavailable:'Недостаточно данных',blocked:'Доступ ограничен',no_site:'Сайт не найден',not_found:'Сайт не найден',unknown:'Не исследовано',opted_out:'Контакты запрещены',purged:'Исследование удалено',excluded:'Исключена'};
  const PRIORITY={high:'Высокий',medium:'Средний',low:'Низкий',unknown:'Не определён'};
  const INDUSTRY={hotel:'Гостиницы',restaurant:'Рестораны',banquet:'Банкетные площадки',general:'Другие отрасли'};
  const SERVICES={website:'Сайт',booking:'Онлайн-запись',crm:'CRM-интеграция',automation:'Автоматизация'};
  const REPLIES={interest:'Интерес',details:'Запрос подробностей',refusal:'Отказ',later:'Связаться позже',unknown:'Нужна оценка менеджера'};
  const WEIGHTS={fit:'Соответствие Vertux',opportunity:'Возможности',contacts:'Контакты',freshness:'Актуальность',confidence:'Достоверность'};
  const PLAN_ERRORS={
    plan_quota_exceeded:'Дневной лимит AI-запросов Workspace исчерпан. Проверь лимит приложения.',
    plan_quota_above_server_limit:'Лимит AI-запросов выше разрешённого сервером. Обнови настройки и уменьши число.',
    chatgpt_connection_required:'Подключи подписку ChatGPT и выбери доступную модель аккаунта.',
    chatgpt_owner_required:'Личной подпиской ChatGPT может управлять и пользоваться здесь только её владелец.',
    ai_provider_mismatch:'Источник AI изменился. Обнови настройки перед новым запуском.',
    chatgpt_not_connected:'Подписка ChatGPT не подключена. Выполни вход через локальный помощник.',
    chatgpt_plan_permission_required:'Разреши использование лимитов подписки при входе через локальный помощник.',
    chatgpt_account_unverified:'Не удалось подтвердить аккаунт ChatGPT. Проверь подключение в настройках.',
    chatgpt_credentials_invalid:'Подключение ChatGPT нужно обновить через локальный помощник.',
    chatgpt_credentials_unavailable:'Подключение ChatGPT временно недоступно. Проверь его состояние в настройках.',
    subscription_sharing_invalid_user:'Не удалось подтвердить подключённый аккаунт. Проверь подключение ChatGPT.',
    chatgpt_account_changed:'Аккаунт ChatGPT изменился. Обнови подключение и выбери модель из нового каталога.',
    chatgpt_model_required:'Выбери модель подключённого аккаунта в настройках.',
    chatgpt_model_not_allowed:'Модель недоступна аккаунту. Проверь подключение и выбери доступную модель.',
    chatgpt_models_unavailable:'Каталог моделей ChatGPT пока недоступен. Проверь подключение позднее.',
    chatgpt_models_too_large:'Каталог моделей ChatGPT превышает допустимый размер. Подключение сохранено; помощнику требуется обновление.',
    chatgpt_models_invalid:'Не удалось прочитать каталог моделей ChatGPT. Подключение сохранено; попробуй проверить его позднее.',
    chatgpt_response_too_large:'Ответ ChatGPT превышает допустимый размер. Подключение сохранено; обработка остановлена.',
    chatgpt_host_unavailable:'Помощник ChatGPT временно недоступен. Подключение сохранено; попробуй проверить его позднее.',
    chatgpt_provider_unavailable:'Помощнику не удалось связаться с ChatGPT. Подключение сохранено; попробуй проверить его позднее.',
    subscription_sharing_usage_limit_exceeded:'Достигнут лимит подписки ChatGPT или этого приложения. AI остановлен; проверь лимиты в ChatGPT перед повторным включением.',
    subscription_sharing_user_not_eligible:'Подключённому аккаунту недоступно использование подписки в этом приложении.',
    subscription_sharing_usage_unavailable:'Сведения о лимитах ChatGPT временно недоступны. Подключение сохранено.',
    subscription_sharing_user_unavailable:'Аккаунт ChatGPT временно недоступен. Подключение сохранено.',
    chatgpt_route_unavailable:'AI через ChatGPT временно недоступен. Подключение сохранено.',
    chatpass_v2_scope_not_authorized:'Не хватает разрешения для AI-запросов. Проверь подключение ChatGPT.',
    chatpass_v2_invalid_authorization_context:'Разрешение ChatGPT нужно проверить через локальный помощник.',
    chatgpt_stream_interrupted:'Ответ ChatGPT прервался. Материалы не сформированы; автоматического повтора нет.',
    chatgpt_request_timeout:'ChatGPT не завершил ответ вовремя. Материалы не сформированы; автоматического повтора нет.',
    chatgpt_request_aborted:'Запрос ChatGPT остановлен. Материалы не сформированы; автоматического повтора нет.',
    chatgpt_response_incomplete:'ChatGPT вернул неполный ответ. Материалы не сформированы; автоматического повтора нет.'
  };
  const MATERIALS=[['summary','Кратко о компании',6000],['proposal','Предложение Vertux',6000],['callScript','Сценарий звонка',8000],['emailSubject','Тема письма',200],['emailBody','Первое письмо',6000],['icebreaker','Начало разговора',1200]];
  const state={context:null,snapshot:null,attempted:false,loading:false,loadedCount:0,watermark:null,error:'',notice:'',noticeJobId:null,busy:false,tab:'queue',jobFilter:'',settingsDraft:null,
    filters:{industry:'',status:'',priority:'',service:'',freshness:'',batch:'',site:''},details:new Map(),drafts:new Map(),card:null,timer:null,archiveView:false,listNotice:''};
  const projects=()=>state.context?.getProjects()||[];
  const configured=()=>window.VC.leadConfigured();
  const canEdit=()=>state.context?.user?.can?.edit===true&&state.snapshot?.capabilities?.canEdit!==false;
  const canConfigure=()=>['owner','admin'].includes(state.context?.user?.roleKey)&&state.snapshot?.capabilities?.canConfigure!==false;
  const usesPlan=(settings=state.snapshot?.settings)=>settings?.aiProvider==='chatgpt_plan';
  const chatgpt=()=>state.snapshot?.capabilities?.chatgpt||{};
  const canRunDeep=()=>!usesPlan()||chatgpt().canManage===true;
  const canResumeJobs=()=>!(usesPlan()&&state.snapshot?.settings?.aiEnabled&&chatgpt().canManage!==true);
  const canConfigureResearch=()=>canConfigure()&&(!usesPlan()||chatgpt().canManage===true);
  const planCap=()=>Math.min(50,Number(state.snapshot?.capabilities?.maxDailyPlanRequests)||50);
  const planLimit=()=>Math.min(Number(state.snapshot?.settings?.dailyPlanRequests)||10,planCap());
  const usageLink=()=>'<a class="link li-source-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Управлять лимитами ↗</a>';
  const measured=value=>Number.isFinite(Number(value))&&value!==null&&value!==undefined?Number(value):'—';
  const friendlyError=error=>PLAN_ERRORS[error?.code]||error.message;
  const planLimitError=code=>['subscription_sharing_usage_limit_exceeded','plan_quota_exceeded'].includes(code);
  const limitAction=code=>planLimitError(code)?`<p class="li-limit-action">${usageLink()}</p>`:'';
  const activeJob=job=>['queued','pending','running','retry','retry_wait','retrying'].includes(job.status);
  function enqueueNotice(job){
    if(job.status==='paused')return 'Исследование уже есть в очереди и приостановлено. Продолжи его в центре исследований.';
    if(job.status==='running')return 'Исследование уже выполняется. Результат появится после обработки.';
    if(['retry','retry_wait','retrying'].includes(job.status))return 'Исследование ожидает повторной попытки. Состояние задачи доступно в центре исследований.';
    return activeJob(job)?'Исследование в очереди. Результат появится после обработки.':'';
  }
  function syncEnqueueNotice(target,jobs){
    if(!target?.noticeJobId)return;
    const job=arr(jobs).find(job=>job.id===target.noticeJobId);if(!job)return;
    target.notice=enqueueNotice(job);if(!target.notice)target.noticeJobId=null;
  }
  const leadOf=id=>arr(state.snapshot?.leads).find(l=>String(l.project_id)===String(id))||state.details.get(String(id))?.lead||null;
  const researchOf=lead=>lead?.deep||lead?.quick||null;
  const date=value=>{if(!value)return 'Ещё не проверено';const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('ru-RU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Дата не указана';};
  const confidence=value=>value!==null&&value!==''&&Number.isFinite(Number(value))?Math.round(Math.max(0,Math.min(1,Number(value)))*100)+'%':'не определена';
  const money=value=>Number(value||0)/1e9;
  const usd=value=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(Number(value)||0);
  const message=(text,type='info')=>`<p class="li-message ${type==='error'?'li-error':''}" role="${type==='error'?'alert':'status'}">${esc(text)}</p>`;
  const empty=(title,text)=>`<div class="li-empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
  const button=(label,action,extra='',disabled=false,primary=false)=>`<button type="button" class="btn${primary?' gold':''}" data-li-action="${action}" ${extra}${disabled||state.busy?' disabled':''}>${esc(label)}</button>`;
  const badge=(label,key='')=>{const color=({complete:'completed',researching:'running',error:'failed'})[key]||key;return `<span class="li-badge ${['high','medium','low','failed','running','completed','partial','unknown'].includes(color)?'li-'+color:''}">${esc(label)}</span>`;};
  const option=(value,label,selected)=>`<option value="${esc(value)}"${String(selected)===String(value)?' selected':''}>${esc(label)}</option>`;
  const safeLink=(value,label)=>{const url=window.VC.safeHttpUrl(value);return url?`<a class="link li-source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label||url)} ↗</a>`:esc(label||'Источник без доступного URL');};
  const notify=()=>{if(!state.busy&&document.activeElement?.closest('#liSettingsForm'))return;state.context?.onUpdate?.();};

  function init(context){state.context=context;document.addEventListener('visibilitychange',()=>{if(!document.hidden&&context.visible?.()&&state.snapshot)void refresh(true);});}
  function ensure(){if(!state.attempted&&!state.loading)void refresh();else if(!state.timer&&state.snapshot)schedulePoll();}
  function schedulePoll(){
    clearTimeout(state.timer);state.timer=null;
    if(document.hidden||!state.context?.visible?.()||!configured())return;
    state.timer=setTimeout(()=>{state.timer=null;if(!document.hidden&&state.context?.visible?.())void refresh(true);},arr(state.snapshot?.jobs).some(activeJob)?8000:30000);
  }
  async function refresh(quiet=false){
    if(state.loading)return;
    state.attempted=true;
    if(!configured()){state.error='Сервис исследований ещё не подключён. После развёртывания здесь появятся реальные результаты и очередь.';notify();renderCard();return;}
    state.loading=true;if(!quiet)notify();
    try{
      let since=quiet&&state.watermark?new Date(new Date(state.watermark).getTime()-2000).toISOString():null;
      let result=await window.VC.leadCall('overview',{limit:1000,...(since?{since}:{})});
      if(since&&Number.isFinite(result.total)&&result.total!==state.snapshot?.total){since=null;result=await window.VC.leadCall('overview',{limit:1000});}
      const changed=[...arr(result.leads)],seen=new Set();let cursor=result.nextCursor;
      state.loadedCount=changed.length;
      while(cursor){
        if(seen.has(cursor))throw new Error('Сервис повторил страницу результатов. Повтори загрузку.');
        seen.add(cursor);
        if(!state.snapshot)notify();
        const page=await window.VC.leadCall('overview',{limit:1000,cursor,...(since?{since}:{})});
        changed.push(...arr(page.leads));state.loadedCount=changed.length;cursor=page.nextCursor;
      }
      const merged=new Map((since?arr(state.snapshot?.leads):[]).map(lead=>[String(lead.project_id),lead]));
      changed.forEach(lead=>merged.set(String(lead.project_id),lead));
      state.snapshot={...result,leads:[...merged.values()]};state.watermark=result.serverTime||null;state.error='';
      syncEnqueueNotice(state,result.jobs);syncEnqueueNotice(state.card,result.jobs);
      if(['research','audit','demo'].includes(state.card?.tab)&&state.card.mount.isConnected&&$('#drawer')?.classList.contains('open'))await loadDetail(state.card.project.id,true);
    }catch(error){state.error=friendlyError(error);state.errorCode=error.code;}
    finally{state.loading=false;notify();renderCard();schedulePoll();showPlanWelcome();}
  }
  function showPlanWelcome(){
    const c=chatgpt();if(!usesPlan()||!c.connected||!c.planUsageEnabled||!c.canManage||document.hidden||!state.context?.visible?.()||$('#liPlanWelcome'))return;
    try{if(localStorage.getItem('vc.li.chatgptPlanAcknowledged.v1')==='true')return;}catch(_){if(state.planAcknowledged)return;}
    const previous=document.activeElement,dialog=document.createElement('dialog');dialog.id='liPlanWelcome';dialog.className='li-plan-dialog';dialog.setAttribute('aria-labelledby','liPlanWelcomeTitle');
    dialog.innerHTML=`<h2 id="liPlanWelcomeTitle">Используется подписка ChatGPT</h2><p>AI-запросы Workspace расходуют лимиты твоей подписки. Включить генерацию и задать дневной лимит приложения можно в настройках исследований.</p><p>${usageLink()}</p><form method="dialog"><button class="btn gold" autofocus>Понятно</button></form>`;
    dialog.addEventListener('close',()=>{state.planAcknowledged=true;try{localStorage.setItem('vc.li.chatgptPlanAcknowledged.v1','true');}catch(_){}dialog.remove();if(previous?.isConnected)previous.focus();},{once:true});
    document.body.append(dialog);dialog.showModal();
  }
  function unavailable(){
    if(state.loading&&!state.snapshot)return message('Загружаем состояние исследований…'+(state.loadedCount?' Получено компаний: '+state.loadedCount+'.':''));
    if(!state.snapshot)return `<section class="panel"><div class="panel-b">${empty(configured()?'Исследования пока недоступны':'Подключение исследований',state.error||'Загружаем состояние сервиса.')}${configured()?button('Повторить подключение','refresh'):''}<p class="mut">Импорт, контакты, звонки и заметки доступны в текущей CRM.</p></div></section>`;
    return '';
  }
  function statusOf(lead){
    if(lead?.status==='purged')return 'purged';
    if(lead?.excluded)return 'excluded';
    if(lead?.opted_out)return 'opted_out';
    const running=arr(state.snapshot?.jobs).find(j=>String(j.project_id)===String(lead?.project_id)&&activeJob(j));
    if(running)return running.status==='running'?'running':'queued';
    const status=lead?.status||researchOf(lead)?.status||'unknown';return {complete:'ready',completed:'ready',done:'ready',researching:'running',error:'failed'}[status]||status;
  }
  const statusLabel=key=>key==='excluded'?'Исключена':STATUS[key]||'Статус требует проверки';
  const briefOf=project=>project.raw?._researchBrief||{};
  const industryOf=(project,lead)=>briefOf(project).industry||lead?.industry||researchOf(lead)?.business?.industry||project.niche||'';
  const servicesOf=lead=>arr((lead?.score||researchOf(lead)?.score)?.services).map(s=>typeof s==='string'?{id:s,label:SERVICES[s]||s}:s);
  function listFilters(search='',archived=false){
    if(state.archiveView!==archived)Object.keys(state.filters).forEach(k=>state.filters[k]='');
    state.archiveView=archived;
    const scope=projects().filter(p=>Boolean(p.archived_at)===archived),batches=new Map();scope.forEach(p=>{if(p.lead_batch_id)batches.set(p.lead_batch_id,p.lead_batch_name||'Без названия');});
    if(state.filters.batch&&!batches.has(state.filters.batch))state.filters.batch='';
    const industries=[...new Set(scope.map(p=>industryOf(p,leadOf(p.id))).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
    const serviceValues=new Map();arr(state.snapshot?.leads).forEach(l=>servicesOf(l).forEach(s=>serviceValues.set(s.id||s.label,s.label||SERVICES[s.id]||s.id)));
    const f=state.filters,disabled=state.snapshot?'':' disabled';
    const runCount=batches.size,runWord=runCount%10===1&&runCount%100!==11?'прогон':[2,3,4].includes(runCount%10)&&![12,13,14].includes(runCount%100)?'прогона':'прогонов';
    return `<div class="li-list-header"><div><b>${archived?'Архив компаний':'Компании для работы'}</b><span class="mut">${scope.length} компаний · ${runCount} ${runWord}</span></div>${button(archived?'К текущей базе':'Открыть архив',archived?'active-list':'archive-list')}</div>
      ${archived?message('Сохранены карточки, материалы и история. Компании из архива не участвуют в обзвоне и исследованиях.'):''}
      ${state.listNotice?message(state.listNotice):''}
      <div class="li-batch-tools"><label>Прогон<select data-li-filter="batch">${option('','Все прогоны',f.batch)}${[...batches].map(([id,name])=>option(id,name,f.batch)).join('')}</select></label>${f.batch&&canEdit()?button(archived?'Вернуть прогон в работу':'Перенести прогон в архив','archive-batch'):''}${button('Центр исследований','center')}</div>
      ${state.error&&configured()?message(state.error,'error'):''}
      <div class="li-filters" aria-label="Фильтры исследований">
        <label class="li-mobile-search">Поиск компании<input id="liCompanySearch" type="search" value="${esc(search)}" placeholder="Название, город, отрасль"></label>
        <label>Отрасль<select data-li-filter="industry">${option('','Все отрасли',f.industry)}${industries.map(i=>option(i,INDUSTRY[i]||i,f.industry)).join('')}</select></label>
        <label>Сайт<select data-li-filter="site">${[['','Любой'],['not_found','Собственный сайт не найден'],['social_only','Только соцсети / мини-страница'],['verified','Есть собственный сайт']].map(([k,v])=>option(k,v,f.site)).join('')}</select></label>
        <label>Исследование<select data-li-filter="status"${disabled}>${option('','Все статусы',f.status)}${[['unknown','Не исследовано'],['queued','В очереди'],['running','Исследуется'],['ready','Готово'],['partial','Частичные данные'],['failed','Ошибка'],['excluded','Исключена'],['opted_out','Контакты запрещены'],['purged','Исследование удалено']].map(([k,v])=>option(k,v,f.status)).join('')}</select></label>
        <label>Приоритет<select data-li-filter="priority"${disabled}>${option('','Любой',f.priority)}${Object.entries(PRIORITY).map(([k,v])=>option(k,v,f.priority)).join('')}</select></label>
        <label>Услуга<select data-li-filter="service"${disabled}>${option('','Все услуги',f.service)}${[...serviceValues].map(([k,v])=>option(k,v,f.service)).join('')}</select></label>
        <label>Проверка<select data-li-filter="freshness"${disabled}>${[['','Любая дата'],['week','За 7 дней'],['month','За 30 дней'],['stale','Пора обновить'],['never','Не проверено']].map(([k,v])=>option(k,v,f.freshness)).join('')}</select></label>
        ${Object.values(f).some(Boolean)?button('Сбросить','reset-filters'):''}
      </div>`;
  }
  function filterProjects(list){
    const f=state.filters,now=Date.now();
    return list.filter(p=>{
      const l=leadOf(p.id),r=researchOf(l),score=l?.score||r?.score,checked=l?.checked_at||r?.checkedAt,status=statusOf(l),time=checked?new Date(checked).getTime():NaN;
      if(f.batch&&p.lead_batch_id!==f.batch)return false;
      if(f.site&&briefOf(p).siteStatus!==f.site)return false;
      if(f.industry&&industryOf(p,l)!==f.industry)return false;
      if(f.status&&(f.status==='ready'?!['ready','completed','done'].includes(status):status!==f.status))return false;
      if(f.priority&&(score?.priority||'unknown')!==f.priority)return false;
      if(f.service&&!servicesOf(l).some(s=>(s.id||s.label)===f.service))return false;
      if(f.freshness==='never'&&checked)return false;
      if(['week','month'].includes(f.freshness)&&(!checked||now-time>(f.freshness==='week'?7:30)*864e5))return false;
      if(f.freshness==='stale'&&(!checked||!(now>=new Date(l?.expires_at||r?.expiresAt||time+(state.snapshot?.settings?.staleDays||30)*864e5).getTime())))return false;
      return true;
    });
  }
  function listCells(project){
    const lead=leadOf(project.id),score=lead?.score||researchOf(lead)?.score,priority=score?.priority||'unknown';
    return `<td class="c-pr" data-label="Приоритет" title="${esc(briefOf(project).priorityReason||'Открой карточку для объяснения')}">${badge(priority==='unknown'?'Нет оценки':PRIORITY[priority]||'Нет оценки',priority)}</td>`;
  }
  async function archiveProjects(list,archived){
    if(!canEdit()||state.busy||!list.length)return;
    state.busy=true;state.listNotice='Сохраняем…';notify();
    try{const patch=await window.VC.setArchived(list.map(p=>p.id),archived);list.forEach(p=>Object.assign(p,patch));state.listNotice=`${archived?'Перенесено в архив':'Возвращено в работу'}: ${list.length}.`;state.filters.batch='';await state.context.changed?.();await refresh(true);}
    catch(e){state.listNotice='Не удалось завершить: '+e.message;}
    finally{state.busy=false;notify();renderCard();}
  }
  function archiveCardControls(project){return `<div class="li-archive-control"><span class="mut">${esc(project.lead_batch_name||'Прогон не указан')}${project.archived_at?' · В архиве':''}</span>${canEdit()?button(project.archived_at?'Вернуть в работу':'В архив','archive-one'):''}</div>`;}
  function wireList(root){
    ensure();wireActions(root);
    $$('[data-li-filter]',root).forEach(el=>el.onchange=()=>{state.filters[el.dataset.liFilter]=el.value;notify();});
    const search=$('#liCompanySearch',root);if(search)search.oninput=()=>{const caret=search.selectionStart;state.context.search(search.value);const next=$('#liCompanySearch');next?.focus();next?.setSelectionRange(caret,caret);};
  }

  function center(){
    const tabs=[['queue','Очередь'],['analytics','Аналитика'],['settings','Настройки']];
    return `<div class="li-center"><div class="li-topline"><div class="li-tabs" role="tablist" aria-label="Центр исследований">${tabs.map(([id,label])=>`<button type="button" class="chip${state.tab===id?' active':''}" role="tab" aria-selected="${state.tab===id}" tabindex="${state.tab===id?'0':'-1'}" aria-controls="liCenterPanel" data-li-tab="${id}">${label}</button>`).join('')}</div>${button(state.loading?'Обновляем…':'Обновить','refresh','',state.loading)}</div>
      ${state.error&&state.snapshot?message(state.error+' Отображаются последние загруженные данные.','error')+limitAction(state.errorCode):''}${state.notice?message(state.notice):''}${budgetNotice()}
      ${unavailable()||`<div role="tabpanel" id="liCenterPanel">${state.tab==='settings'?settingsView():state.tab==='analytics'?analyticsView():queueView()}</div>`}</div>`;
  }
  function scheduleText(){const s=state.snapshot.settings;return `${s.scheduleTime} · ${s.timezone} · Quick до ${s.dailyQuick}, Deep до ${s.dailyDeep} в день`;}
  function budgetNotice(){
    if(!state.snapshot?.settings.aiEnabled)return '';
    if(usesPlan()){
      const used=measured(state.snapshot.usage?.planRequests),limit=planLimit();
      if(used==='—'||!limit||used<limit*.8)return '';
      return `<p class="li-message${used>=limit?' li-error':''}" role="${used>=limit?'alert':'status'}">${used>=limit?'Дневной лимит AI-запросов приложения исчерпан':'Использовано '+Math.round(used/limit*100)+'% дневного лимита AI-запросов приложения'}: ${used} из ${limit}. Это лимит Workspace; лимиты подписки проверяются в ChatGPT. ${usageLink()}</p>`;
    }
    const {settings,usage={},capabilities={}}=state.snapshot,limit=Math.min(Number(settings.dailyBudgetUsd)||0,Number(capabilities.maxDailyBudgetUsd)||0),used=money(Number(usage.costNanos||0)+Number(usage.reservedNanos||0));
    if(limit<=0)return message('Платная генерация остановлена: доступный дневной бюджет равен нулю. Проверь настройки и серверный лимит.','error');
    if(used>=limit)return message('Дневной бюджет исчерпан: учтено '+usd(used)+' из '+usd(limit)+'. Новая платная генерация остановлена до освобождения лимита.','error');
    if(used>=limit*.8)return message('Использовано '+Math.round(used/limit*100)+'% дневного бюджета: '+usd(used)+' из '+usd(limit)+', включая резерв.');
    return '';
  }
  function queueView(){
    const s=state.snapshot.settings,jobs=arr(state.snapshot.jobs),filtered=state.jobFilter?jobs.filter(j=>state.jobFilter==='active'?activeJob(j):j.status===state.jobFilter):jobs;
      return `<section class="li-intro"><div><h2>Конвейер исследований</h2><p>Сервер продолжает обработку, когда Workspace закрыт. Новые компании поступают из существующего импорта.</p></div>${badge(!s.enabled?'Обработка выключена':s.paused?'На паузе':'Включено',s.enabled&&!s.paused?'completed':'partial')}</section>
      <div class="li-schedule"><div><b>Ежедневно в ${esc(s.scheduleTime)}</b><span class="mut">${esc(s.timezone)} · до ${s.dailyQuick} Quick / ${s.dailyDeep} Deep</span></div><div class="row-inline">${canConfigureResearch()?button(s.paused?'Продолжить обработку':'Приостановить','toggle-pause','',!s.enabled):''}${button('Расписание и лимиты','settings-tab')}</div></div>
      <div class="li-section-head"><h3>Задачи</h3><label class="li-inline-label">Показать<select id="liJobFilter">${[['','Последние задачи'],['active','Активные'],['completed','Завершённые'],['failed','Ошибки'],['paused','На паузе']].map(([k,v])=>option(k,v,state.jobFilter)).join('')}</select></label></div>
      ${jobs.length?`<p class="mut li-caption">Последние ${jobs.length} задач. Состояние активной очереди обновляется автоматически.</p>`:''}
      ${filtered.length?`<div class="panel li-jobs">${filtered.map(jobView).join('')}</div>`:empty('В этом списке пока нет задач','Открой компанию и запусти Quick Scan или Deep Research. Автоматические запуски зависят от настроек и серверного расписания.')}
      <details class="li-details"><summary>Последние события системы</summary>${eventsView(arr(state.snapshot.events))}</details>`;
  }
  function jobView(job){
    const project=projects().find(p=>String(p.id)===String(job.project_id)),progress=job.progress;
    const progressText=typeof progress==='string'?progress:progress?.message||progress?.phase||({researching:'Изучаем страницы',materials:'Готовим материалы',completed:'Исследование завершено'}[progress?.stage])||'';
    const controls=[];
    if(canEdit()){
      if(['queued','pending','running','retry','retry_wait','retrying'].includes(job.status))controls.push(['pause','Пауза']);
      if(job.status==='paused')controls.push(['resume','Продолжить']);
      if(['failed','cancelled','canceled'].includes(job.status)&&!['archived','curated_import'].includes(job.error_code)&&!project?.archived_at)controls.push(['retry','Повторить']);
      if(activeJob(job)||job.status==='paused')controls.push(['cancel','Отменить']);
    }
    return `<article class="li-job"><div class="li-job-main"><button class="li-text-button" type="button" data-li-open="${esc(job.project_id)}">${esc(project?.company||'Компания недоступна')}</button><span class="mut">${job.kind==='deep'?'Deep Research':'Quick Scan'} · попытка ${Number(job.attempts)||0}</span>${progressText?`<span>${esc(progressText)}</span>`:''}${job.error_code?`<span class="${['archived','curated_import'].includes(job.error_code)?'mut':'li-error-text'}">${esc(errorLabel(job.error_code))}</span>${limitAction(job.error_code)}`:''}${job.next_run_at&&activeJob(job)?`<span class="mut">Следующий запуск: ${esc(date(job.next_run_at))}</span>`:''}</div><div class="li-job-status">${badge(statusLabel(job.status),job.status)}${controls.length?`<div class="li-job-actions">${controls.map(([op,label])=>button(label,'job',`data-job-id="${esc(job.id)}" data-job-op="${op}"`,['resume','retry'].includes(op)&&!canResumeJobs())).join('')}</div>`:''}</div></article>`;
  }
  function errorLabel(code){const labels={archived:'Компания в архиве; задача остановлена.',curated_import:'Исследование уже добавлено с подборкой.',robots_denied:'Обход запрещён правилами сайта',robots_unavailable:'Правила обхода сайта недоступны',timeout:'Сайт не ответил вовремя',request_timeout:'Сайт не ответил вовремя',request_failed:'Не удалось прочитать сайт',dns_failed:'Не удалось определить адрес сайта',rate_limited:'Сайт ограничил частоту запросов',http_unavailable:'Сайт временно недоступен',job_interrupted:'Обработка прервана; проверь состояние задачи',worker_stopped:'Обработка остановлена при перезапуске сервера',no_site:'Официальный сайт не найден',daily_budget_exhausted:'Исчерпан дневной бюджет',company_budget_exhausted:'Исчерпан бюджет компании',budget_exceeded:'Лимит расходов исчерпан',lease_expired:'Задача прервана; сервер восстановит её',provider_unavailable:'Провайдер временно недоступен',not_public_address:'Адрес не подходит для публичного исследования',excluded:'Компания исключена',opted_out:'Компания отказалась от контактов'};return PLAN_ERRORS[code]||labels[code]||'Обработка не завершена. Обнови данные или повтори задачу.';}
  function analyticsView(){
    const a=state.snapshot.analytics||{},u=state.snapshot.usage||{},leads=arr(state.snapshot.leads),priority=a.priorityCounts||Object.fromEntries(Object.keys(PRIORITY).map(k=>[k,leads.filter(l=>(l.score?.priority||'unknown')===k).length]));
    const replyCounts=a.replyCounts||{},plan=usesPlan();
    const totals=[['Quick Scan',a.processedQuick??leads.filter(l=>l.quick).length],['Deep Research',a.processedDeep??leads.filter(l=>l.deep).length],...(plan?[['Запросы ChatGPT за день',measured(u.planRequests)],['В обработке',measured(u.planReservedRequests)]]:[['Расход API за день',usd(money(u.costNanos))],['Резерв API за день',usd(money(u.reservedNanos))]])];
    const funnel=[['new','Новые'],['contacted','Связались'],['demo_sent','Отправлена демка'],['agreed','Согласовано'],['paid','Оплачено'],['refused','Отказ']];
    const costRows=plan?[['Завершённые запросы',measured(u.planCompletedRequests)],['Ожидают подтверждения',measured(u.planUncertainRequests)],['Входные токены',measured(u.planInputTokens)],['Выходные токены',measured(u.planOutputTokens)],['Лимит приложения в день',planLimit()]]:[['Входные токены',u.inputTokens||0],['Выходные токены',u.outputTokens||0],['Бюджет в день',usd(state.snapshot.settings.dailyBudgetUsd)],['Бюджет на компанию',usd(state.snapshot.settings.companyBudgetUsd)]];
    return `<section class="li-intro"><div><h2>${plan?'Результаты и лимиты':'Результаты и расходы'}</h2><p>Сохранённые исследования, фактические события CRM и журнал AI-запросов. Исследование само по себе не означает отправку письма или продажу.</p></div></section>
      ${plan?`<p class="li-message"><b>Подписка ChatGPT.</b> Расходует лимиты твоей подписки. ${usageLink()}</p>`:''}
      <dl class="li-stat-line">${totals.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
      <p class="mut li-caption">${plan?'AI-запросы':'Расходы'} ${u.day?'за '+esc(u.day):'за текущий день'}${u.timezone?' · '+esc(u.timezone):''}. Число исследований и ответов — по сохранённым данным за всё время.</p>
      <div class="li-columns"><section class="panel"><div class="panel-h"><h3>Приоритет компаний</h3></div><div class="panel-b">${countRows(Object.entries(PRIORITY).map(([k,label])=>[label,priority[k]||0]))}</div></section>
      <section class="panel"><div class="panel-h"><h3>Воронка CRM</h3></div><div class="panel-b">${countRows(funnel.map(([k,label])=>[label,projects().filter(p=>(p.stage||'new')===k).length]))}<p class="mut li-caption">Текущие стадии компаний. Изменяются менеджером в CRM.</p></div></section></div>
      <div class="li-columns"><section class="panel"><div class="panel-h"><h3>Входящие ответы</h3></div><div class="panel-b">${countRows(Object.entries(REPLIES).map(([k,label])=>[label,replyCounts[k]||0]))}<p class="mut li-caption">Только ответы, вручную сохранённые в карточках. Почтовый ящик не подключён.</p></div></section>
      <section class="panel"><div class="panel-h"><h3>${plan?'Контроль запросов':'Контроль стоимости'}</h3></div><div class="panel-b">${countRows(costRows)}<p class="mut li-caption">${plan?'Дневной лимит приложения ограничивает число допущенных AI-запросов, включая ещё не завершённые. Он не показывает остаток подписки ChatGPT.':'Резерв учитывается в лимите до окончательного расчёта.'} Quick Scan работает без LLM.</p>${!plan&&Number(u.companyCount)>0&&arr(u.companies).length===Number(u.companyCount)?`<p>Средний подтверждённый расход на компанию: <b>${usd(money(u.companies.reduce((sum,c)=>sum+Number(c.costNanos||0),0))/Number(u.companyCount))}</b> (${Number(u.companyCount)} компаний за день).</p>`:''}${!plan&&u.uncertainRequests?message('Ожидают подтверждения расходов: '+Number(u.uncertainRequests)+'. Резерв остаётся в лимите до сверки.'):''}</div></section></div>
      ${!plan&&arr(u.companies).length?`<details class="li-details"><summary>Расходы по компаниям</summary>${countRows(u.companies.map(v=>[projects().find(p=>String(p.id)===String(v.project_id))?.company||'Компания',usd(money(v.costNanos))]))}</details>`:''}
      <p class="li-message">Результаты кампаний не измеряются: отправка писем и автоматическая загрузка ответов не подключены. Доступны черновики и история действий менеджера.</p>`;
  }
  const countRows=rows=>`<dl class="li-count-rows">${rows.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;

  const NUMBERS=[['dailyQuick','Quick Scan в день',0,10000],['dailyDeep','Deep Research в день',0,1000],['deepThreshold','Приоритет для авто Deep',0,100],['staleDays','Обновлять через, дней',1,365],['retentionDays','Хранить данные, дней',7,365],['concurrency','Одновременных задач',1,6],['maxAttempts','Максимум попыток',1,5],['maxPagesQuick','Страниц Quick',1,4],['maxPagesDeep','Страниц Deep',1,12],['requestTimeoutMs','Тайм-аут сайта, мс',2000,30000],['requestsPerHostDelayMs','Пауза между страницами, мс',500,30000],['maxInputTokens','Входных токенов максимум',3000,32000],['maxOutputTokens','Выходных токенов максимум',300,4000]];
  function numberField(key,label,min,max,value,step=1){return `<label>${esc(label)}<input name="${key}" type="number" min="${min}" max="${max}" step="${step}" required value="${esc(value??min)}"></label>`;}
  function aiSettings(settings,caps,nums){
    const plan=usesPlan(settings),c=chatgpt(),models=plan?arr(c.models):arr(caps.models).map(id=>({id,label:id}));
    const modelExists=models.some(m=>m.id===settings.deepModel),canManagePlan=c.canManage===true;
    const available=plan?c.available===true&&c.connected===true&&c.planUsageEnabled===true&&models.length>0&&canManagePlan&&!c.error&&!c.providerUnavailable:caps.aiAvailable===true;
    const locked=plan&&!canManagePlan;
    return `<section class="li-form-section"><h3>AI и ${plan?'лимиты':'бюджет'}</h3><p class="mut">Quick Scan и классификация ответов работают без LLM. AI в Deep помогает выбрать аргументы по источникам; при выключенном AI доступны исследование и материалы по правилам.</p>
      <div class="li-form-grid"><label>Источник AI<select name="aiProvider"${locked?' disabled':''}>${option('openrouter','OpenRouter · отдельный API',settings.aiProvider||'openrouter')}<option value="chatgpt_plan"${plan?' selected':''}${!canManagePlan?' disabled':''}>Подписка ChatGPT</option></select></label></div>
      ${plan?`<div class="li-plan-connection"><div class="li-section-head"><h4>Подписка ChatGPT</h4>${badge(c.connected?(c.planUsageEnabled?'Подключена':'Вход выполнен'):'Не подключена',c.connected&&c.planUsageEnabled?'completed':'unknown')}</div>
        ${c.accountLabel?`<p>Аккаунт: <b>${esc(c.accountLabel)}</b></p>`:''}<p>Расходует лимиты твоей подписки. ${usageLink()}</p>
        ${!canManagePlan?message('Управление личной подпиской доступно только её владельцу. Подключать аккаунт, менять настройки и вручную запускать Deep Research может его владелец.'):!c.available||c.providerUnavailable?message('Подключение ChatGPT временно недоступно. Проверь состояние позднее.'):c.error?message(errorLabel(c.error),'error'):!c.connected?message(c.setupInstruction||'Для первого входа нужен локальный помощник на твоём компьютере. После входа проверь подключение здесь.'):!c.planUsageEnabled?message('Вход выполнен, но использование лимитов подписки не разрешено. Повтори подключение через локальный помощник с разрешением на AI-запросы.'):!models.length?message('Каталог моделей аккаунта пока недоступен. Проверь подключение перед включением AI.'):''}
        ${c.requiresLocalConnection&&!c.connected&&canManagePlan?'<p class="mut li-caption">Вход выполняется на твоём компьютере. Ключи, коды входа и токены в Workspace вводить не нужно.</p>':''}
        ${canManagePlan?`<div class="row-inline">${button('Проверить подключение','chatgpt-status')}${c.connected?button('Отключить ChatGPT','chatgpt-disconnect'):''}</div>`:''}</div>`:!caps.aiAvailable?message('AI-провайдер не подключён на сервере. Платные запросы недоступны.'):''}
      <fieldset${locked?' disabled':''}><label class="li-checkbox"><input type="checkbox" name="aiEnabled"${settings.aiEnabled?' checked':''}${!available&&!settings.aiEnabled?' disabled':''}>Генерировать материалы с AI</label>
      <div class="li-form-grid"><label>Модель исследования компаний<select name="deepModel"${!models.length?' disabled':''}${settings.aiEnabled?' required':''}>${!modelExists?option('',''+(models.length?'Выбери модель аккаунта':'Появится после подключения'),''):''}${models.map(m=>option(m.id,m.label||m.id,settings.deepModel)).join('')}</select></label>
      ${plan?`<label>Модель демо-сайтов<select name="demoModel"${!models.length?' disabled':''}>${!models.some(m=>m.id===settings.demoModel)?option('','Выбери модель для демо',''):''}${models.map(m=>option(m.id,m.label||m.id,settings.demoModel)).join('')}</select></label>`:''}
      ${plan?numberField('dailyPlanRequests','AI-запросов приложения в день',1,planCap(),settings.dailyPlanRequests??10):numberField('dailyBudgetUsd','Бюджет в день, USD',0,Number(caps.maxDailyBudgetUsd)||0,settings.dailyBudgetUsd,0.000001)+numberField('companyBudgetUsd','Бюджет на компанию, USD',0,Number(caps.maxCompanyBudgetUsd)||0,settings.companyBudgetUsd,0.000001)}
      ${nums(['maxInputTokens','maxOutputTokens'])}</div></fieldset>
      <p class="mut li-caption">${plan?'Лимит Workspace — от 1 до '+planCap()+' AI-запросов в день. Он ограничивает это приложение, а не показывает остаток тарифа. Quick Scan в этот счётчик не входит. После подключения AI включается отдельно.':'Серверный потолок: '+usd(caps.maxDailyBudgetUsd)+' в день / '+usd(caps.maxCompanyBudgetUsd)+' на компанию за всю историю. Нулевой бюджет блокирует платную генерацию.'}</p></section>`;
  }
  function settingsView(){
    const settings=state.settingsDraft||state.snapshot.settings,caps=state.snapshot.capabilities||{},editable=canConfigureResearch();
    const check=(key,label)=>`<label class="li-checkbox"><input type="checkbox" name="${key}"${settings[key]?' checked':''}>${label}</label>`;
    const nums=keys=>NUMBERS.filter(n=>keys.includes(n[0])).map(([key,label,min,max])=>numberField(key,label,min,max,settings[key])).join('');
    return `<section class="li-intro"><div><h2>Правила исследования</h2><p>Лимиты и расписание применяются на сервере. Модели доступны только из разрешённого списка провайдера.</p></div></section>
      ${!editable?message(usesPlan()&&!chatgpt().canManage?'Настройками исследований с личной подпиской ChatGPT управляет её владелец. Для твоей роли доступен просмотр.':'Настройки может менять владелец или администратор. Для твоей роли доступен просмотр.'):''}
      <form id="liSettingsForm" class="li-settings"><fieldset${!editable||state.busy?' disabled':''}>
        <section class="li-form-section"><h3>Конвейер и расписание</h3><div class="li-checks">${check('enabled','Включить обработку')}${check('autoQuick','Quick Scan после импорта')}${check('autoDeep','Deep Research по приоритету')}</div><div class="li-form-grid">
          <label>Ежедневный запуск<input name="scheduleTime" type="time" value="${esc(settings.scheduleTime)}" required></label>
          <label>Часовой пояс<input name="timezone" list="liTimezones" value="${esc(settings.timezone)}" maxlength="80" required><datalist id="liTimezones"><option value="Europe/Moscow"><option value="Europe/Kaliningrad"><option value="Asia/Yekaterinburg"><option value="Asia/Novosibirsk"><option value="Asia/Vladivostok"><option value="UTC"></datalist></label>
          ${nums(['dailyQuick','dailyDeep','deepThreshold','staleDays','retentionDays','concurrency','maxAttempts'])}</div></section>
        ${aiSettings(settings,caps,nums)}
        <details class="li-details"><summary>Глубина и ограничения обхода</summary><div class="li-form-grid">${nums(['maxPagesQuick','maxPagesDeep','requestTimeoutMs','requestsPerHostDelayMs'])}</div><p class="mut">Обход ограничен разрешёнными публичными страницами и правилами сайта. Браузерное чтение выполняется только при необходимости и наличии серверного адаптера.</p></details>
        <details class="li-details"><summary>Отрасли и объяснимый скоринг</summary><div class="li-checks">${Object.entries(INDUSTRY).map(([key,label])=>`<label class="li-checkbox"><input name="profile" type="checkbox" value="${key}"${arr(settings.industryProfiles).includes(key)?' checked':''}>${label}</label>`).join('')}</div><p class="mut">Вес каждого фактора, сумма — 100. Изменения применятся при следующем исследовании.</p><div class="li-form-grid">${Object.entries(WEIGHTS).map(([key,label])=>numberField('weight_'+key,label,0,100,settings.scoreWeights?.[key])).join('')}</div></details>
        <section class="li-form-section"><h3>Коммуникация</h3><p>Только черновики. Отправка и подключение почтового ящика недоступны. Лимит отправки: 0. Основание контакта, отказ и исключение сохраняются в истории компании.</p></section>
      </fieldset><div class="li-form-footer">${editable?`<button class="btn gold" type="submit"${state.busy?' disabled':''}>${state.busy?'Сохраняем…':'Сохранить настройки'}</button>${state.settingsDraft?button('Отменить изменения','reset-settings'):''}`:''}<span id="liSettingsMessage" class="mut" role="status">${state.settingsDraft?'Есть несохранённые изменения':''}</span></div></form>`;
  }
  function readSettings(form){
    const result=clone(state.settingsDraft||state.snapshot.settings);
    ['enabled','autoQuick','autoDeep','aiEnabled'].forEach(k=>result[k]=form.elements[k].checked);
    [...NUMBERS.map(n=>n[0]),'dailyBudgetUsd','companyBudgetUsd','dailyPlanRequests'].forEach(k=>{if(form.elements[k])result[k]=Number(form.elements[k].value);});
    ['scheduleTime','timezone','aiProvider'].forEach(k=>result[k]=form.elements[k].value.trim());
    if(form.elements.deepModel?.value)result.deepModel=form.elements.deepModel.value.trim();
    if(form.elements.demoModel?.value)result.demoModel=form.elements.demoModel.value.trim();
    result.industryProfiles=$$('input[name="profile"]:checked',form).map(x=>x.value);
    result.scoreWeights=Object.fromEntries(Object.keys(WEIGHTS).map(k=>[k,Number(form.elements['weight_'+k].value)]));
    result.communication={mode:'drafts',dailySendLimit:0};return result;
  }
  function validateSettings(settings){
    try{new Intl.DateTimeFormat('ru-RU',{timeZone:settings.timezone}).format();}catch(_){throw new Error('Укажи существующий часовой пояс, например Europe/Moscow.');}
    if(!settings.industryProfiles.length)throw new Error('Выбери хотя бы один отраслевой профиль.');
    if(Object.values(settings.scoreWeights).reduce((a,b)=>a+b,0)!==100)throw new Error('Сумма весов скоринга должна быть равна 100.');
    if(settings.maxPagesQuick>settings.maxPagesDeep)throw new Error('Глубина Deep Research должна быть не меньше Quick Scan.');
    if(usesPlan(settings)){
      const c=chatgpt();if(settings.aiEnabled&&c.error)throw new Error(errorLabel(c.error));
      if(settings.aiEnabled&&(!c.canManage||!c.available||!c.connected||!c.planUsageEnabled||c.providerUnavailable))throw new Error('Для AI сначала подключи свою подписку ChatGPT и разреши использование её лимитов.');
      if(settings.aiEnabled&&!arr(c.models).some(m=>m.id===settings.deepModel))throw new Error('Выбери доступную модель подключённого аккаунта.');
    }else{
      if(settings.companyBudgetUsd>settings.dailyBudgetUsd)throw new Error('Бюджет компании не может превышать дневной бюджет.');
      if(settings.aiEnabled&&(settings.dailyBudgetUsd<=0||settings.companyBudgetUsd<=0))throw new Error('Для AI задай ненулевой бюджет в день и на компанию.');
    }
  }
  function wireCenter(root){
    ensure();wireActions(root);
    $$('[data-li-tab]',root).forEach(el=>el.onclick=()=>{state.tab=el.dataset.liTab;state.notice='';state.noticeJobId=null;notify();$(`[data-li-tab="${state.tab}"]`)?.focus();});
    wireTabKeys(root,'data-li-tab');
    const filter=$('#liJobFilter',root);if(filter)filter.onchange=()=>{state.jobFilter=filter.value;notify();};
    const form=$('#liSettingsForm',root);if(form&&canConfigureResearch()){
      form.oninput=()=>{state.settingsDraft=readSettings(form);$('#liSettingsMessage',form).textContent='Есть несохранённые изменения';};
      form.elements.aiProvider.onchange=()=>{state.settingsDraft=readSettings(form);state.settingsDraft.aiEnabled=false;state.context?.onUpdate?.();$('#liSettingsForm [name=aiProvider]')?.focus();};
      form.onsubmit=async event=>{
        event.preventDefault();if(!form.reportValidity())return;
        try{const settings=readSettings(form);validateSettings(settings);state.settingsDraft=settings;const patch=clone(settings);if(usesPlan(settings)){delete patch.dailyBudgetUsd;delete patch.companyBudgetUsd;}await perform('settings',{settings:patch},'Настройки сохранены.',()=>{state.settingsDraft=null;});}
        catch(error){$('#liSettingsMessage',form).textContent=error.message;$('#liSettingsMessage',form).classList.add('li-error-text');}
      };
    }
  }

  function mountCard(project,mount,tabs,crm){
    const same=state.card&&String(state.card.project.id)===String(project.id);
    state.card={project,mount,tabs,crm,tab:same?state.card.tab:'crm',error:same?state.card.error:'',notice:same?state.card.notice:'',noticeJobId:same?state.card.noticeJobId:null,replyText:same?state.card.replyText:'',policyDraft:same?state.card.policyDraft:null,forceResearch:same?state.card.forceResearch:false};
    renderCard();
    if(state.card.tab!=='crm'&&configured())void loadDetail(project.id,true);
  }
  async function loadDetail(id,quiet=false){
    id=String(id);const old=state.details.get(id)||{};
    if(old.loading)return;
    state.details.set(id,{...old,loading:true,error:''});if(!quiet)renderCard();
    try{const result=await window.VC.leadCall('detail',{projectId:id});state.details.set(id,{...result,loaded:true,loading:false,error:''});syncEnqueueNotice(state,result.jobs);syncEnqueueNotice(state.card,result.jobs);}
    catch(error){state.details.set(id,{...old,loaded:true,loading:false,error:friendlyError(error),errorCode:error.code});}
    renderCard();
  }
  function renderCard(){
    const card=state.card;if(!card||!card.mount.isConnected)return;
    if(!state.busy&&card.mount.contains(document.activeElement)&&['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))return;
    const focusedTab=document.activeElement?.dataset.liCardTab;
    const openSections=new Set($$('details[open]',card.mount).map(el=>$('summary',el)?.textContent)),scroll=$('#drawer')?.scrollTop||0;
    const tabs=[['crm','CRM'],['research','Исследование'],['audit','Проверка сайта'],['demo','Демо'],['materials','Материалы'],['history','История']];
    card.tabs.innerHTML=tabs.map(([key,label])=>`<button type="button" role="tab" aria-selected="${card.tab===key}" tabindex="${card.tab===key?'0':'-1'}" aria-controls="${key==='crm'?'leadCardCrm':'leadCardMount'}" class="chip${card.tab===key?' active':''}" data-li-card-tab="${key}">${label}</button>`).join('');
    $$('[data-li-card-tab]',card.tabs).forEach(el=>el.onclick=()=>{
      card.tab=el.dataset.liCardTab;renderCard();$(`[data-li-card-tab="${card.tab}"]`,card.tabs)?.focus();
      if(card.tab!=='crm'){ensure();const d=state.details.get(String(card.project.id));if(!d?.loading&&configured())void loadDetail(card.project.id);}
    });
    wireTabKeys(card.tabs,'data-li-card-tab');
    if(focusedTab)$(`[data-li-card-tab="${focusedTab}"]`,card.tabs)?.focus();
    card.crm.hidden=card.tab!=='crm';card.mount.hidden=card.tab==='crm';if(card.tab==='crm')return;
    const detail=state.details.get(String(card.project.id)),lead=detail?.lead||leadOf(card.project.id),status=detail?.error||card.error;
    card.mount.setAttribute('aria-busy',String(detail?.loading===true));
    const disabled=!canEdit()||!configured()||!state.snapshot||state.busy||lead?.excluded||lead?.opted_out;
    const head=`<div class="li-card-heading"><h3>${card.tab==='research'?'Исследование компании':card.tab==='materials'?'Материалы для общения':card.tab==='audit'?'Проверка сайта':card.tab==='demo'?'Концепт сайта':'Ответы и история'}</h3>${card.tab==='research'?`<div class="row-inline">${button('Quick Scan','enqueue','data-kind="quick"',disabled)}${button('Deep Research','enqueue','data-kind="deep"',disabled||!canRunDeep(),true)}</div><p class="mut li-caption">Глубокое исследование доступно при любом приоритете. Актуальные результаты используются повторно.</p>${usesPlan()&&(state.snapshot.settings.aiEnabled||!canRunDeep())?`<p class="li-message">${canRunDeep()?'Подписка ChatGPT. Расходует лимиты твоей подписки.':'Ручной Deep Research с личной подпиской ChatGPT доступен только её владельцу.'} ${usageLink()}</p>`:''}${researchOf(lead)&&canEdit()?`<label class="li-checkbox"><input type="checkbox" id="liForceResearch"${card.forceResearch?' checked':''}${disabled?' disabled':''}>Обновить сохранённое исследование</label><p class="mut li-caption">Новая проверка учитывается в лимитах и бюджете.</p>`:''}`:''}</div>`;
    if(!configured()){card.mount.innerHTML=head+message('Сервис исследований ещё не подключён. После развёртывания здесь будут результаты, источники и материалы.');return;}
    if(detail?.loading&&!detail.loaded){card.mount.innerHTML=head+message('Загружаем карточку исследования…');return;}
    card.mount.innerHTML=head+(detail?.loading?message('Обновляем карточку…'):'')+(status?message(status,'error')+limitAction(detail?.error?detail.errorCode:card.errorCode):'')+(card.notice?message(card.notice):'')+(detail?.error?button('Повторить загрузку','reload-detail'):'')+
      (card.tab==='research'?researchView(lead,detail):card.tab==='audit'?auditView(lead,detail):card.tab==='demo'?demoView(lead,detail):card.tab==='materials'?materialsView(lead):historyView(lead,detail));
    wireActions(card.mount);wireCardForms(card,lead);
    const preview=$('#liDemoPreview',card.mount);if(preview&&lead?.demo?.html)preview.srcdoc=lead.demo.html;
    $$('details',card.mount).forEach(el=>{if(openSections.has($('summary',el)?.textContent))el.open=true;});
    if($('#drawer'))$('#drawer').scrollTop=scroll;
  }
  function researchView(lead,detail){
    const research=researchOf(lead),jobs=arr(detail?.jobs).filter(activeJob),score=lead?.score||research?.score;
    let html=lead?.excluded?message('Компания исключена из автоматической и ручной обработки. Изменить это можно в разделе «История».'):'';
    if(jobs.length)html+=`<div class="li-mini-jobs">${jobs.map(j=>`<div>${badge(j.kind==='demo'?'Демо сайта':j.kind==='deep'?'Deep Research':'Quick Scan')} ${esc(statusLabel(j.status))}</div>`).join('')}</div>`;
    if(!research)return html+empty('Исследования пока нет','Запусти Quick Scan для первичной проверки или Deep Research для подробного исследования. Отсутствие оценки ничего не говорит о качестве компании.');
    const business=research.business||{},site=research.officialSite||{},signals=arr(research.signals),opportunities=arr(research.opportunities);
    const industry=business.industry==='unknown'?'':business.industry;
    const audience=Array.isArray(business.audience)?business.audience.filter(value=>typeof value==='string'&&value.trim()).join(', '):typeof business.audience==='string'?business.audience.trim():'';
    const siteLabel=site.status==='verified'?'Официальный сайт':site.status==='candidate'?'Сайт-кандидат':'Сайт';
    html+=`<div class="li-research-meta">${badge(statusLabel(lead?.status||research.status),research.status)}<span>${research.kind==='curated'?'Подборка по открытым источникам':research.kind==='deep'?'Deep Research':'Quick Scan'}</span><span>Проверено: ${esc(date(lead?.checked_at||research.checkedAt))}</span></div>
      <p class="mut li-caption">Обновить до ${esc(date(lead?.expires_at||research.expiresAt))}</p>
      <div class="li-business"><h4>${esc(INDUSTRY[industry]||industry||'Отрасль не определена')}</h4><p>${esc(business.description||'Недостаточно данных для описания бизнеса.')}</p>${arr(business.services).length?`<p><b>Услуги:</b> ${esc(business.services.join(', '))}</p>`:''}${audience?`<p><b>Аудитория:</b> ${esc(audience)}</p>`:''}
      <p><b>${siteLabel}:</b> ${site.url?safeLink(site.url):site.status==='not_found'?'Собственный сайт не найден':site.status==='social_only'?'Только соцсети / мини-страница':'Не подтверждён'}<br><span class="mut">${esc(site.reason||'')} · уверенность ${confidence(site.confidence)}</span></p></div>`;
    if(score)html+=`<section class="li-score"><h4>Приоритет ${badge(PRIORITY[score.priority]||'Не определён',score.priority)}</h4><p>${score.priority==='unknown'?'Данных недостаточно для надёжной оценки.':`<strong class="li-score-value">${Number(score.total)||0}</strong> из 100 · ${score.method==='curated_heuristic'?'оценка для порядка работы, не вероятность покупки':'оценка основана на измеримых факторах'}`}</p><details class="li-details"><summary>Почему такая оценка</summary><div class="li-score-parts">${(Array.isArray(score.components)?score.components:Object.entries(score.components||{}).map(([id,c])=>typeof c==='object'?{id,...c}:{id,value:c})).map(c=>`<div><b>${esc(c.label||WEIGHTS[c.id]||c.id)}</b><span>${esc(c.value??0)} / ${esc(c.max??'—')}</span><p>${esc(c.reason||'Причина не указана')}</p></div>`).join('')}</div>${arr(score.reasons).length?`<ul>${score.reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul>`:''}</details>${servicesOf(lead).length?`<h4>Подходящие услуги Vertux</h4><ul class="li-service-list">${servicesOf(lead).map(s=>`<li><b>${esc(s.label||SERVICES[s.id]||s.id)}</b>${s.reason?`<p>${esc(s.reason)}</p>`:''}</li>`).join('')}</ul>`:''}</section>`;
    html+=`<section class="li-research-section"><h4>Подтверждённые сигналы</h4>${signals.length?signals.map(evidenceItem).join(''):message('Подтверждённых сигналов пока недостаточно.')}</section>
      <section class="li-research-section"><h4>Возможности для обсуждения</h4><p class="mut">Гипотезы требуют проверки в разговоре с компанией.</p>${opportunities.length?opportunities.map(evidenceItem).join(''):message('Обоснованных возможностей пока не найдено.')}</section>`;
    if(arr(research.limitations).length)html+=`<section class="li-research-section"><h4>Что осталось неизвестным</h4><ul>${research.limitations.map(v=>`<li>${esc(typeof v==='string'?v:v.message||v.label||'Есть ограничения проверки')}</li>`).join('')}</ul></section>`;
    html+=`<details class="li-details"><summary>Страницы и технические данные</summary>${arr(research.pages).map(p=>`<div class="li-page-source">${safeLink(p.url,p.title||p.url)}<small>Проверено: ${esc(date(p.checkedAt))}</small></div>`).join('')||'<p class="mut">Страницы недоступны.</p>'}${arr(research.technologies).length?`<p><b>Технологии:</b> ${esc(research.technologies.map(t=>typeof t==='string'?t:t.name||t.label).join(', '))}</p>`:''}${technicalView(research.technical)}</details>`;
    return html;
  }
  function evidenceItem(item){return `<article class="li-evidence"><div><b>${esc(item.label||item.title||'Наблюдение')}</b>${item.hypothesis?badge('Гипотеза','partial'):badge('Сигнал')}</div><p class="mut li-caption">Уверенность: ${confidence(item.confidence)}</p><details><summary>Основание · ${arr(item.evidence).length} ${arr(item.evidence).length===1?'источник':'источника'}</summary>${arr(item.evidence).map(e=>`<blockquote>${esc(e.quote||'Цитата не предоставлена')}<footer>${safeLink(e.url)}<span>${esc(date(e.checkedAt))} · уверенность ${confidence(e.confidence)}</span></footer></blockquote>`).join('')||'<p class="mut">Подтверждение не предоставлено. Не используй это как установленный факт.</p>'}</details></article>`;}
  function technicalView(technical){
    if(!technical||!Object.keys(technical).length)return '<p class="mut">Измеренные технические показатели не предоставлены.</p>';
    const labels={httpStatus:'HTTP-статус',responseTimeMs:'Ответ, мс',loadTimeMs:'Загрузка, мс',title:'Заголовок',description:'Описание',mobile:'Мобильная проверка',https:'HTTPS',rendered:'Браузерный рендеринг',performance:'Производительность',accessibility:'Доступность',seo:'SEO'};
    const rows=Object.entries(technical).filter(([key,v])=>labels[key]&&['string','number','boolean'].includes(typeof v)).map(([key,v])=>[labels[key],typeof v==='boolean'?(v?'Да':'Нет'):v]);
    if(technical.browser)rows.push(['Браузерное чтение',({not_needed:'Не потребовалось',needed:'Нужно для чтения сайта',rendered:'Выполнено',incomplete:'Получены неполные данные',unavailable:'Недоступно'})[technical.browser]||'Состояние не подтверждено']);
    if(technical.robots)rows.push(['Правила обхода',technical.robots==='respected'?'Учтены':'Состояние не подтверждено']);
    const psi=technical.pagespeed||technical.pageSpeed;
    return (rows.length?countRows(rows):'')+(psi?`<p><b>PageSpeed:</b> ${esc(({not_configured:'Измерение не подключено',unavailable:'Измерение недоступно',measured:'Измерено'})[psi.status]||'Данные не подтверждены')}${Number.isFinite(psi.performance)?' · '+Math.round(psi.performance)+'/100':''}${psi.checkedAt?' · '+esc(date(psi.checkedAt)):''}</p>`:'<p class="mut">Измерение PageSpeed не предоставлено. Оценка скорости не предполагается.</p>');
  }
  function auditView(lead,detail){
    const a=researchOf(lead)?.audit,findings=arr(a?.findings),working=arr(detail?.jobs).some(j=>j.kind==='deep'&&activeJob(j));
    const disabled=!canEdit()||!canRunDeep()||state.busy||lead?.excluded||lead?.opted_out||working;
    return `<p>Конкретные наблюдения с адресом страницы, датой, шагами проверки и вариантом исправления. Правовые вопросы отмечаются как требующие проверки применимости.</p><div class="row-inline">${button(working?'Проверка выполняется':'Проверить сайт','audit-site','',disabled,true)}${button('Скачать весь пакет .zip','download-kit')}</div><p class="mut li-caption">Новая проверка использует глубокое исследование. ${usesPlan()&&state.snapshot?.settings?.aiEnabled?'AI-материалы расходуют лимиты подключённой подписки.':''}</p>
      ${!a||a.status!=='completed'?message('Замеры сайта ещё не получены. Сохраняем статус «не проверено», пока не удастся прочитать и подтвердить сайт компании.'):message('Проверено '+date(a.checkedAt)+'. Страниц: '+arr(a.pages).length+'. Наблюдений: '+findings.length+'.')}
      ${a?.legalReviewDue?message('Справочник правовых норм требует обновления. Перепроверь редакцию перед использованием отчёта.','error'):''}
      ${findings.map(f=>`<article class="li-audit-finding"><div class="li-section-head"><h4>${esc(f.title)}</h4>${badge(f.certainty==='observed'?'Наблюдение':'Проверить вручную',f.certainty==='observed'?'partial':'unknown')}</div><p>${esc(f.observation)}</p><p>${safeLink(f.url)} · ${esc(date(f.checkedAt))}</p><details class="li-details"><summary>Проверка и исправление</summary><p><b>Как воспроизвести:</b> ${esc(f.reproduce)}</p><p><b>Что сделать:</b> ${esc(f.fix)}</p>${f.law?`<p><b>Норма:</b> ${safeLink(f.law.url,f.law.title)}</p><p>${esc(f.law.condition)}</p><p class="mut">Редакция проверялась: ${esc(f.law.reviewedAt)}</p>`:''}</details></article>`).join('')}
      <details class="li-details" open><summary>Что удалось проверить</summary>${arr(a?.pages).map(p=>`<p>${safeLink(p.url)} · ${esc(date(p.checkedAt))}</p>`).join('')}${arr(a?.limitations).map(l=>`<p class="mut">${esc(l)}</p>`).join('')||'<p class="mut">Проверка сайта ещё не выполнялась. Отсутствие замечаний не подтверждает соответствие всем требованиям.</p>'}</details>`;
  }
  function demoView(lead,detail){
    const demo=lead?.demo,jobs=arr(detail?.jobs).filter(j=>j.kind==='demo'),job=jobs.find(j=>activeJob(j)||j.status==='paused')||jobs[0],s=state.snapshot?.settings||{};
    const model=arr(chatgpt().models).find(m=>m.id===s.demoModel),blocked=!canEdit()||!canRunDeep()||!usesPlan()||!s.aiEnabled||!model||lead?.excluded||lead?.opted_out||job&&activeJob(job);
    return `<p>Концепт с мобильной версией, информацией о компании и контактами. AI выбирает композицию и порядок подтверждённых фактов; фотографии и условия согласуются отдельно.</p><p>Модель демо: <b>${esc(model?.label||s.demoModel||'не выбрана')}</b>. Её можно изменить отдельно от исследования в настройках AI.</p>
      ${!usesPlan()||!s.aiEnabled||!model?message('Для демо подключи подписку ChatGPT, включи AI и выбери модель демо в настройках исследований.'):message('Расходует лимиты подключённой подписки ChatGPT. Запуск — по кнопке, без автоматического повтора.')}
      <div class="row-inline">${button(demo?'Подготовить новый вариант':'Подготовить демо','generate-demo','',blocked,true)}${demo?.html?button('Скачать сайт .html','download-demo')+button('Скачать весь пакет .zip','download-kit'):''}</div>
      ${job?`<p role="status">Демо: ${esc(statusLabel(job.status))}${job.error_code?' · '+esc(errorLabel(job.error_code)):''}</p>`:''}
      ${demo?.html?`<p class="mut li-caption">Сохранённый вариант: ${esc(date(demo.checkedAt))} · ${esc(demo.ai?.model||'модель не указана')}. Заявки не отправляются.</p><iframe id="liDemoPreview" title="Предпросмотр концепта сайта" sandbox="" referrerpolicy="no-referrer"></iframe>`:empty('Демо пока не подготовлено','Можно подготовить сайт и для компании, у которой своего сайта ещё нет. Контакты берутся из карточки; отсутствующие сведения не выдумываются.')}`;
  }
  function getDraft(projectId,lead){
    const id=String(projectId),existing=state.drafts.get(id),revision=Number(lead?.materials_revision)||0,full=!!lead&&Object.hasOwn(lead,'materials');if(!existing||(!existing.dirty&&(existing.revision!==revision||(existing.provisional&&full)))){const m=lead?.materials||{};state.drafts.set(id,{revision,dirty:false,provisional:!full,materials:Object.fromEntries([...MATERIALS.map(([k])=>[k,String(m[k]||'')]),['followUps',arr(m.followUps).slice(0,3).map(String)]])});}return state.drafts.get(id);
  }
  function materialsView(lead){
    const draft=getDraft(state.card.project.id,lead),editable=canEdit(),hasContent=MATERIALS.some(([k])=>draft.materials[k]);
    return `<p class="mut">Проверь факты и тон перед использованием. ${researchOf(lead)?.ai?.status==='generated'?'AI помог выбрать услугу и аргументы по проверенным источникам. Текст собран из шаблонов с доказательствами.':'Материалы основаны на доступных данных; наличие текста не подтверждает AI-генерацию.'}</p>
      ${!hasContent?message('Материалы пока не подготовлены. Запусти Deep Research или заполни их вручную.'):''}
      <details class="li-details li-playbook" open><summary>Сценарий менеджера: варианты разговора</summary>${window.VCLeadKit.playbook(state.card.project,researchOf(lead)).map((step,i)=>`<details class="li-details"${i<2?' open':''}><summary>${esc(step.title)}</summary><p class="li-preserve-lines">${esc(step.body)}</p></details>`).join('')}<p class="mut">Стоимость рассчитывается индивидуально. Согласованную сумму и объём внеси в поле «Предложение Vertux» ниже.</p></details><form id="liMaterialsForm"><fieldset${!editable?' disabled':''}>${MATERIALS.map(([key,label,max],index)=>`<details class="li-details"${index<2?' open':''}><summary>${label}</summary><label class="li-editor-label" for="liMaterial_${key}">${label}</label>${key==='emailSubject'?`<input id="liMaterial_${key}" data-material="${key}" maxlength="${max}" value="${esc(draft.materials[key])}">`:`<textarea id="liMaterial_${key}" data-material="${key}" rows="${key==='callScript'?8:5}" maxlength="${max}">${esc(draft.materials[key])}</textarea>`}</details>`).join('')}
      <details class="li-details"><summary>Последующие письма</summary>${[0,1,2].map(i=>`<label class="li-followup">Вариант ${i+1}<textarea data-followup="${i}" rows="4" maxlength="3000">${esc(draft.materials.followUps[i]||'')}</textarea></label>`).join('')}</details></fieldset>
      <div class="li-form-footer">${editable?`<button class="btn gold" type="submit"${state.busy?' disabled':''}>Сохранить материалы</button>`:''}${button('Скопировать всё','copy-materials')}${button('Скачать .txt','download-materials')}${button('Скачать весь пакет .zip','download-kit')}${button('Загрузить сохранённое','reload-materials')}</div><p id="liMaterialsMessage" class="mut" role="status">${draft.dirty?'Есть несохранённые изменения':'Версия '+draft.revision+' · черновики, без отправки'}</p></form>`;
  }
  function historyView(lead,detail){
    const replies=arr(detail?.replies),draft=state.card.policyDraft,permission=draft?.contactPermission||lead?.contact_permission||{},editable=canEdit();
    return `<p class="mut">Почтовый ящик не подключён. Добавь полученный ответ вручную: система сохранит классификацию, предложенный ответ и следующий шаг. Классификация помогает менеджеру и может ошибаться.</p>
      ${editable?`<form id="liReplyForm"><label for="liReplyText" class="field-label">Фактический ответ компании</label><textarea id="liReplyText" required maxlength="6000" rows="4" placeholder="Вставь ответ без лишних персональных данных">${esc(state.card.replyText)}</textarea><button type="submit" class="btn"${state.busy?' disabled':''}>Сохранить и классифицировать</button></form>`:''}
      ${replies.length?`<div class="li-replies">${replies.map(reply=>`<article class="li-reply">${badge(REPLIES[reply.classification]||REPLIES.unknown,reply.classification==='refusal'?'failed':'')}<span class="mut li-caption">${esc(date(reply.created_at||reply.at))}</span><blockquote>${esc(reply.text||reply.input_text||'')}</blockquote><p><b>Предлагаемый ответ:</b><br>${esc(reply.suggestedReply||reply.suggested_reply||'Нужен ответ менеджера')}</p><p><b>Следующий шаг:</b> ${esc(reply.nextAction||reply.next_action||'Уточнить вручную')}</p>${reply.optOut?message('Отказ от контактов сохранён. Компания исключена из коммуникации.'):''}</article>`).join('')}</div>`:empty('Входящих ответов пока нет','Здесь будет история добавленных ответов и предложенных действий.')}
      <details class="li-details"><summary>Основание контакта и исключения</summary><form id="liPolicyForm"><fieldset${!editable?' disabled':''}>
        <label class="li-checkbox"><input type="checkbox" name="excluded"${(draft?.excluded??lead?.excluded)?' checked':''}>Исключить компанию из исследований</label>
        <label class="li-checkbox"><input type="checkbox" name="optedOut"${(draft?.optedOut??lead?.opted_out)?' checked':''}>Компания отказалась от контактов</label>
        <label class="li-policy-label">Основание контакта<select name="basis">${[['','Не зафиксировано'],['consent','Зафиксированное согласие'],['customer_request','Запрос компании'],['manual_review','Требует ручной проверки']].map(([k,v])=>option(k,v,permission.basis||'')).join('')}</select></label>
        <label class="li-policy-label">Подтверждение и контекст<textarea name="note" rows="3" maxlength="1000">${esc(permission.note||'')}</textarea></label></fieldset>
        <p class="mut li-caption">Дата записи: ${permission.recordedAt?esc(date(permission.recordedAt)):'не зафиксирована'}. Запись основания сама по себе не разрешает автоматическую отправку.</p>
        ${editable?'<button class="btn" type="submit">Сохранить правила контакта</button>':''}</form></details>
      <details class="li-details"><summary>События исследования</summary>${eventsView(arr(detail?.events))}</details>
      ${canConfigure()?`<details class="li-details li-danger"><summary>Удаление данных исследования</summary><p>Удаляются исследования, материалы и ответы этой компании. CRM-карточка и история звонков сохраняются.</p>${button('Удалить исследование','purge')}</details>`:''}`;
  }
  function eventsView(events){
    const labels={enqueued:'Задача добавлена',enqueue_requested:'Запрошено исследование',queued:'Задача добавлена',completed:'Исследование завершено',failed:'Ошибка исследования',retry:'Запланирован повтор',paused:'Приостановлено',resumed:'Обработка продолжена',cancelled:'Задача отменена',materials_saved:'Материалы сохранены',materials_edited:'Материалы изменены',policy_saved:'Правила контакта сохранены',policy_changed:'Правила контакта изменены',reply_classified:'Ответ классифицирован',settings_saved:'Настройки изменены',settings_changed:'Настройки изменены',claimed:'Задача запущена',retried:'Повторный запуск',purged:'Данные исследования удалены',privacy_purge:'Данные исследования удалены',job_pause:'Задача приостановлена',job_resume:'Задача возобновлена',job_retry:'Задача запущена повторно',job_cancel:'Задача отменена',scheduled:'Выполнен плановый запуск',lease_expired:'Восстановление прерванной задачи',company_archived:'Компания перенесена в архив',company_restored:'Компания возвращена в работу',curated_import:'Добавлена подборка по открытым источникам'};
    return events.length?`<ol class="li-events">${events.map(event=>`<li><b>${esc(labels[event.type||event.kind||event.event]||event.message||'Событие исследования')}</b><time>${esc(date(event.created_at||event.at))}</time>${event.project_id?`<span>${esc(projects().find(p=>String(p.id)===String(event.project_id))?.company||'')}</span>`:''}</li>`).join('')}</ol>`:'<p class="mut">Событий пока нет.</p>';
  }
  function wireCardForms(card,lead){
    const root=card.mount,materials=$('#liMaterialsForm',root);
    const force=$('#liForceResearch',root);if(force)force.onchange=()=>card.forceResearch=force.checked;
    if(materials){
      const draft=getDraft(card.project.id,lead);
      materials.oninput=event=>{const el=event.target;if(el.dataset.material)draft.materials[el.dataset.material]=el.value;if(el.dataset.followup!==undefined)draft.materials.followUps[Number(el.dataset.followup)]=el.value;draft.dirty=true;$('#liMaterialsMessage',materials).textContent='Есть несохранённые изменения';};
      materials.onsubmit=async event=>{event.preventDefault();if(!canEdit()||!materials.reportValidity())return;await perform('materials',{projectId:card.project.id,revision:draft.revision,materials:{...draft.materials,followUps:draft.materials.followUps.filter(v=>v.trim())}},'Материалы сохранены.',result=>{state.drafts.delete(String(card.project.id));applyLead(result.lead);});};
    }
    const reply=$('#liReplyForm',root);if(reply){$('#liReplyText',reply).oninput=event=>card.replyText=event.target.value;reply.onsubmit=async event=>{
      event.preventDefault();if(!canEdit()||!reply.reportValidity())return;
      const text=$('#liReplyText',reply).value.trim();if(!text)return;
      await perform('reply',{projectId:card.project.id,text},'Ответ сохранён. Проверь предложенный следующий шаг.',()=>{card.replyText='';});
    };}
    const policy=$('#liPolicyForm',root);if(policy){policy.oninput=()=>card.policyDraft={excluded:policy.elements.excluded.checked,optedOut:policy.elements.optedOut.checked,contactPermission:{basis:policy.elements.basis.value,note:policy.elements.note.value}};policy.onsubmit=async event=>{
      event.preventDefault();if(!canEdit()||!policy.reportValidity())return;
      const basis=policy.elements.basis.value.trim(),note=policy.elements.note.value.trim();
      if(lead?.opted_out&&!policy.elements.optedOut.checked&&(!['consent','customer_request'].includes(basis)||!note)){card.error='Чтобы снять отказ, зафиксируй новое согласие или запрос компании и его подтверждение.';policy.querySelector('button[type=submit]').focus();renderCard();return;}
      await perform('policy',{projectId:card.project.id,excluded:policy.elements.excluded.checked,optedOut:policy.elements.optedOut.checked,contactPermission:basis?{basis,note,recordedAt:new Date().toISOString()}:null},'Правила контакта сохранены.',result=>{card.policyDraft=null;applyLead(result.lead);});
    };}
  }
  function applyLead(lead){
    if(!lead)return;const id=String(lead.project_id),detail=state.details.get(id)||{};state.details.set(id,{...detail,lead,loaded:true});
    if(state.snapshot){const leads=arr(state.snapshot.leads),index=leads.findIndex(l=>String(l.project_id)===id);if(index<0)leads.push(lead);else leads[index]=lead;state.snapshot.leads=leads;}
  }
  async function perform(action,payload,notice,callback){
    if(state.busy)return false;
    state.busy=true;state.notice='';state.noticeJobId=null;state.error='';state.errorCode=null;if(state.card){state.card.error='';state.card.errorCode=null;state.card.notice='';state.card.noticeJobId=null;}
    notify();renderCard();
    try{
      const result=await window.VC.leadCall(action,payload);callback?.(result);
      const text=typeof notice==='function'?notice(result):notice;
      const noticeJobId=action==='enqueue'&&result.job&&(activeJob(result.job)||result.job.status==='paused')?result.job.id:null;
      state.notice=text;state.noticeJobId=noticeJobId;if(state.card){state.card.notice=text;state.card.noticeJobId=noticeJobId;}
      await refresh(true);
      if(payload.projectId&&action!=='purge')await loadDetail(payload.projectId,true);
      return true;
    }catch(error){if(payload.projectId&&state.card){state.card.error=friendlyError(error);state.card.errorCode=error.code;}else{state.error=friendlyError(error);state.errorCode=error.code;}return false;}
    finally{state.busy=false;notify();renderCard();}
  }
  function materialsText(){
    const card=state.card,draft=getDraft(card.project.id,state.details.get(String(card.project.id))?.lead||leadOf(card.project.id));
    return [card.project.company,'Черновики для проверки менеджером',...MATERIALS.map(([key,label])=>label+'\n'+draft.materials[key]),...draft.materials.followUps.map((text,i)=>'Последующее письмо '+(i+1)+'\n'+text)].join('\n\n');
  }
  async function copyMaterials(){
    try{await navigator.clipboard.writeText(materialsText());state.card.notice='Материалы скопированы.';state.card.noticeJobId=null;}
    catch(_){state.card.error='Не удалось скопировать. Скачай .txt или выдели текст вручную.';}
    renderCard();
  }
  function wireActions(root){
    $$('[data-li-open]',root).forEach(el=>el.onclick=e=>{e.stopPropagation();state.context.openProject(el.dataset.liOpen);if(el.dataset.liOpenTab)$(`[data-li-card-tab="${el.dataset.liOpenTab}"]`)?.click();});
    $$('[data-li-action]',root).forEach(el=>el.onclick=async()=>{
      const action=el.dataset.liAction,card=state.card;
      if(action==='refresh'){await refresh();return;}
      if(action==='center'){state.context.go('intelligence');return;}
      if(action==='archive-list'||action==='active-list'){state.filters.batch='';state.context.go(action==='archive-list'?'archive':'projects');return;}
      if(action==='archive-batch'){await archiveProjects(projects().filter(p=>Boolean(p.archived_at)===state.archiveView&&p.lead_batch_id===state.filters.batch),!state.archiveView);return;}
      if(action==='archive-one'){await archiveProjects([card.project],!card.project.archived_at);state.context.openProject(card.project.id);return;}
      if(action==='settings-tab'){state.tab='settings';notify();return;}
      if(action==='reset-filters'){Object.keys(state.filters).forEach(k=>state.filters[k]='');notify();return;}
      if(action==='reset-settings'){state.settingsDraft=null;notify();return;}
      if(action==='chatgpt-status'&&chatgpt().canManage===true){
        await perform('chatgpt_status',{},'Состояние подключения обновлено.',result=>{if(result.chatgpt)state.snapshot.capabilities.chatgpt=result.chatgpt;});return;
      }
      if(action==='chatgpt-disconnect'&&chatgpt().canManage===true){
        if(!confirm('Отключить подписку ChatGPT от исследований? Новые AI-запросы через неё будут остановлены. Сохранённые исследования останутся.'))return;
        await perform('chatgpt_disconnect',{},'Подписка ChatGPT отключена. AI-генерация выключена.',result=>{if(result.chatgpt)state.snapshot.capabilities.chatgpt=result.chatgpt;if(state.settingsDraft)state.settingsDraft.aiEnabled=false;});return;
      }
      if(action==='reload-detail'){await loadDetail(card.project.id);return;}
      if(action==='copy-materials'){await copyMaterials();return;}
      if(['download-kit','download-demo'].includes(action)){
        const lead=state.details.get(String(card.project.id))?.lead,draft=getDraft(card.project.id,lead);
        if(!lead){card.error='Сначала загрузи карточку компании.';renderCard();return;}
        if(action==='download-demo'&&!lead.demo?.html)return;
        const blob=action==='download-demo'?new Blob([lead.demo.html],{type:'text/html;charset=utf-8'}):new Blob([window.VCLeadKit.zipFiles(window.VCLeadKit.packageFiles(card.project,lead,draft.materials))],{type:'application/zip'});
        const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=card.project.company.replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,80)+(action==='download-demo'?'-концепт.html':'-материалы.zip');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
      }
      if(action==='download-materials'){
        const url=URL.createObjectURL(new Blob([materialsText()],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='Материалы — '+card.project.company.replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,80)+'.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
      }
      if(action==='reload-materials'){
        const draft=state.drafts.get(String(card.project.id));if(draft?.dirty&&!confirm('Заменить несохранённый текст последней сохранённой версией?'))return;
        state.drafts.delete(String(card.project.id));await loadDetail(card.project.id);renderCard();return;
      }
      if(!canEdit())return;
      if(action==='audit-site'||action==='generate-demo'){
        if(!canRunDeep())return;
        await perform('enqueue',{projectId:card.project.id,kind:action==='generate-demo'?'demo':'deep',force:true},result=>result.job?`${action==='generate-demo'?'Демо':'Проверка сайта'}: ${statusLabel(result.job.status)}. Результат появится в этой вкладке.`:'Новая задача не создана.');return;
      }
      if(action==='enqueue'){
        if(el.dataset.kind==='deep'&&!canRunDeep())return;
        await perform('enqueue',{projectId:card.project.id,kind:el.dataset.kind,force:card.forceResearch===true},result=>{
          if(!result.job||result.job.status==='completed')return 'Исследование ещё актуально. Используем сохранённый результат; новая задача не создана.';
          return enqueueNotice(result.job);
        },()=>{card.forceResearch=false;});return;
      }
      if(action==='job'){
        if(['resume','retry'].includes(el.dataset.jobOp)&&!canResumeJobs())return;
        await perform('job',{jobId:el.dataset.jobId,operation:el.dataset.jobOp},'Состояние задачи обновлено.');return;
      }
      if(action==='toggle-pause'&&canConfigureResearch()){await perform('settings',{settings:{paused:!state.snapshot.settings.paused}},state.snapshot.settings.paused?'Обработка продолжена.':'Обработка приостановлена.');return;}
      if(action==='purge'&&canConfigure()){
        if(!confirm('Удалить исследования, материалы и входящие ответы компании «'+card.project.company+'»? CRM-карточка останется.'))return;
        await perform('purge',{projectId:card.project.id},'Данные исследования удалены. CRM-карточка сохранена.',()=>{state.details.delete(String(card.project.id));state.drafts.delete(String(card.project.id));card.tab='research';});
      }
    });
  }
  function wireTabKeys(root,attribute){
    const tabs=$$(`[${attribute}]`,root);
    tabs.forEach((tab,index)=>tab.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      tabs[next].click();
    });
  }
  function openCardTab(id,tab){
    state.context.openProject(id);
    if(state.card&&String(state.card.project.id)===String(id)){state.card.tab=tab;renderCard();ensure();if(configured())void loadDetail(id);}
  }
  window.VCLead={init,refresh,center,wireCenter,listFilters,filterProjects,listCells,wireList,mountCard,openCardTab,archiveCardControls,wireArchiveCard:wireActions};
})();
