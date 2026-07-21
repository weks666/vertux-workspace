/* Vertux Workspace — логика приложения (vanilla JS, без сборки). */
(function(){
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
  const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const initials=s=>String(s||'?').trim().charAt(0).toUpperCase();
  const sum=(a,f)=>a.reduce((s,x)=>s+f(x),0);
  const plural=(n,a,b,c)=>{const m=n%100,k=n%10;return n+' '+(m>=11&&m<=14?c:k===1?a:k>=2&&k<=4?b:c);};
  const fmtMoney=n=>isFinite(n)&&n>0?Math.round(n).toLocaleString('ru-RU')+' ₽':'—';
  const moneyOf=p=>(p.raw&&typeof p.raw==='object'&&p.raw.money)||null;
  const pctOf=m=>(m&&m.percent!=null)?Number(m.percent):window.VC.CONFIG.managerPercent;
  const nextCallOf=p=>(p.raw&&typeof p.raw==='object'&&p.raw.next_call)||null;
  const isDue=p=>{const nc=nextCallOf(p);if(!nc)return false;
    const eod=new Date();eod.setHours(23,59,59,999);return new Date(nc)<=eod;};
  const fmtDay=iso=>{const d=new Date(iso);return d.getDate()+'.'+String(d.getMonth()+1).padStart(2,'0');};

  const ICONS={
    dashboard:'M3 3h7v8H3V3zm0 10h7v8H3v-8zm10-10h8v5h-8V3zm0 7h8v11h-8V10z',
    projects:'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
    calls:'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
    import:'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
    team:'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20a6 6 0 0 1 12 0M14 20a6 6 0 0 1 8-5',
    shield:'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z M9 12l2 2 4-4',
    money:'M12 3v18M8 7h6a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h7',
    trainer:'M4 14a8 8 0 0 1 16 0M4 14v3a2 2 0 0 0 2 2h1v-6H4m16 0h-3v6h1a2 2 0 0 0 2-2v-4M14 21h-2',
  };
  const svg=p=>`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${p}"/></svg>`;

  const NAV=[
    {id:'dashboard',label:'Дашборд'},
    {id:'projects', label:'Проекты'},
    {id:'calls',    label:'Звонки'},
    {id:'trainer',  label:'Тренер'},
    {id:'money',    label:'Деньги', finance:true},
    {id:'import',   label:'Импорт'},
    {id:'team',     label:'Команда'},
    {id:'shield',   label:'Shield'},
  ];
  const SUB={
    dashboard:'что происходит в агентстве',
    projects:'база лидов — стадии, заметки, демки',
    calls:'журнал звонков, выработка и аналитика',
    trainer:'live-суфлёр, разбор звонков, тренажёр',
    money:'выручка, доли команды, прогноз',
    import:'залить CSV/XLSX из парсера или Рокфеллера',
    team:'доступы и приглашения',
    shield:'защита наших виджетов',
  };

  const TYPE={ creation:['t-new','с нуля'], redesign:['t-re','редизайн'] };
  /* Воронка продаж. cls — цвет стадии, pr — прогресс. */
  const STAGES={
    new:            {label:'новый',            cls:'s-new',  pr:5},
    contacted:      {label:'связались',        cls:'s-cont', pr:25},
    demo_sent:      {label:'демка ушла',       cls:'s-demo', pr:50},
    agreed:         {label:'согласовано',      cls:'s-agr',  pr:75},
    paid:           {label:'оплачено',         cls:'s-paid', pr:100},
    refused:        {label:'отказ',            cls:'s-ref',  pr:0},
    not_interested: {label:'не интересно',     cls:'s-ni',   pr:0},
  };
  const FUNNEL=['new','contacted','demo_sent','agreed','paid'];
  const stageOf=p=>STAGES[p.stage]?p.stage:'new';
  const typeTag=t=>{const v=TYPE[t];return v?`<span class="tag ${v[0]}">${v[1]}</span>`:'<span class="mut">—</span>';};
  const rate=r=>{const n=Number(r);return isFinite(n)?n.toFixed(1):String(r);};
  const stagePill=p=>{const k=stageOf(p);return `<span class="pill ${STAGES[k].cls}"><i></i>${STAGES[k].label}</span>`;};

  /* Итоги звонка. stage — куда двигаем воронку, если это движение вперёд. */
  const OUTCOMES={
    talked:   {label:'Поговорили',   ic:'💬', stage:'contacted'},
    demo:     {label:'Просит демку', ic:'🎯', stage:'demo_sent'},
    callback: {label:'Перезвонить',  ic:'🔁', stage:'contacted'},
    no_answer:{label:'Не взяли',     ic:'📵', stage:null},
    refused:  {label:'Отказ',        ic:'✖',  stage:'refused'},
  };

  let DATA=null, USER=null, view='dashboard', pFilter='all', q='';

  /* ---------- даты ---------- */
  const dayKey=d=>{const x=new Date(d);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');};
  const DOW=['вс','пн','вт','ср','чт','пт','сб'];
  function ago(iso){
    if(!iso) return '—';
    const s=(Date.now()-new Date(iso).getTime())/1000;
    if(s<90) return 'только что';
    if(s<5400) return Math.round(s/60)+' мин назад';
    if(s<86400) return Math.round(s/3600)+' ч назад';
    const d=Math.round(s/86400);
    return d===1?'вчера':plural(d,'день','дня','дней')+' назад';
  }
  /* Все звонки из всех лидов, свежие сверху. */
  function allCalls(){
    const out=[];
    DATA.projects.forEach(p=>window.VC.callsOf(p).forEach(c=>out.push({...c,p:p})));
    return out.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
  }
  /* Самый свежий звонок по времени — не по месту в массиве. */
  function lastCall(p){
    const c=window.VC.callsOf(p);
    return c.length?c.reduce((a,b)=>String(b.at)>String(a.at)?b:a):null;
  }

  /* ---------- графики ---------- */
  function barChart(items, empty, unit){
    if(!items.some(i=>i.n>0)) return `<div class="empty"><div class="e-ic">📞</div><div>${esc(empty)}</div></div>`;
    const max=Math.max(...items.map(i=>i.n),1);
    return `<div class="chart">${items.map(i=>`
      <div class="bar-wrap" title="${esc(i.full||i.d+': '+i.n)}">
        <div class="bar" style="height:${Math.max(i.n/max*100,i.n?4:0)}%"><span class="bv">${i.n}${unit||''}</span></div>
        <span class="bar-lbl">${esc(i.d)}</span></div>`).join('')}</div>`;
  }
  function callsByDay(days){
    const calls=allCalls(), map={};
    calls.forEach(c=>{ const k=dayKey(c.at); map[k]=(map[k]||0)+1; });
    const out=[];
    for(let i=days-1;i>=0;i--){
      const d=new Date(); d.setDate(d.getDate()-i);
      out.push({ d:DOW[d.getDay()]+' '+d.getDate(), full:dayKey(d), n:map[dayKey(d)]||0 });
    }
    return out;
  }
  function funnelBars(){
    const p=DATA.projects, total=p.length||1;
    return `<div class="funnel">${FUNNEL.map(k=>{
      const n=p.filter(x=>stageOf(x)===k).length;
      return `<div class="fn-row"><span class="fn-l">${STAGES[k].label}</span>
        <div class="fn-track"><div class="fn-fill ${STAGES[k].cls}" style="width:${Math.max(n/total*100,n?1.5:0)}%"></div></div>
        <b class="fn-n">${n}</b></div>`;
    }).join('')}
    <div class="fn-lost">${['refused','not_interested'].map(k=>{
      const n=p.filter(x=>stageOf(x)===k).length;
      return `<span>${STAGES[k].label}: <b>${n}</b></span>`;
    }).join('')}</div></div>`;
  }
  const kpi=(lbl,val,ic,note,dir)=>`<div class="kpi"><div class="k-ic">${svg(ic)}</div>
    <div class="k-lbl">${esc(lbl)}</div><div class="k-val">${val}</div>
    ${note?`<div class="k-delta ${dir||''}">${esc(note)}</div>`:''}</div>`;

  /* ---------- views ---------- */
  const V={};

  V.dashboard=()=>{
    const p=DATA.projects;
    const withScript=p.filter(x=>x.processed).length;
    const inWork=p.filter(x=>['contacted','demo_sent','agreed'].includes(stageOf(x))).length;
    const paid=p.filter(x=>stageOf(x)==='paid').length;
    const demos=p.filter(x=>x.demo).length;
    const calls=allCalls();
    const today=calls.filter(c=>dayKey(c.at)===dayKey(new Date())).length;
    const conv=p.length?Math.round(paid/p.length*1000)/10:0;
    const touched=p.filter(x=>stageOf(x)!=='new').length;
    const recent=p.slice().filter(x=>x.updated_at).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))).slice(0,6);
    const due=p.filter(isDue).sort((a,b)=>String(nextCallOf(a)).localeCompare(String(nextCallOf(b))));
    return `
    <div class="grid kpis">
      ${kpi('Лидов в базе',p.length,ICONS.projects,withScript+' со скриптом Рокфеллера')}
      ${kpi('Взяли в работу',touched,ICONS.calls,p.length?Math.round(touched/p.length*100)+'% базы':'')}
      ${kpi('Звонков сегодня',today,ICONS.calls,calls.length?'всего '+calls.length:'журнал пуст')}
      ${kpi('Демок сделано',demos,ICONS.import,inWork+' лидов в воронке')}
      ${kpi('Оплачено',paid,ICONS.money,'конверсия '+conv+'%',paid?'up':'')}
    </div>
    <div class="row-inline" style="margin-bottom:16px">
      <button class="btn gold" id="nextCallBtn">▶ Следующий звонок</button>
      <span class="mut" style="font-size:12.5px">сам выберу, кому звонить: сначала просроченные напоминания, потом свежие со скриптом</span>
    </div>
    ${due.length?`<div class="panel due-panel" style="margin-bottom:16px">
      <div class="panel-h"><h3>🔔 Пора перезвонить</h3><span class="sub">${plural(due.length,'лид ждёт','лида ждут','лидов ждут')} звонка</span></div>
      <div class="panel-b due-list">${due.slice(0,8).map(x=>{
        const overdue=new Date(nextCallOf(x))<new Date(new Date().setHours(0,0,0,0));
        return `<button class="due-item" data-open="${esc(x.id)}">
          <span class="d-day ${overdue?'late':''}">${fmtDay(nextCallOf(x))}</span>
          <span class="d-co">${esc(x.company)}</span>
          <span class="d-note">${esc(String(x.notes||'').slice(0,36))}</span>
          ${x.phone?`<span class="d-ph">${esc(x.phone)}</span>`:''}
        </button>`;}).join('')}</div>
    </div>`:''}
    <div class="cols">
      <div class="panel"><div class="panel-h"><h3>Звонки за две недели</h3>
        <span class="sub">${calls.length?plural(calls.length,'звонок','звонка','звонков')+' всего':'пишется сам, когда жмёшь «Набрать»'}</span></div>
        <div class="panel-b">${barChart(callsByDay(14),'Ещё ни одного звонка. Нажми «Набрать» у любого лида — журнал начнёт заполняться сам.')}</div></div>
      <div class="panel"><div class="panel-h"><h3>Воронка</h3><span class="sub">${p.length} лидов</span></div>
        <div class="panel-b">${funnelBars()}</div></div>
    </div>
    <div class="cols" style="margin-top:16px">
      <div class="panel"><div class="panel-h"><h3>Последние звонки</h3></div>
        <div class="panel-b">${calls.length?`<ul class="feed">${calls.slice(0,6).map(c=>`
          <li><div class="fi">${(OUTCOMES[c.out]||{ic:'📞'}).ic}</div>
            <div><div>${esc(c.p.company)} — ${esc((OUTCOMES[c.out]||{label:'набрали'}).label)}</div>
            <div class="ft">${esc(c.by||'')} · ${esc(ago(c.at))}</div></div></li>`).join('')}</ul>`
          :`<div class="empty"><div class="e-ic">📭</div><div>Звонков пока не было</div></div>`}</div></div>
      <div class="panel"><div class="panel-h"><h3>Недавно трогали</h3></div>
        <div class="panel-b">${recent.length?`<ul class="feed">${recent.map(x=>`
          <li><div class="fi">${initials(x.company)}</div>
            <div><div>${esc(x.company)} ${stagePill(x)}</div>
            <div class="ft">${esc(ago(x.updated_at))}${x.notes?' · '+esc(String(x.notes).slice(0,40)):''}</div></div></li>`).join('')}</ul>`
          :`<div class="empty"><div class="e-ic">🗂️</div><div>Пока ничего не меняли</div></div>`}</div></div>
    </div>`;
  };

  V.projects=()=>{
    const chips=[['all','Все'],['work','В работе'],['callback','🔔 Перезвонить'],['redesign','Редизайн'],['creation','С нуля'],
                 ['processed','Со скриптом'],['raw','Сырые'],['demo','С демкой'],['hot','Рейтинг 4.5+']];
    let list=DATA.projects.filter(p=>{
      if(pFilter==='all') return true;
      if(pFilter==='work') return ['contacted','demo_sent','agreed'].includes(stageOf(p));
      if(pFilter==='callback') return !!nextCallOf(p);
      if(pFilter==='processed') return !!p.processed;
      if(pFilter==='raw') return !p.processed;
      if(pFilter==='demo') return !!p.demo;
      if(pFilter==='hot') return (Number(p.rating)||0)>=4.5;
      return p.type===pFilter;
    });
    if(q) list=list.filter(p=>((p.company||'')+' '+(p.niche||'')+' '+(p.city||'')+' '+(p.notes||'')).toLowerCase().includes(q));
    const canEdit=!!(USER&&USER.can&&USER.can.edit);
    if(!DATA.projects.length) return `<div class="empty big"><div class="e-ic">📥</div>
      <div><b>В базе пусто.</b><br>Загрузи список из парсера или Рокфеллера в разделе «Импорт».</div></div>`;
    return `
    <div class="tbl-tools">
      ${chips.map(([k,l])=>`<button class="chip ${pFilter===k?'active':''}" data-filter="${k}">${l}</button>`).join('')}
      <span class="mut count">${list.length} из ${DATA.projects.length}</span>
    </div>
    <div class="panel tbl-wrap"><table class="data leads"><thead><tr>
      <th class="c-co">Компания</th>
      <th class="c-ty">Тип</th>
      <th class="c-st">Стадия</th>
      <th class="c-nt">Заметка</th>
      <th class="c-ra" title="Оценка компании в 2ГИС и число отзывов — берётся парсером. Высокая = живой бизнес, за репутацию держатся.">Рейтинг 2ГИС</th>
      <th class="c-ph">Телефон</th>
      <th class="c-dm">Демка</th>
    </tr></thead><tbody>
      ${list.slice(0,300).map(p=>{
        const k=stageOf(p), n=window.VC.callsOf(p).length;
        return `<tr data-id="${esc(p.id)}" class="${STAGES[k].cls}">
        <td class="c-co"><div class="co">
          <div class="logo ${STAGES[k].cls}">${initials(p.company)}</div>
          <div class="co-t"><span class="cn">${esc(p.company)}</span>
            <span class="csub">${esc(String(p.niche||'—').slice(0,38))}${p.city?' · '+esc(p.city):''}</span></div>
          ${isDue(p)?`<span class="due-badge" title="перезвонить ${fmtDay(nextCallOf(p))}">🔔 ${fmtDay(nextCallOf(p))}</span>`:''}
          ${n?`<span class="calls-badge" title="звонков: ${n}">${n}</span>`:''}
        </div></td>
        <td>${typeTag(p.type)}</td>
        <td>${canEdit?`<select class="stage-sel ${STAGES[k].cls}" data-stage="${esc(p.id)}">
            ${Object.entries(STAGES).map(([sk,v])=>`<option value="${sk}"${sk===k?' selected':''}>${v.label}</option>`).join('')}
          </select>`:stagePill(p)}</td>
        <td class="c-nt">${canEdit?`<input class="note-in" data-note="${esc(p.id)}" value="${esc(p.notes||'')}" placeholder="пара слов…" maxlength="120" />`
          :`<span class="mut">${esc(p.notes||'—')}</span>`}</td>
        <td class="c-ra">${p.rating?`<span class="rate"><b>${esc(rate(p.rating))}</b>${p.reviews?`<span class="rv">${p.reviews}&nbsp;отз.</span>`:''}</span>`:'<span class="mut">—</span>'}</td>
        <td class="c-ph">${p.phone?`<button class="mini call" data-call="${esc(p.id)}" title="Набрать ${esc(p.phone)}">📞 ${esc(p.phone)}</button>`:'<span class="mut">нет</span>'}</td>
        <td class="c-dm">${p.demo?`<a class="mini go" href="${esc(p.demo)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Открыть ↗</a>`
          :(p.gen_prompt?`<button class="mini make" data-demo="${esc(p.id)}">Сделать</button>`
          :`<span class="mut" title="нет промпта — лид ещё не прошёл Рокфеллера">—</span>`)}</td>
      </tr>`;}).join('')}
    </tbody></table></div>`;
  };

  /* «Дозвон» = человек взял трубку (любой итог кроме «не взяли»). */
  const answered=c=>!!c.out&&c.out!=='no_answer';

  function callAnalytics(calls){
    const marked=calls.filter(c=>c.out);
    if(marked.length<3) return `<div class="hint" style="margin-top:16px"><span>📊</span>
      <div>Аналитика появится сама, когда в журнале будет хотя бы несколько звонков с отмеченным итогом. Она ответит: в какие часы берут трубку, какой день недели урожайнее и какие ниши отвечают чаще.</div></div>`;
    const rate=(arr)=>{const t=arr.length,a=arr.filter(answered).length;return t?Math.round(a/t*100):0;};
    const hours=[];
    for(let h=8;h<=21;h++){
      const hs=marked.filter(c=>new Date(c.at).getHours()===h);
      hours.push({d:String(h),n:rate(hs),full:h+':00 — взяли '+hs.filter(answered).length+' из '+hs.length});
    }
    const wd=[1,2,3,4,5,6,0].map(i=>{
      const ds=marked.filter(c=>new Date(c.at).getDay()===i);
      return {d:DOW[i],n:rate(ds),full:DOW[i]+' — взяли '+ds.filter(answered).length+' из '+ds.length};
    });
    const outs=Object.entries(OUTCOMES).map(([k,v])=>({...v,n:marked.filter(c=>c.out===k).length}));
    const byNiche={};
    marked.forEach(c=>{
      const n=String(c.p.niche||'—').split(';')[0].trim()||'—';
      (byNiche[n]=byNiche[n]||[]).push(c);
    });
    const niches=Object.entries(byNiche).sort((a,b)=>b[1].length-a[1].length).slice(0,6);
    return `
    <div class="cols" style="margin-top:16px">
      <div class="panel"><div class="panel-h"><h3>Когда берут трубку</h3><span class="sub">% дозвона по часам</span></div>
        <div class="panel-b">${barChart(hours,'нет данных','%')}</div></div>
      <div class="panel"><div class="panel-h"><h3>По дням недели</h3><span class="sub">% дозвона</span></div>
        <div class="panel-b">${barChart(wd,'нет данных','%')}</div></div>
    </div>
    <div class="cols" style="margin-top:16px">
      <div class="panel"><div class="panel-h"><h3>Ниши</h3><span class="sub">кто отвечает и покупает</span></div>
        <table class="data"><thead><tr><th>Ниша</th><th>Звонков</th><th>Дозвон</th><th>Просят демку</th></tr></thead><tbody>
        ${niches.map(([n,arr])=>`<tr style="cursor:default">
          <td><b>${esc(n.slice(0,34))}</b></td><td class="mut">${arr.length}</td>
          <td>${rate(arr)}%</td>
          <td class="mut">${arr.filter(c=>c.out==='demo').length}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="panel"><div class="panel-h"><h3>Чем кончаются звонки</h3></div>
        <div class="panel-b">${outs.map(o=>`<div class="mstat"><span class="mut">${o.ic} ${esc(o.label)}</span><b>${o.n}</b></div>`).join('')}</div></div>
    </div>`;
  }

  V.calls=()=>{
    const calls=allCalls();
    const today=calls.filter(c=>dayKey(c.at)===dayKey(new Date())).length;
    const week=calls.filter(c=>(Date.now()-new Date(c.at))<7*864e5).length;
    const talked=calls.filter(answered).length;
    const reach=calls.length?Math.round(talked/calls.length*100):0;
    const byPerson={};
    calls.forEach(c=>{ const k=c.by||'—'; byPerson[k]=(byPerson[k]||0)+1; });
    return `
    <div class="grid kpis">
      ${kpi('Сегодня',today,ICONS.calls)}
      ${kpi('За 7 дней',week,ICONS.calls)}
      ${kpi('Дозвонов',talked,ICONS.calls,calls.length?reach+'% попаданий':'')}
      ${kpi('Всего в журнале',calls.length,ICONS.dashboard)}
    </div>
    <div class="panel"><div class="panel-h"><h3>Звонки за две недели</h3>
      <span class="sub">журнал пишется, когда жмёшь «Набрать»</span></div>
      <div class="panel-b">${barChart(callsByDay(14),'Журнал пуст. Он заполнится сам — жми «Набрать» в списке лидов.')}</div></div>
    <div class="cols" style="margin-top:16px">
      <div class="panel"><div class="panel-h"><h3>История</h3><span class="sub">последние 40 · ✕ убирает случайную запись</span></div>
        ${calls.length?`<table class="data"><thead><tr><th>Компания</th><th>Итог</th><th>Кто</th><th>Когда</th><th></th></tr></thead><tbody>
          ${calls.slice(0,40).map(c=>`<tr data-id="${esc(c.p.id)}">
            <td><b>${esc(c.p.company)}</b></td>
            <td>${(OUTCOMES[c.out]||{ic:'📞'}).ic} ${esc((OUTCOMES[c.out]||{label:'набрали, итог не отмечен'}).label)}</td>
            <td class="mut">${esc(c.by||'—')}</td>
            <td class="mut">${esc(ago(c.at))}</td>
            <td>${(USER&&USER.can&&USER.can.edit)?`<button class="mini del" data-delcall="${esc(c.p.id)}::${esc(c.at)}" title="убрать запись">✕</button>`:''}</td></tr>`).join('')}
        </tbody></table>`:`<div class="panel-b"><div class="empty"><div class="e-ic">📭</div><div>Пока пусто</div></div></div>`}</div>
      <div class="panel"><div class="panel-h"><h3>Кто сколько набрал</h3></div>
        <div class="panel-b">${Object.keys(byPerson).length?Object.entries(byPerson).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`
          <div class="mstat"><span class="mut">${esc(k)}</span><b>${v}</b></div>`).join('')
          :`<div class="empty"><div class="e-ic">👤</div><div>Нет данных</div></div>`}</div></div>
    </div>
    ${callAnalytics(calls)}`;
  };

  /* ---------- Деньги ---------- */
  V.money=()=>{
    if(!(USER&&USER.can&&USER.can.finance))
      return `<div class="hint"><span>🔒</span><div>Раздел «Деньги» видят только основатель и администратор.</div></div>`;
    const paid=DATA.projects.filter(p=>stageOf(p)==='paid');
    const agreed=DATA.projects.filter(p=>stageOf(p)==='agreed');
    const withAmt=paid.filter(p=>moneyOf(p)&&Number(moneyOf(p).amount)>0);
    const noAmt=paid.length-withAmt.length;
    const total=sum(withAmt,p=>Number(moneyOf(p).amount));
    const mgrTotal=sum(withAmt,p=>Number(moneyOf(p).amount)*pctOf(moneyOf(p))/100);
    const avg=withAmt.length?total/withAmt.length:0;
    const m30=sum(withAmt.filter(p=>{
      const t=moneyOf(p).paid_at||p.updated_at;
      return t&&(Date.now()-new Date(t).getTime())<30*864e5;
    }),p=>Number(moneyOf(p).amount));
    /* прогноз: сколько денег «сидит» в воронке с учётом вероятности стадии */
    const W={contacted:.05,demo_sent:.2,agreed:.6};
    const fc=avg?Object.entries(W).reduce((s,[k,w])=>s+DATA.projects.filter(p=>stageOf(p)===k).length*w*avg,0):0;
    /* помесячная выручка, последние 6 месяцев */
    const MN=['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
    const months=[];
    for(let i=5;i>=0;i--){
      const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-i);
      months.push({key:d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'),d:MN[d.getMonth()],v:0});
    }
    withAmt.forEach(p=>{
      const t=moneyOf(p).paid_at||p.updated_at; if(!t) return;
      const m=months.find(x=>x.key===String(t).slice(0,7));
      if(m) m.v+=Number(moneyOf(p).amount);
    });
    const bars=months.map(m=>({d:m.d,n:Math.round(m.v/1000),full:m.d+': '+fmtMoney(m.v)}));
    const dealRow=p=>{
      const m=moneyOf(p)||{}, amt=Number(m.amount)||0, pct=pctOf(m);
      return `<tr data-id="${esc(p.id)}">
        <td><b>${esc(p.company)}</b><div class="csub mut">${esc(String(p.niche||'').slice(0,32))}</div></td>
        <td>${stagePill(p)}</td>
        <td><input class="note-in amt" data-amt="${esc(p.id)}" value="${amt||''}" placeholder="сумма ₽" inputmode="numeric" /></td>
        <td><input class="note-in pct" data-pct="${esc(p.id)}" value="${pct}" inputmode="numeric" /></td>
        <td class="mut">${amt?fmtMoney(amt*pct/100):'—'}</td>
        <td class="mut">${amt?fmtMoney(amt*(100-pct)/100):'—'}</td>
        <td class="mut">${m.paid_at?fmtDay(m.paid_at):'—'}</td>
      </tr>`;
    };
    return `
    <div class="grid kpis">
      ${kpi('Выручка за всё время',fmtMoney(total),ICONS.money,withAmt.length?plural(withAmt.length,'сделка','сделки','сделок'):'проставь суммы сделок')}
      ${kpi('За 30 дней',fmtMoney(m30),ICONS.money)}
      ${kpi('Средний чек',fmtMoney(avg),ICONS.dashboard)}
      ${kpi('Менеджеру',fmtMoney(mgrTotal),ICONS.team,'тебе '+fmtMoney(total-mgrTotal))}
      ${kpi('Сидит в воронке',fmtMoney(fc),ICONS.projects,avg?'прогноз по стадиям':'нужен средний чек')}
    </div>
    ${noAmt?`<div class="hint"><span>✍️</span><div><b>${plural(noAmt,'оплаченная сделка','оплаченные сделки','оплаченных сделок')} без суммы.</b> Впиши суммы в таблице ниже — без них выручка и прогноз считаются не полностью.</div></div>`:''}
    <div class="cols">
      <div class="panel"><div class="panel-h"><h3>Выручка по месяцам</h3><span class="sub">тыс. ₽</span></div>
        <div class="panel-b">${barChart(bars,'Пока ни одной оплаты с суммой','к')}</div></div>
      <div class="panel"><div class="panel-h"><h3>Как считается</h3></div>
        <div class="panel-b mut" style="font-size:12.5px;line-height:1.7">
          Доля менеджера по умолчанию — ${window.VC.CONFIG.managerPercent}%, в каждой сделке можно поправить.<br>
          «Сидит в воронке» = связались ×5% + демка ушла ×20% + согласовано ×60%, помноженные на средний чек.<br>
          Менеджер этот раздел не видит — только основатель и администратор.
        </div></div>
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="panel-h"><h3>Сделки</h3><span class="sub">оплачено ${paid.length} · согласовано ${agreed.length}</span></div>
      ${paid.length||agreed.length?`<div class="tbl-wrap"><table class="data"><thead><tr>
        <th>Компания</th><th>Стадия</th><th>Сумма</th><th>% менеджеру</th><th>Менеджеру</th><th>Тебе</th><th>Оплата</th>
      </tr></thead><tbody>
        ${paid.map(dealRow).join('')}${agreed.map(dealRow).join('')}
      </tbody></table></div>`
      :`<div class="panel-b"><div class="empty"><div class="e-ic">💰</div><div>Пока нет сделок в стадиях «согласовано» и «оплачено»</div></div></div>`}
    </div>`;
  };

  V.team=()=>`
    ${(USER&&USER.can&&USER.can.invite)?`
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-h"><h3>Сотрудники</h3><span class="sub">кто в команде, когда заходил, какой уровень</span></div>
      <div id="teamList"><div class="panel-b"><div class="empty"><div class="e-ic">👥</div><div>загружаю список…</div></div></div></div>
    </div>`:''}
    <div class="panel">
      <div class="panel-h"><h3>Уровни доступа</h3><span class="sub">права проверяются в самой базе, не только в интерфейсе</span></div>
      <div class="panel-b"><table class="data"><thead><tr>
        <th>Уровень</th><th>Приглашать</th><th>Редактировать</th><th>Видеть деньги</th>
      </tr></thead><tbody>
        ${Object.entries(window.VCAuth.ROLES).map(([k,v])=>`<tr style="cursor:default">
          <td><b>${esc(v.label)}</b>${USER&&USER.roleKey===k?' <span class="pill s-demo"><i></i>это вы</span>':''}</td>
          <td>${v.invite?'<span class="ok">да</span>':'<span class="off">нет</span>'}</td>
          <td>${v.edit?'<span class="ok">да</span>':'<span class="off">нет</span>'}</td>
          <td>${v.finance?'<span class="ok">да</span>':'<span class="off">нет</span>'}</td>
        </tr>`).join('')}
      </tbody></table></div>
    </div>
    ${(USER&&USER.can&&USER.can.invite)?`
    <div class="panel" style="margin-top:16px">
      <div class="panel-h"><h3>Пригласить в Workspace</h3><span class="sub">одноразовый код — сотрудник регистрируется им сам</span></div>
      <div class="panel-b">
        <div class="row-inline">
          <span class="mut" style="font-size:13px">Уровень нового сотрудника:</span>
          <select id="inviteRole">${Object.entries(window.VCAuth.ROLES)
            .filter(([k])=>k!=='owner'||(USER&&USER.can.roles))
            .map(([k,v])=>`<option value="${k}"${k==='manager'?' selected':''}>${v.label}</option>`).join('')}</select>
          <button class="btn gold" id="inviteBtn">Создать код</button>
        </div>
        <div id="inviteNew" style="margin-top:14px"></div>
        <div id="inviteOut" style="margin-top:6px"></div>
      </div>
    </div>`:`<div class="hint" style="margin-top:16px"><span>🔒</span><div>Приглашать сотрудников может только основатель или администратор.</div></div>`}`;

  async function renderTeam(){
    const box=$('#teamList'); if(!box) return;
    if(!window.VC.CONFIG.adminActive){
      box.innerHTML=`<div class="panel-b"><div class="hint" style="margin:0"><span>🔌</span><div><b>Список сотрудников подготовлен, но серверный мост ещё не активирован.</b> Нужен воркфлоу <code>n8n/vertux-admin.json</code> в n8n. До этого приглашения ниже работают, а роли сотрудников менять нельзя.</div></div></div>`;
      return;
    }
    try{
      const j=await window.VC.adminCall('list_users');
      const users=j.users||[];
      const canRoles=!!(USER&&USER.can&&USER.can.roles);
      box.innerHTML=`<table class="data"><thead><tr>
        <th>Сотрудник</th><th>Уровень</th><th>Появился</th><th>Был в сети</th>
      </tr></thead><tbody>${users.map(u=>{
        const isSelf=USER&&USER.id===u.id, isOwner=u.role==='owner';
        const label=((window.VCAuth.ROLES[u.role]||{}).label)||u.role;
        return `<tr style="cursor:default">
        <td><div class="co"><div class="logo s-cont">${initials(u.name||u.email)}</div>
          <div class="co-t"><span class="cn">${esc(u.name||'—')}${isSelf?' <span class="pill s-demo"><i></i>это вы</span>':''}</span>
          <span class="csub">${esc(u.email)}</span></div></div></td>
        <td>${(canRoles&&!isSelf&&!isOwner)?`<select class="stage-sel s-cont" data-role-user="${esc(u.id)}">
            ${['admin','manager','viewer'].map(r=>`<option value="${r}"${u.role===r?' selected':''}>${window.VCAuth.ROLES[r].label}</option>`).join('')}
          </select>`:`<span class="pill ${isOwner?'s-agr':'s-cont'}"><i></i>${esc(label)}</span>`}</td>
        <td class="mut">${esc(String(u.created_at||'').slice(0,10))}</td>
        <td class="mut">${u.last_sign_in_at?esc(ago(u.last_sign_in_at)):'ещё не заходил'}</td>
      </tr>`;}).join('')}</tbody></table>`;
      $$('select[data-role-user]',box).forEach(s=>{
        const before=s.value;
        s.onchange=async()=>{
          s.disabled=true;
          try{
            await window.VC.adminCall('set_role',{ targetId:s.dataset.roleUser, role:s.value });
            s.classList.remove('s-cont'); s.classList.add('s-paid');
            setTimeout(()=>{ s.classList.remove('s-paid'); s.classList.add('s-cont'); },1200);
          }catch(e){ s.value=before; alert('Роль не поменялась: '+(e.message||e)); }
          finally{ s.disabled=false; }
        };
      });
    }catch(e){
      box.innerHTML=`<div class="panel-b"><div class="hint" style="margin:0"><span>🔌</span><div>Список сотрудников появится после активации воркфлоу <b>Vertux Admin</b> в n8n (папка <code>n8n/</code> в репо). Сейчас: ${esc(e.message||e)}</div></div></div>`;
    }
  }

  async function renderInvites(){
    const out=$('#inviteOut'); if(!out) return;
    try{
      const list=await window.VCAuth.listInvites();
      out.innerHTML = list.length ? `<table class="data"><thead><tr><th>Код</th><th>Уровень</th><th>Статус</th><th>Создан</th></tr></thead><tbody>${
        list.map(i=>`<tr style="cursor:default">
          <td><code>${esc(i.code)}</code></td>
          <td>${esc(((window.VCAuth.ROLES[i.role]||{}).label)||i.role||'—')}</td>
          <td>${i.used_by?'<span class="pill s-ni"><i></i>использован</span>':'<span class="pill s-paid"><i></i>свободен</span>'}</td>
          <td class="mut">${esc(String(i.created_at||'').slice(0,10))}</td></tr>`).join('')}</tbody></table>`
        : '<span class="mut" style="font-size:13px">Кодов пока нет</span>';
    }catch(e){ out.innerHTML='<span class="mut" style="font-size:13px">Не удалось загрузить коды</span>'; }
  }

  /* Мост к серверу (n8n вкл/выкл, баланс OpenRouter). Ключи живут на сервере,
     фронт ходит со своим Supabase-токеном — функция пускает только owner/admin. */
  async function bridgeCall(action, payload){
    const url=window.VC.CONFIG.bridgeUrl;
    if(!url) throw new Error('мост не настроен');
    const c=window.VCAuth.client(); if(!c) throw new Error('нет соединения');
    const { data }=await c.auth.getSession();
    const token=data&&data.session&&data.session.access_token;
    const res=await fetch(url,{
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+token, 'apikey':window.VC.CONFIG.supabaseAnonKey },
      body:JSON.stringify({ action:action, ...(payload||{}) }),
    });
    const j=await res.json().catch(()=>({}));
    if(!res.ok||j.error) throw new Error(j.error||('HTTP '+res.status));
    return j;
  }

  V.shield=()=>{
    const layers=['Потолок расхода OpenRouter','Origin + токен сессии','Фильтр длины и фарма','max_tokens + границы темы','Telegram-алерты'];
    const bridge=!!window.VC.CONFIG.bridgeUrl;
    return `
    <div class="hint"><span>🛡️</span><div><b>Vertux Shield</b> — защита AI-виджетов от «токен-фермеров». Каждый виджет закрыт 5 слоями; открытые вебхуки помечены.</div></div>
    ${bridge?`<div class="panel" style="margin-bottom:16px"><div class="panel-h"><h3>Баланс OpenRouter</h3><span class="sub">общий ключ виджетов</span></div>
      <div class="panel-b" id="orBal"><span class="mut">загружаю…</span></div></div>`:''}
    <div class="grid cards">${DATA.widgets.map((w,i)=>`
      <div class="card"><div class="ch"><div class="member-ava">${initials(w.company)}</div>
        <div><div style="font-weight:600">${esc(w.company)}</div>
        <div style="font-size:12.5px" class="${w.shield?'ok':'off'}">${w.shield?'● защита активна':'○ вебхук открыт'}</div></div></div>
        <div class="mstat"><span class="mut">Заблокировано</span><b class="mut">нет данных</b></div>
        ${bridge&&w.workflowId?`<div class="row-inline" style="margin:10px 0 2px">
          <button class="btn" data-wf="${esc(w.workflowId)}" data-do="deactivate">Выключить</button>
          <button class="btn" data-wf="${esc(w.workflowId)}" data-do="activate">Включить</button>
          <span class="mut wf-msg" style="font-size:12px"></span>
        </div>`:''}
        <div class="dr-sec">Слои</div>
        ${layers.map(l=>`<div class="shield-line">${l}<span class="st ${w.shield?'ok':'off'}">${w.shield?'вкл':'—'}</span></div>`).join('')}
      </div>`).join('')}
    </div>
    ${bridge?'':`<div class="hint" style="margin-top:16px"><span>🔌</span><div><b>Управление виджетами и баланс OpenRouter не подключены.</b> Кнопки вкл/выкл и остаток на ключе появятся, когда поставим мост — маленькую функцию на твоём Supabase, где ключи лежат на сервере, а не в браузере. Файлы готовы в <code>backend/</code>, ставится при следующем деплое с паролем.</div></div>`}
    <div class="hint" style="margin-top:16px"><span>📊</span><div>Счётчик блокировок пока не подключён к n8n — поэтому здесь честное «нет данных», а не выдуманная цифра. Подключим, когда выведем ноду Log Messages в базу.</div></div>`;
  };

  function wireShield(){
    const bal=$('#orBal');
    if(bal) bridgeCall('balance').then(j=>{
      bal.innerHTML=`<div class="mstat" style="border:none;padding:0"><span class="mut">Осталось</span><b>${esc(j.left!=null?('$'+Number(j.left).toFixed(2)):'—')}</b></div>
        ${j.usage!=null?`<div class="mstat"><span class="mut">Потрачено</span><b>$${esc(Number(j.usage).toFixed(2))}</b></div>`:''}`;
    }).catch(e=>{ bal.innerHTML='<span class="mut">не достучался: '+esc(e.message||e)+'</span>'; });
    $$('button[data-wf]').forEach(b=>b.onclick=async()=>{
      const msg=b.parentElement.querySelector('.wf-msg');
      b.disabled=true; if(msg) msg.textContent='…';
      try{ await bridgeCall(b.dataset.do,{workflowId:b.dataset.wf});
        if(msg) msg.textContent=b.dataset.do==='activate'?'включён ✓':'выключен ✓';
      }catch(e){ if(msg) msg.textContent='не вышло: '+(e.message||e); }
      finally{ b.disabled=false; }
    });
  }

  /* ---------- AI-тренер ---------- */
  const TR={ tab:'live', leadId:'', lines:[], hints:[], auto:true, listening:false,
             chat:[], difficulty:'занятой', tts:true, review:'', lastHintLine:0, lastHintAt:0, busy:false };
  let SREC=null;

  const aiOn=()=>window.VC.CONFIG.aiActive===true;
  const sttOn=()=>!!(window.SpeechRecognition||window.webkitSpeechRecognition);
  const trLead=()=>DATA.projects.find(x=>String(x.id)===String(TR.leadId))||null;
  const leadCtx=p=>p?{ niche:String(p.niche||'').slice(0,80), city:p.city||'', issues:String(p.issues||'').slice(0,600),
                       script:String(p.call_script||'').slice(0,4000) }:{ niche:'', city:'', issues:'', script:'' };

  function speak(t){
    if(!TR.tts) return;
    try{ const u=new SpeechSynthesisUtterance(t); u.lang='ru-RU'; u.rate=1.05; speechSynthesis.cancel(); speechSynthesis.speak(u); }catch(e){}
  }

  function leadSelect(id){
    const opts=DATA.projects
      .filter(p=>p.call_script||p.issues||p.phone)
      .slice(0,200)
      .map(p=>`<option value="${esc(p.id)}"${String(p.id)===String(TR.leadId)?' selected':''}>${esc(p.company)}${p.call_script?' · скрипт':''}</option>`).join('');
    return `<select id="${id}" class="tr-lead"><option value="">— без привязки к лиду —</option>${opts}</select>`;
  }

  V.trainer=()=>{
    const tabs=[['live','🎙 Live-суфлёр'],['review','🧾 Разбор звонка'],['roleplay','🥊 Тренажёр']];
    const head=`
      <div class="tbl-tools">
        ${tabs.map(([k,l])=>`<button class="chip ${TR.tab===k?'active':''}" data-ttab="${k}">${l}</button>`).join('')}
      </div>
      ${aiOn()?'':`<div class="hint"><span>🔌</span><div><b>Мозг тренера подготовлен, но production webhook n8n пока не активирован.</b> Live-транскрипция работает без него. Для подсказок, разбора и тренажёра импортируй <code>n8n/vertux-ai-trainer.json</code>, выбери кредензию OpenRouter и нажми Activate. Workspace увидит его автоматически при следующем входе.</div></div>`}`;

    if(TR.tab==='live') return head+`
      ${sttOn()?'':'<div class="hint"><span>⚠️</span><div>Этот браузер не умеет распознавать речь — нужен Chrome или Edge.</div></div>'}
      <div class="row-inline" style="margin-bottom:14px">
        ${leadSelect('trLeadSel')}
        <button class="btn ${TR.listening?'':'gold'}" id="trMic" ${sttOn()?'':'disabled'}>${TR.listening?'⏹ Стоп':'🎙 Начать слушать'}</button>
        <label class="mut" style="font-size:12.5px;display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="trAuto" ${TR.auto?'checked':''}/> подсказки сами</label>
        <button class="btn" id="trHintBtn" ${aiOn()?'':'disabled'}>Подсказку!</button>
        ${TR.lines.length?`<button class="btn" id="trToReview">→ Разобрать этот звонок</button>`:''}
      </div>
      <div class="cols">
        <div class="panel"><div class="panel-h"><h3>Что слышу</h3><span class="sub" id="trState">${TR.listening?'слушаю…':'микрофон выключен'}</span></div>
          <div class="panel-b transcript" id="trTranscript">${TR.lines.map(l=>`<div class="tline">${esc(l)}</div>`).join('')}
            <div class="tline tint" id="trInterim"></div>
            ${TR.lines.length?'':'<div class="empty" id="trEmpty"><div class="e-ic">🎙</div><div>Нажми «Начать слушать», положи телефон на громкую — и говори. Я записываю обе стороны с микрофона.</div></div>'}</div></div>
        <div class="panel"><div class="panel-h"><h3>Суфлёр</h3><span class="sub">что ответить</span></div>
          <div class="panel-b" id="trHints">${TR.hints.length?TR.hints.map(h=>`<div class="hint-card">${esc(h)}</div>`).join('')
            :'<div class="empty"><div class="e-ic">💡</div><div>Подсказки появятся по ходу разговора</div></div>'}</div></div>
      </div>`;

    if(TR.tab==='review'){
      const p=trLead();
      const reviews=(p&&p.raw&&Array.isArray(p.raw.reviews))?p.raw.reviews:[];
      return head+`
      <div class="row-inline" style="margin-bottom:14px">${leadSelect('trLeadSel')}
        <span class="mut" style="font-size:12.5px">лид добавит в разбор скрипт и болячки сайта</span></div>
      <div class="cols">
        <div class="panel"><div class="panel-h"><h3>Транскрипт звонка</h3><span class="sub">из Fireflies или live-режима</span></div>
          <div class="panel-b">
            <textarea id="trText" rows="12" placeholder="Вставь сюда текст разговора…">${esc(TR.review)}</textarea>
            <div class="row-inline" style="margin-top:10px">
              <button class="btn gold" id="trReviewBtn" ${aiOn()?'':'disabled'}>Разобрать</button>
              <span class="mut" id="trReviewMsg" style="font-size:12.5px"></span>
            </div></div></div>
        <div class="panel"><div class="panel-h"><h3>Разбор</h3></div>
          <div class="panel-b" id="trResult"><div class="empty"><div class="e-ic">🧾</div><div>Вставь транскрипт и нажми «Разобрать»</div></div></div></div>
      </div>
      ${reviews.length?`<div class="panel" style="margin-top:16px"><div class="panel-h"><h3>Прошлые разборы: ${esc(p.company)}</h3><span class="sub">видно, растёт ли качество</span></div>
        <div class="panel-b">${reviews.slice().reverse().map(r=>`<details class="rev"><summary>${esc(fmtDay(r.at))} · ${esc(String(r.text||'').split('\n')[0].slice(0,70))}</summary><pre class="script" style="margin-top:8px">${esc(r.text)}</pre></details>`).join('')}</div></div>`:''}`;
    }

    /* тренажёр */
    return head+`
    <div class="row-inline" style="margin-bottom:14px">
      ${leadSelect('trLeadSel')}
      <select id="trDiff">${['лояльный','занятой','жёсткий'].map(d=>`<option${d===TR.difficulty?' selected':''}>${d}</option>`).join('')}</select>
      <label class="mut" style="font-size:12.5px;display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="trTts" ${TR.tts?'checked':''}/> озвучивать клиента</label>
      ${TR.chat.length?`<button class="btn" id="trDebrief" ${aiOn()?'':'disabled'}>Завершить и получить разбор</button>
        <button class="btn" id="trReset">Заново</button>`:''}
    </div>
    <div class="panel"><div class="panel-h"><h3>Тренировочный звонок</h3>
      <span class="sub">${trLead()?esc(trLead().company)+' · ':''}клиент: ${esc(TR.difficulty)}</span></div>
      <div class="panel-b">
        <div class="chat" id="trChat">${TR.chat.length?TR.chat.map(m=>`<div class="msg ${m.who}">${esc(m.text)}</div>`).join('')
          :'<div class="empty"><div class="e-ic">🥊</div><div>Поздоровайся — как в настоящем звонке. ИИ сыграет клиента из выбранной ниши, а в конце разберёт, как ты отработал.</div></div>'}</div>
        <div class="row-inline" style="margin-top:12px">
          <input id="trMsg" placeholder="твоя реплика…" style="flex:1" ${aiOn()?'':'disabled'} />
          ${sttOn()?`<button class="btn" id="trSay" title="сказать голосом" ${aiOn()?'':'disabled'}>🎙</button>`:''}
          <button class="btn gold" id="trSend" ${aiOn()?'':'disabled'}>Сказать</button>
        </div></div></div>`;
  };

  function trAppendLine(text){
    TR.lines.push(text);
    const box=$('#trTranscript');
    if(box){
      const e=$('#trEmpty'); if(e) e.remove();
      const d=document.createElement('div'); d.className='tline'; d.textContent=text;
      box.insertBefore(d, $('#trInterim'));
      box.scrollTop=box.scrollHeight;
    }
    if(TR.auto && aiOn() && TR.lines.length-TR.lastHintLine>=2 && Date.now()-TR.lastHintAt>9000) trHint();
  }

  async function trHint(){
    if(TR.busy||!aiOn()||!TR.lines.length) return;
    TR.busy=true; TR.lastHintLine=TR.lines.length; TR.lastHintAt=Date.now();
    const hb=$('#trHintBtn'); if(hb){ hb.disabled=true; hb.textContent='думаю…'; }
    try{
      const ctx=leadCtx(trLead());
      const j=await window.VC.aiCall('suffler',{ transcript:TR.lines.slice(-14).join('\n'), ...ctx });
      TR.hints.unshift(j.text||'—'); TR.hints=TR.hints.slice(0,6);
      const hv=$('#trHints'); if(hv) hv.innerHTML=TR.hints.map(h=>`<div class="hint-card">${esc(h)}</div>`).join('');
    }catch(e){
      const hv=$('#trHints'); if(hv) hv.innerHTML=`<div class="hint-card bad">суфлёр молчит: ${esc(e.message||e)}</div>`+hv.innerHTML;
    }finally{
      TR.busy=false;
      const hb2=$('#trHintBtn'); if(hb2){ hb2.disabled=!aiOn(); hb2.textContent='Подсказку!'; }
    }
  }

  function trStartSTT(){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR) return;
    SREC=new SR();
    SREC.lang='ru-RU'; SREC.continuous=true; SREC.interimResults=true;
    SREC.onresult=e=>{
      let interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const r=e.results[i];
        if(r.isFinal){ const t=r[0].transcript.trim(); if(t) trAppendLine(t); }
        else interim+=r[0].transcript;
      }
      const iv=$('#trInterim'); if(iv) iv.textContent=interim;
    };
    /* Chrome сам останавливается на тишине — перезапускаем, пока не нажали Стоп */
    SREC.onend=()=>{ if(TR.listening){ try{ SREC.start(); }catch(e){} } };
    SREC.onerror=ev=>{
      if(ev.error==='not-allowed'||ev.error==='service-not-allowed'){
        TR.listening=false;
        const st=$('#trState'); if(st) st.textContent='нет доступа к микрофону — разреши в браузере';
        const mb=$('#trMic'); if(mb){ mb.textContent='🎙 Начать слушать'; mb.classList.add('gold'); }
      }
    };
    try{ SREC.start(); }catch(e){}
  }
  function trStopSTT(){ if(SREC){ try{ SREC.stop(); }catch(e){} SREC=null; } }

  async function trRoleSend(text){
    text=String(text||'').trim();
    if(!text||TR.busy||!aiOn()) return;
    TR.busy=true;
    TR.chat.push({who:'m',text:text});
    render();
    try{
      const ctx=leadCtx(trLead());
      const j=await window.VC.aiCall('roleplay',{ history:TR.chat.slice(-14), difficulty:TR.difficulty, ...ctx });
      TR.chat.push({who:'c',text:j.text||'…'});
      speak(j.text||'');
    }catch(e){ TR.chat.push({who:'sys',text:'клиент завис: '+(e.message||e)}); }
    finally{ TR.busy=false; render(); const i=$('#trMsg'); if(i) i.focus(); }
  }

  function wireTrainer(){
    $$('[data-ttab]').forEach(b=>b.onclick=()=>{
      if(TR.tab==='live'&&TR.listening){ TR.listening=false; trStopSTT(); }
      TR.tab=b.dataset.ttab; render();
    });
    const ls=$('#trLeadSel'); if(ls) ls.onchange=()=>{ TR.leadId=ls.value; render(); };
    const mic=$('#trMic');
    if(mic) mic.onclick=()=>{
      TR.listening=!TR.listening;
      if(TR.listening) trStartSTT(); else trStopSTT();
      render();
    };
    const au=$('#trAuto'); if(au) au.onchange=()=>{ TR.auto=au.checked; };
    const hb=$('#trHintBtn'); if(hb) hb.onclick=trHint;
    const t2r=$('#trToReview'); if(t2r) t2r.onclick=()=>{
      if(TR.listening){ TR.listening=false; trStopSTT(); }
      TR.review=TR.lines.join('\n'); TR.tab='review'; render();
    };
    const rb=$('#trReviewBtn');
    if(rb) rb.onclick=async()=>{
      const txt=$('#trText').value.trim(), msg=$('#trReviewMsg'), out=$('#trResult');
      if(txt.length<40){ msg.textContent='слишком коротко — вставь весь разговор'; return; }
      TR.review=txt;
      rb.disabled=true; msg.textContent='разбираю…';
      try{
        const p=trLead();
        const j=await window.VC.aiCall('review',{ transcript:txt.slice(0,12000), ...leadCtx(p) });
        out.innerHTML=`<pre class="script" style="max-height:none">${esc(j.text||'—')}</pre>`;
        msg.textContent='';
        if(p){
          const raw=(p.raw&&typeof p.raw==='object')?p.raw:{};
          const reviews=(Array.isArray(raw.reviews)?raw.reviews:[]).slice(-9);
          reviews.push({at:new Date().toISOString(),text:j.text||''});
          await window.VC.saveRaw(p,{reviews:reviews});
          msg.textContent='сохранено в карточку лида';
        }
      }catch(e){ msg.textContent='не вышло: '+(e.message||e); }
      finally{ rb.disabled=!aiOn(); }
    };
    const diff=$('#trDiff'); if(diff) diff.onchange=()=>{ TR.difficulty=diff.value; render(); };
    const tts=$('#trTts'); if(tts) tts.onchange=()=>{ TR.tts=tts.checked; };
    const send=$('#trSend'), msgIn=$('#trMsg');
    if(send) send.onclick=()=>{ trRoleSend(msgIn.value); if(msgIn) msgIn.value=''; };
    if(msgIn) msgIn.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); trRoleSend(msgIn.value); msgIn.value=''; } };
    const say=$('#trSay');
    if(say) say.onclick=()=>{
      const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR) return;
      const r=new SR(); r.lang='ru-RU'; r.interimResults=false;
      say.textContent='…говори'; say.disabled=true;
      r.onresult=e=>{ const t=e.results[0][0].transcript; trRoleSend(t); };
      r.onend=()=>{ say.textContent='🎙'; say.disabled=false; };
      r.onerror=()=>{ say.textContent='🎙'; say.disabled=false; };
      try{ r.start(); }catch(e){ say.textContent='🎙'; say.disabled=false; }
    };
    const db2=$('#trDebrief');
    if(db2) db2.onclick=async()=>{
      if(TR.busy||TR.chat.length<2) return;
      TR.busy=true; db2.disabled=true; db2.textContent='разбираю…';
      try{
        const j=await window.VC.aiCall('debrief',{ history:TR.chat.slice(-30), difficulty:TR.difficulty, ...leadCtx(trLead()) });
        TR.chat.push({who:'coach',text:j.text||'—'});
      }catch(e){ TR.chat.push({who:'sys',text:'разбор не вышел: '+(e.message||e)}); }
      finally{ TR.busy=false; render(); }
    };
    const rst=$('#trReset'); if(rst) rst.onclick=()=>{ TR.chat=[]; render(); };
    const chat=$('#trChat'); if(chat) chat.scrollTop=chat.scrollHeight;
  }

  /* ---------- Импорт ---------- */
  let IMP=null; /* {rows, fmt, plan, file} */
  V.import=()=>{
    const canEdit=!!(USER&&USER.can&&USER.can.edit);
    if(!canEdit) return `<div class="hint"><span>🔒</span><div>Импортировать данные может основатель, администратор или менеджер.</div></div>`;
    const rawN=DATA.projects.filter(p=>!p.processed).length;
    const enrichOn=window.VC.CONFIG.enrichActive===true;
    return `
    <div class="hint"><span>📥</span><div>Кидай сюда <b>CSV</b> или <b>XLSX</b> — из 2GIS-парсера (сырьё) или из Рокфеллера (готовый список со скриптами). Формат определится сам, а перед записью покажу, что изменится.</div></div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-h"><h3>🪄 ИИ-Рокфеллер</h3><span class="sub">${plural(rawN,'сырой лид','сырых лида','сырых лидов')} в базе</span></div>
      <div class="panel-b">
        <div class="row-inline">
          <span class="mut" style="font-size:13px">Обогатить</span>
          <select id="enrichN"><option>5</option><option selected>10</option><option>15</option></select>
          <span class="mut" style="font-size:13px">лидов</span>
          <button class="btn gold" id="enrichBtn" ${(rawN&&enrichOn)?'':'disabled'}>Прогнать через ИИ</button>
          <span id="enrichMsg" class="mut" style="font-size:12.5px"></span>
        </div>
        <div class="mut" style="font-size:12px;margin-top:8px">${enrichOn?'Берёт самых рейтинговых из сырых, заглядывает на их сайты и пишет: тип (редизайн/с нуля), болячки, контекст, скрипт звонка и промпт демки. Примерно 20–40 секунд на лида.':'Модуль готов, но webhook n8n ещё не активирован. Импортируй <code>n8n/vertux-rockfeller.json</code>, выбери OpenRouter и Postgres, затем Activate.'}</div>
      </div>
    </div>
    <div class="drop" id="drop">
      <div class="drop-ic">⬆</div>
      <div class="drop-t">Перетащи файл сюда</div>
      <div class="drop-s">или <button class="btn" id="pickBtn">выбери на диске</button></div>
      <input type="file" id="fileIn" accept=".csv,.xlsx,.xls,.tsv" hidden />
    </div>
    <div id="impOut"></div>`;
  };

  function modeCard(id,title,desc,warn){
    return `<label class="mode ${warn?'warn':''}"><input type="radio" name="impMode" value="${id}"${id==='merge'?' checked':''} />
      <div><div class="m-t">${title}</div><div class="m-d">${desc}</div></div></label>`;
  }
  function renderPlan(){
    const out=$('#impOut'); if(!out||!IMP) return;
    const { fmt, rows, plan, stats } = IMP;
    out.innerHTML=`
      <div class="panel" style="margin-top:16px">
        <div class="panel-h"><h3>${esc(IMP.file)}</h3><span class="sub">${esc(fmt.label)}</span></div>
        <div class="panel-b">
          <div class="sum">
            <div class="sc"><b>${rows.length}</b><span>строк в файле</span></div>
            <div class="sc ok-c"><b>${plan.fresh.length}</b><span>новых компаний</span></div>
            <div class="sc"><b>${plan.existing.length}</b><span>уже есть в базе</span></div>
            <div class="sc"><b>${plan.total}</b><span>сейчас в базе</span></div>
          </div>
          ${(stats.skipped||stats.dupes)?`<div class="mut" style="font-size:12.5px;margin-top:10px">Пропущено: ${stats.skipped} без названия, ${stats.dupes} дублей внутри файла.</div>`:''}
          <div class="dr-sec">Что делаем</div>
          <div class="modes">
            ${modeCard('merge','Умное слияние <span class="rec">рекомендую</span>',
              `Новых (${plan.fresh.length}) добавлю. Существующих (${plan.existing.length}) обогащу свежими данными — телефон, рейтинг, скрипт, промпт. <b>Стадии, заметки, демки и историю звонков не трону.</b>`)}
            ${modeCard('add','Только новые',
              `Добавлю ${plan.fresh.length}. Существующие ${plan.existing.length} вообще не трогаю.`)}
            ${modeCard('replace','Заменить всё',
              `Сотру все ${plan.total} записей и залью ${rows.length} из файла. <b>Стадии, заметки, демки и звонки пропадут.</b>`,true)}
          </div>
          <div class="row-inline" style="margin-top:16px">
            <button class="btn gold" id="impRun">Импортировать</button>
            <button class="btn" id="impCancel">Отмена</button>
            <span id="impMsg" class="mut" style="font-size:12.5px"></span>
          </div>
        </div>
      </div>
      <div class="panel" style="margin-top:16px">
        <div class="panel-h"><h3>Как прочитались первые строки</h3><span class="sub">проверь, что всё легло по местам</span></div>
        <div class="tbl-wrap"><table class="data"><thead><tr>
          <th>Компания</th><th>Телефон</th><th>Город</th><th>Тип</th><th>Сайт</th><th>Скрипт</th><th></th>
        </tr></thead><tbody>
          ${rows.slice(0,6).map(r=>{
            const isNew=plan.fresh.includes(r);
            return `<tr style="cursor:default">
            <td><b>${esc(r.company)}</b></td><td class="mut">${esc(r.phone||'—')}</td>
            <td class="mut">${esc(r.city||'—')}</td><td>${typeTag(r.type)}</td>
            <td class="mut">${esc(String(r.site||'—').slice(0,28))}</td>
            <td>${r.call_script?'<span class="ok">есть</span>':'<span class="off">нет</span>'}</td>
            <td>${isNew?'<span class="pill s-paid"><i></i>новая</span>':'<span class="pill s-cont"><i></i>обновится</span>'}</td>
          </tr>`;}).join('')}
        </tbody></table></div>
      </div>`;
    $('#impCancel').onclick=()=>{ IMP=null; $('#impOut').innerHTML=''; };
    $('#impRun').onclick=runImportUI;
  }

  async function handleFile(file){
    const out=$('#impOut');
    out.innerHTML='<div class="panel" style="margin-top:16px"><div class="panel-b mut">Читаю файл…</div></div>';
    try{
      const objs=await window.VC.readFileRows(file);
      if(!objs.length) throw new Error('файл пустой');
      const fmt=window.VC.detectFormat(objs);
      if(!fmt) throw new Error('не узнаю формат. Нужен файл 2GIS-парсера (колонка «Наименование») или Рокфеллера (колонка «Company»)');
      const stats=window.VC.mapRows(objs, fmt);
      if(!stats.rows.length) throw new Error('не нашёл ни одной строки с названием компании');
      out.innerHTML='<div class="panel" style="margin-top:16px"><div class="panel-b mut">Сверяю с базой…</div></div>';
      const plan=await window.VC.planImport(stats.rows);
      IMP={ file:file.name, fmt:fmt, rows:stats.rows, stats:stats, plan:plan };
      renderPlan();
    }catch(e){
      out.innerHTML=`<div class="hint" style="margin-top:16px;border-color:var(--red)"><span>⚠️</span><div>Не вышло: ${esc(e.message||e)}</div></div>`;
    }
  }

  async function runImportUI(){
    const btn=$('#impRun'), msg=$('#impMsg');
    const mode=(document.querySelector('input[name="impMode"]:checked')||{}).value||'merge';
    if(mode==='replace' && !confirm('Заменить всё?\n\nБудут стёрты '+IMP.plan.total+' записей вместе со стадиями, заметками, демками и историей звонков. Отменить это будет нельзя.')) return;
    btn.disabled=true; msg.style.color='';
    try{
      const rep=await window.VC.runImport(IMP.plan, mode, m=>{ msg.textContent=m; });
      DATA=await window.VC.loadData();
      const parts=[];
      if(rep.deleted) parts.push('стёрто '+rep.deleted);
      if(rep.added) parts.push('добавлено '+rep.added);
      if(rep.enriched) parts.push('обогащено '+rep.enriched);
      if(rep.skipped) parts.push('пропущено '+rep.skipped);
      IMP=null;
      $('#impOut').innerHTML=`<div class="hint" style="margin-top:16px;border-color:var(--green)"><span>✅</span>
        <div><b>Готово:</b> ${esc(parts.join(', ')||'изменений нет')}. Теперь в базе ${DATA.projects.length} лидов.</div></div>`;
      renderNav();
    }catch(e){
      msg.textContent='не вышло: '+(e.message||e); msg.style.color='var(--red)';
      btn.disabled=false;
    }
  }

  function wireImport(){
    const eb=$('#enrichBtn');
    if(eb) eb.onclick=async()=>{
      const n=parseInt(($('#enrichN')||{}).value,10)||10, msg=$('#enrichMsg');
      const before=DATA.projects.filter(p=>!p.processed).length;
      eb.disabled=true; msg.style.color='';
      msg.textContent='работаю… примерно '+Math.ceil(n*30/60)+' мин, не закрывай вкладку';
      try{
        await window.VC.enrichCall(n);
        DATA=await window.VC.loadData();
        const after=DATA.projects.filter(p=>!p.processed).length;
        render();
        const em=$('#enrichMsg');
        if(em){ em.textContent='готово: обогащено '+(before-after)+' лидов'; em.style.color='var(--green)'; }
      }catch(e){ msg.textContent='не вышло: '+(e.message||e); msg.style.color='var(--red)'; eb.disabled=false; }
    };
    const drop=$('#drop'), inp=$('#fileIn'); if(!drop) return;
    $('#pickBtn').onclick=()=>inp.click();
    inp.onchange=()=>{ if(inp.files[0]) handleFile(inp.files[0]); };
    ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
    ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
    drop.addEventListener('drop',e=>{ const f=e.dataTransfer.files[0]; if(f) handleFile(f); });
    if(IMP) renderPlan();
  }

  /* ---------- звонки ---------- */
  async function doCall(p){
    if(p.phone) window.location.href='tel:'+String(p.phone).replace(/[^\d+]/g,'');
    openProject(p.id);
    try{
      await window.VC.logCall(p,{ at:new Date().toISOString(), by:(USER&&(USER.name||USER.email))||'—', out:null });
      const box=$('#outcomeBox'); if(box) box.classList.add('live');
      renderCallsBadge(p);
    }catch(e){ console.warn('звонок не записался',e); }
  }
  function renderCallsBadge(p){
    const tr=document.querySelector(`tr[data-id="${p.id}"] .co`); if(!tr) return;
    const n=window.VC.callsOf(p).length;
    let b=tr.querySelector('.calls-badge');
    if(!b && n){ b=document.createElement('span'); b.className='calls-badge'; tr.appendChild(b); }
    if(b){ b.textContent=n; b.title='звонков: '+n; }
  }
  async function setOutcome(p, key){
    const last=lastCall(p);
    const msg=$('#outMsg');
    if(!last){ if(msg) msg.textContent='сначала нажми «Набрать»'; return; }
    const prev=last.out;
    last.out=key;
    try{
      await window.VC.savePatch(p.id,{ raw:p.raw });
      const target=OUTCOMES[key].stage;
      if(target){
        const now=FUNNEL.indexOf(stageOf(p)), next=FUNNEL.indexOf(target);
        const forward = target==='refused' ? stageOf(p)!=='paid' : (next>now && stageOf(p)!=='paid');
        if(forward){
          await window.VC.saveStage(p.id,target,STAGES[target].pr);
          p.stage=target; p.progress=STAGES[target].pr;
          paintStage(p);
        }
      }
      openProject(p.id);
    }catch(e){
      last.out=prev;
      if(msg){ msg.textContent='не сохранилось: '+(e.message||e); msg.style.color='var(--red)'; }
    }
  }

  /* ---------- демки ---------- */
  function openDemoModal(p){
    const m=$('#modal');
    m.innerHTML=`<div class="modal-card">
      <button class="dr-close" data-x>✕</button>
      <h3 style="margin:0 0 4px">Демка для «${esc(p.company)}»</h3>
      <div class="mut" style="font-size:12.5px;margin-bottom:16px">Три шага: скопировал промпт → сгенерил сайт → вставил ссылку сюда.</div>
      <div class="step"><span class="sn">1</span><div style="flex:1">
        <b>Промпт от Рокфеллера</b>
        <pre class="script" style="max-height:160px;margin-top:8px">${esc(p.gen_prompt||'промпта нет')}</pre>
        <button class="btn" id="mCopy" style="margin-top:8px">Скопировать промпт</button>
      </div></div>
      <div class="step"><span class="sn">2</span><div style="flex:1">
        <b>Собери демку</b>
        <div class="mut" style="font-size:12.5px;margin-top:4px">Вставь промпт в генератор, выложи результат (GitHub Pages).</div>
      </div></div>
      <div class="step"><span class="sn">3</span><div style="flex:1">
        <b>Вставь ссылку на готовую демку</b>
        <input id="mLink" placeholder="https://…" value="${esc(p.demo||'')}" style="margin-top:8px" />
        <div class="mut" style="font-size:12px;margin-top:6px">Сохраню ссылку и переведу лида в стадию «демка отправлена».</div>
      </div></div>
      <div class="row-inline" style="margin-top:18px">
        <button class="btn gold" id="mSave">Сохранить демку</button>
        <button class="btn" data-x>Закрыть</button>
        <span id="mMsg" class="mut" style="font-size:12.5px"></span>
      </div>
    </div>`;
    m.classList.add('open');
    $$('[data-x]',m).forEach(b=>b.onclick=closeModal);
    const cp=$('#mCopy');
    if(cp) cp.onclick=async()=>{
      try{ await navigator.clipboard.writeText(p.gen_prompt||''); cp.textContent='Скопировано ✓';
        setTimeout(()=>{cp.textContent='Скопировать промпт';},1800);
      }catch(e){ cp.textContent='Не вышло — выдели вручную'; }
    };
    $('#mSave').onclick=async()=>{
      const link=$('#mLink').value.trim(), msg=$('#mMsg');
      if(link && !/^https?:\/\//i.test(link)){ msg.textContent='ссылка должна начинаться с http://'; msg.style.color='var(--red)'; return; }
      msg.style.color=''; msg.textContent='сохраняю…';
      try{
        await window.VC.saveDemo(p.id, link||null);
        p.demo=link||null;
        if(link && FUNNEL.indexOf(stageOf(p))<FUNNEL.indexOf('demo_sent')){
          await window.VC.saveStage(p.id,'demo_sent',STAGES.demo_sent.pr);
          p.stage='demo_sent'; p.progress=STAGES.demo_sent.pr;
        }
        closeModal(); render();
        $('#drawer').classList.contains('open') && openProject(p.id);
      }catch(e){ msg.textContent='не сохранилось: '+(e.message||e); msg.style.color='var(--red)'; }
    };
  }
  function closeModal(){ const m=$('#modal'); m.classList.remove('open'); m.innerHTML=''; }

  /* ---------- drawer ---------- */
  function openProject(id){
    const p=DATA.projects.find(x=>String(x.id)===String(id)); if(!p) return;
    const canEdit=!!(USER&&USER.can&&USER.can.edit);
    const calls=window.VC.callsOf(p);
    const last=lastCall(p);
    $('#drawer').innerHTML=`
      <div class="dr-head"><button class="dr-close" onclick="VCUI.closeDrawer()">✕</button>
        <div class="co"><div class="logo ${STAGES[stageOf(p)].cls}" style="width:40px;height:40px">${initials(p.company)}</div>
          <div><div style="font-weight:700;font-size:16px">${esc(p.company)}</div>
          <div class="mut" style="font-size:12.5px">${esc(String(p.niche||'').slice(0,52))}${p.city?' · '+esc(p.city):''}</div></div></div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          ${p.type?typeTag(p.type):''}${stagePill(p)}
          ${p.rating?`<span class="pill s-new"><i></i>★ ${esc(rate(p.rating))}${p.reviews?' ('+esc(String(p.reviews))+' отз.)':''}</span>`:''}
          ${calls.length?`<span class="pill s-cont"><i></i>${plural(calls.length,'звонок','звонка','звонков')}</span>`:''}
        </div>
      </div>
      <div class="dr-body">
        ${canEdit?`<div class="dr-sec">Стадия — ставь руками</div>
          <select id="stageSel" class="stage-sel wide ${STAGES[stageOf(p)].cls}">${Object.entries(STAGES).map(([k,v])=>
            `<option value="${k}"${stageOf(p)===k?' selected':''}>${v.label}</option>`).join('')}</select>
          <div id="stageMsg" class="mut" style="font-size:12px;margin-top:6px">прогресс пересчитается сам</div>`
          :`<div class="dr-sec">Стадия</div><div>${stagePill(p)}</div>`}

        ${canEdit&&p.phone?`<div class="dr-sec">Звонок</div>
          <div class="row-inline"><button class="btn gold" id="callBtn">📞 Набрать ${esc(p.phone)}</button></div>
          <div id="outcomeBox" class="outcomes${last?' live':''}">
            <div class="mut" style="font-size:12px;margin:10px 0 8px">Чем закончился звонок?</div>
            <div class="out-row">${Object.entries(OUTCOMES).map(([k,v])=>
              `<button class="out ${last&&last.out===k?'on':''}" data-out="${k}">${v.ic} ${v.label}</button>`).join('')}</div>
            <div id="outMsg" class="mut" style="font-size:12px;margin-top:8px">${last?'последний: '+esc(ago(last.at)):''}</div>
          </div>`:''}

        ${canEdit?`<div class="dr-sec">Перезвонить</div>
          ${nextCallOf(p)?`<div class="row-inline">
              <span class="pill ${isDue(p)?'s-agr':'s-cont'}"><i></i>🔔 ${fmtDay(nextCallOf(p))}${isDue(p)?' — пора':''}</span>
              <button class="btn" id="ncClear">Убрать</button>
            </div>`
          :`<div class="row-inline">
              <button class="btn" data-nc="1">Завтра</button>
              <button class="btn" data-nc="3">+3 дня</button>
              <button class="btn" data-nc="7">Через неделю</button>
              <input type="date" id="ncDate" class="date-in" />
            </div>`}
          <div id="ncMsg" class="mut" style="font-size:12px;margin-top:6px">попадёт в «Пора перезвонить» на дашборде</div>`:''}

        <div class="dr-sec">Контакты</div>
        <div class="dr-row"><span class="l">Телефон</span><span class="v">${p.phone?`<a class="link" href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`:'—'}</span></div>
        <div class="dr-row"><span class="l">Почта</span><span class="v">${esc(p.email||'—')}</span></div>
        <div class="dr-row"><span class="l">Адрес</span><span class="v">${esc(p.address||'—')}</span></div>
        <div class="dr-row"><span class="l">Сайт</span><span class="v">${p.site?`<a class="link" href="${esc(p.site)}" target="_blank" rel="noopener">открыть ↗</a>`:'<span class="mut">нет сайта</span>'}</span></div>
        ${p.vk_link?`<div class="dr-row"><span class="l">ВКонтакте</span><span class="v"><a class="link" href="${esc(p.vk_link)}" target="_blank" rel="noopener">открыть ↗</a></span></div>`:''}
        ${p.source_url?`<div class="dr-row"><span class="l">2GIS</span><span class="v"><a class="link" href="${esc(p.source_url)}" target="_blank" rel="noopener">карточка ↗</a></span></div>`:''}

        ${p.issues?`<div class="dr-sec">Болячки сайта — зацепка для звонка</div>
          <div class="hint" style="margin:0"><span>⚠️</span><div>${esc(p.issues)}</div></div>`:''}
        ${p.call_script?`<div class="dr-sec">Скрипт звонка</div><pre class="script">${esc(p.call_script)}</pre>`:''}
        ${p.context?`<div class="dr-sec">Что нашли о компании</div><div class="ctx">${esc(p.context)}</div>`:''}

        <div class="dr-sec">Заметки</div>
        ${canEdit?`<textarea id="notesBox" rows="3" placeholder="что обсудили, о чём договорились…">${esc(p.notes||'')}</textarea>
          <div class="row-inline" style="margin-top:8px">
            <button class="btn" id="notesSave">Сохранить заметку</button>
            <span id="notesMsg" class="mut" style="font-size:12px"></span></div>`
          :`<div class="mut" style="font-size:13px">${esc(p.notes||'—')}</div>`}

        ${calls.length?`<div class="dr-sec">История звонков</div>
          <ul class="feed">${calls.slice().reverse().slice(0,8).map(c=>`
            <li><div class="fi">${(OUTCOMES[c.out]||{ic:'📞'}).ic}</div>
              <div style="flex:1"><div>${esc((OUTCOMES[c.out]||{label:'набрали, итог не отмечен'}).label)}</div>
              <div class="ft">${esc(c.by||'')} · ${esc(ago(c.at))}</div></div>
              ${canEdit?`<button class="mini del" data-drdel="${esc(c.at)}" title="убрать запись">✕</button>`:''}</li>`).join('')}</ul>`:''}

        <div class="dr-actions">
          ${p.site?`<a class="btn" href="${esc(p.site)}" target="_blank" rel="noopener">Сайт ↗</a>`:''}
          ${p.demo?`<a class="btn" href="${esc(p.demo)}" target="_blank" rel="noopener">Демо ↗</a>`:''}
          ${canEdit&&p.gen_prompt?`<button class="btn gold" id="demoBtn">${p.demo?'Заменить демку':'Сделать демку'}</button>`:''}
          ${canEdit?`<button class="btn" id="aiReviewBtn">🧾 ИИ-разбор звонка</button>`:''}
        </div>
      </div>`;
    $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden','false');
    $('#drawerScrim').classList.add('open');

    const sel=$('#stageSel');
    if(sel) sel.onchange=()=>changeStage(p, sel.value, sel, $('#stageMsg'));
    const cb=$('#callBtn'); if(cb) cb.onclick=()=>doCall(p);
    $$('.out').forEach(b=>b.onclick=()=>setOutcome(p, b.dataset.out));
    /* напоминание «перезвонить» */
    const setNc=async iso=>{
      const msg=$('#ncMsg');
      try{ await window.VC.saveRaw(p,{next_call:iso}); openProject(p.id); render(); }
      catch(e){ if(msg){ msg.textContent='не сохранилось: '+(e.message||e); msg.style.color='var(--red)'; } }
    };
    $$('[data-nc]').forEach(b=>b.onclick=()=>{
      const d=new Date(); d.setDate(d.getDate()+Number(b.dataset.nc)); d.setHours(10,0,0,0);
      setNc(d.toISOString());
    });
    const ncd=$('#ncDate');
    if(ncd) ncd.onchange=()=>{ if(!ncd.value) return; const d=new Date(ncd.value+'T10:00:00'); setNc(d.toISOString()); };
    const ncc=$('#ncClear'); if(ncc) ncc.onclick=()=>setNc(null);
    const db_=$('#demoBtn'); if(db_) db_.onclick=()=>openDemoModal(p);
    const ar=$('#aiReviewBtn');
    if(ar) ar.onclick=()=>{ TR.leadId=p.id; TR.tab='review'; closeDrawer(); go('trainer'); };
    $$('#drawer button[data-drdel]').forEach(b=>b.onclick=async()=>{
      try{ if(await deleteCall(p.id, b.dataset.drdel)){ openProject(p.id); render(); } }
      catch(err){ alert('Не удалилось: '+(err.message||err)); }
    });
    const nb=$('#notesSave');
    if(nb) nb.onclick=async()=>{
      const msg=$('#notesMsg'); msg.textContent='сохраняю…'; msg.style.color='';
      try{
        const val=$('#notesBox').value;
        await window.VC.saveNotes(p.id, val);
        p.notes=val; msg.textContent='сохранено'; msg.style.color='var(--green)';
        const inp=document.querySelector(`input[data-note="${p.id}"]`); if(inp) inp.value=val;
      }catch(e){ msg.textContent='не сохранилось: '+(e.message||e); msg.style.color='var(--red)'; }
    };
  }
  function closeDrawer(){ $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden','true'); $('#drawerScrim').classList.remove('open'); }

  async function deleteCall(id, at){
    const p=DATA.projects.find(x=>String(x.id)===String(id)); if(!p) return false;
    if(!confirm('Убрать эту запись из журнала звонков?')) return false;
    const calls=window.VC.callsOf(p).filter(c=>c.at!==at);
    await window.VC.saveRaw(p,{calls:calls});
    return true;
  }

  /* Перекрашиваем строку под новую стадию вручную — иначе полная перерисовка
     таблицы уводит фокус и прокрутку. */
  function paintStage(p){
    const val=stageOf(p), cls=STAGES[val].cls, all=Object.values(STAGES).map(v=>v.cls);
    const sel=document.querySelector(`select[data-stage="${p.id}"]`);
    if(sel){ sel.classList.remove(...all); sel.classList.add(cls); sel.value=val; }
    const tr=document.querySelector(`tr[data-id="${p.id}"]`);
    if(tr){
      tr.classList.remove(...all); tr.classList.add(cls);
      const lg=tr.querySelector('.logo');
      if(lg){ lg.classList.remove(...all); lg.classList.add(cls); }
      tr.classList.add('flash'); setTimeout(()=>tr.classList.remove('flash'),700);
    }
    const dsel=$('#stageSel');
    if(dsel){ dsel.classList.remove(...all); dsel.classList.add(cls); dsel.value=val; }
  }

  /* Стадию меняем точечно — без перерисовки таблицы. */
  async function changeStage(p, val, el, msg){
    const prev=stageOf(p);
    if(msg){ msg.textContent='сохраняю…'; msg.style.color=''; }
    try{
      const pr=STAGES[val].pr;
      await window.VC.saveStage(p.id, val, pr);
      p.stage=val; p.progress=pr;
      paintStage(p);
      /* дата оплаты — для помесячной выручки в «Деньгах» */
      if(val==='paid'){
        const m=moneyOf(p)||{};
        if(!m.paid_at) await window.VC.saveRaw(p,{money:{percent:pctOf(m),...m,paid_at:new Date().toISOString()}});
      }
      if(msg){ msg.textContent='сохранено'; msg.style.color='var(--green)'; }
    }catch(e){
      p.stage=prev; if(el) el.value=prev;
      if(msg){ msg.textContent='не сохранилось: '+(e.message||e); msg.style.color='var(--red)'; }
      else alert('Стадия не сохранилась: '+(e.message||e));
    }
  }

  /* ---------- render ---------- */
  function render(){
    $('#pageTitle').textContent=(NAV.find(n=>n.id===view)||NAV[0]).label;
    $('#pageSub').textContent=SUB[view]||'';
    $('#view').innerHTML=(V[view]||V.dashboard)();
    $$('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.id===view));

    $$('tr[data-id]').forEach(tr=>tr.onclick=e=>{
      if(e.target.closest('button,select,input,a')) return;
      openProject(tr.dataset.id);
    });
    $$('.chip[data-filter]').forEach(c=>c.onclick=()=>{ pFilter=c.dataset.filter; render(); });

    $$('select[data-stage]').forEach(s=>{
      const p=DATA.projects.find(x=>String(x.id)===s.dataset.stage);
      s.onchange=()=>changeStage(p, s.value, s, null);
    });
    /* Заметка сохраняется по Enter или когда уходишь из поля — без кнопок. */
    $$('input[data-note]').forEach(inp=>{
      const p=DATA.projects.find(x=>String(x.id)===inp.dataset.note);
      let base=inp.value;
      const save=async()=>{
        const val=inp.value.trim();
        if(val===base) return;
        inp.classList.remove('bad'); inp.classList.add('saving');
        try{ await window.VC.saveNotes(p.id, val); p.notes=val; base=val;
          inp.classList.remove('saving'); inp.classList.add('saved');
          setTimeout(()=>inp.classList.remove('saved'),900);
        }catch(e){ inp.classList.remove('saving'); inp.classList.add('bad'); inp.title='не сохранилось: '+(e.message||e); }
      };
      inp.onblur=save;
      inp.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); } if(e.key==='Escape'){ inp.value=base; inp.blur(); } };
    });
    $$('button[data-call]').forEach(b=>{
      const p=DATA.projects.find(x=>String(x.id)===b.dataset.call);
      b.onclick=e=>{ e.stopPropagation(); doCall(p); };
    });
    $$('button[data-demo]').forEach(b=>{
      const p=DATA.projects.find(x=>String(x.id)===b.dataset.demo);
      b.onclick=e=>{ e.stopPropagation(); openDemoModal(p); };
    });
    /* дашборд: клик по «пора перезвонить» открывает карточку */
    $$('[data-open]').forEach(b=>b.onclick=()=>openProject(b.dataset.open));
    /* деньги: сумма и % сохраняются по blur/Enter */
    const wireMoney=(attr,apply)=>$$(`input[${attr}]`).forEach(inp=>{
      const p=DATA.projects.find(x=>String(x.id)===inp.getAttribute(attr));
      let base=inp.value;
      const save=async()=>{
        if(inp.value===base) return;
        const v=parseFloat(String(inp.value).replace(/\s/g,'').replace(',','.'));
        inp.classList.remove('bad');
        try{
          const m=moneyOf(p)||{};
          await window.VC.saveRaw(p,{money:apply(m,isFinite(v)?v:null)});
          base=inp.value; render();
        }catch(e){ inp.classList.add('bad'); inp.title='не сохранилось: '+(e.message||e); }
      };
      inp.onblur=save;
      inp.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); } if(e.key==='Escape'){ inp.value=base; inp.blur(); } };
    });
    wireMoney('data-amt',(m,v)=>({percent:pctOf(m),...m,amount:v}));
    wireMoney('data-pct',(m,v)=>({...m,percent:v==null?window.VC.CONFIG.managerPercent:Math.min(100,Math.max(0,v))}));

    if(view==='import') wireImport();
    if(view==='shield') wireShield();
    if(view==='trainer') wireTrainer();
    if(view==='team') renderTeam();
    const nx=$('#nextCallBtn'); if(nx) nx.onclick=nextLead;
    /* удаление записи из журнала звонков */
    $$('button[data-delcall]').forEach(b=>b.onclick=async e=>{
      e.stopPropagation();
      const [id,at]=b.dataset.delcall.split('::');
      try{ if(await deleteCall(id,at)) render(); }
      catch(err){ alert('Не удалилось: '+(err.message||err)); }
    });

    const ib=$('#inviteBtn');
    if(ib){
      renderInvites();
      ib.onclick=async()=>{
        const t=ib.textContent; ib.disabled=true; ib.textContent='Создаю…';
        try{
          const roleSel=$('#inviteRole');
          const code=await window.VCAuth.createInvite(roleSel?roleSel.value:'manager');
          $('#inviteNew').innerHTML=`<div class="hint" style="margin:0"><span>🔑</span><div>Новый код: <code style="font-size:15px">${esc(code)}</code><br><span class="mut">Отдайте его сотруднику — он введёт его при регистрации. Код одноразовый.</span></div></div>`;
          renderInvites();
        }catch(e){ $('#inviteNew').innerHTML=`<span style="color:var(--red);font-size:13px">${esc(window.VCAuth.humanError(e))}</span>`; }
        finally{ ib.disabled=false; ib.textContent=t; }
      };
    }
  }
  function go(id){ view=id; if(view!=='projects') q=''; render(); }

  /* Режим обзвона: кому звонить прямо сейчас. Приоритет:
     просроченные напоминания → новые со скриптом (рейтинг выше — раньше) → новые → «связались». */
  function nextLead(){
    const P=DATA.projects.filter(p=>p.phone);
    const cand=
      P.filter(isDue).sort((a,b)=>String(nextCallOf(a)).localeCompare(String(nextCallOf(b))))[0]
      ||P.filter(p=>stageOf(p)==='new'&&p.processed).sort((a,b)=>(Number(b.rating)||0)-(Number(a.rating)||0))[0]
      ||P.filter(p=>stageOf(p)==='new')[0]
      ||P.filter(p=>stageOf(p)==='contacted')[0];
    if(cand) openProject(cand.id);
    else alert('Некому звонить: ни напоминаний, ни новых лидов с телефоном.');
  }

  function renderNav(){
    const raw=DATA.projects.filter(p=>stageOf(p)==='new').length;
    const due=DATA.projects.filter(isDue).length;
    $('#nav').innerHTML='<div class="nav-sec">агентство</div>'+NAV
      .filter(n=>!n.finance||(USER&&USER.can&&USER.can.finance))
      .map(n=>`
      <a class="nav-item" data-id="${n.id}">
        <span class="ic">${svg(ICONS[n.id])}</span><span class="lbl">${n.label}</span>
        ${n.id==='projects'&&raw?`<span class="badge">${raw}</span>`:''}
        ${n.id==='dashboard'&&due?`<span class="badge hot">${due}</span>`:''}
      </a>`).join('');
    $$('.nav-item').forEach(n=>n.onclick=()=>go(n.dataset.id));
  }

  function renderUser(){
    if(!USER) return;
    $('#userAva').textContent=initials(USER.name||USER.email||'?');
    $('#userName').textContent=USER.name||USER.email;
    $('#userRole').textContent=USER.role||'';
    const lo=$('#logoutBtn');
    if(window.VCAuth.enabled()){
      lo.hidden=false;
      lo.onclick=async()=>{ await window.VCAuth.signOut(); location.reload(); };
    }
  }

  async function start(user){
    USER=user;
    DATA=await window.VC.loadData();
    if(DATA._source==='db'){ $('#srcPill').classList.add('live'); $('#srcLabel').textContent=DATA.projects.length+' лидов в базе'; }
    else { $('#srcLabel').textContent='база недоступна'; }
    renderNav(); render(); renderUser();
    $('#collapseBtn').onclick=()=>$('#app').classList.toggle('collapsed');
    $('#drawerScrim').onclick=closeDrawer;
    document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeDrawer(); closeModal(); } });
    $('#refreshBtn').onclick=async()=>{ DATA=await window.VC.loadData(); renderNav(); render(); };
    const s=$('#globalSearch');
    s.oninput=()=>{ q=s.value.trim().toLowerCase(); if(view!=='projects') view='projects'; render(); };
  }

  function showLogin(){
    const el=$('#login'); el.hidden=false;
    let mode='login';
    const nameEl=$('#loginName'), codeEl=$('#loginCode'), btn=$('#loginBtn'), toggle=$('#loginToggle'), err=$('#loginErr');
    function applyMode(){
      const signup=mode==='signup';
      nameEl.hidden=!signup; nameEl.required=signup;
      codeEl.hidden=!signup; codeEl.required=signup;
      btn.textContent=signup?'Создать аккаунт':'Войти';
      toggle.textContent=signup?'← у меня уже есть аккаунт':'У меня есть код приглашения';
      $('#loginPass').setAttribute('autocomplete', signup?'new-password':'current-password');
      err.textContent='';
    }
    toggle.onclick=()=>{ mode=(mode==='login'?'signup':'login'); applyMode(); };
    applyMode();
    $('#loginForm').onsubmit=async e=>{
      e.preventDefault();
      const label=btn.textContent;
      btn.disabled=true; btn.textContent='Минуту…'; err.textContent='';
      try{
        const email=$('#loginEmail').value.trim(), pass=$('#loginPass').value;
        if(mode==='signup') await window.VCAuth.signUpWithCode(email, pass, nameEl.value.trim(), codeEl.value.trim());
        await window.VCAuth.signIn(email, pass);
        el.hidden=true;
        await start(await window.VCAuth.currentUser());
      }catch(ex){ err.textContent=window.VCAuth.humanError(ex); }
      finally{ btn.disabled=false; btn.textContent=label; }
    };
  }

  async function boot(){
    const user=await window.VCAuth.currentUser();
    if(window.VCAuth.enabled() && !user){ showLogin(); return; }
    await start(user);
  }

  window.VCUI={ closeDrawer, closeModal };
  document.addEventListener('DOMContentLoaded', boot);
})();
