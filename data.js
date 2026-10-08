/* Vertux Workspace — данные.
 * Источник правды — твоя Supabase (таблица public.projects). Демо-цифр здесь нет:
 * всё, что показывает приложение, либо лежит в базе, либо честно пишет «нет данных». */

const CONFIG = {
  productSlug: 'vertux-workspace',
  nexusOrigin: 'https://nexus.vertux.online',
  productBridgeOrigin: 'https://workspace.vertux.online',
  nexusRequired: true,
  supabaseUrl: 'https://vertuxdb.duckdns.org',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgyMDkxMjExLCJleHAiOjIwOTc0NTEyMTF9.Kj4VayNI8XRINRxNyq037_t8LLsn0IeNwblzuJu9AqI',

  // Защищённый тренер: отдельная служба, текущие права Nexus и постоянный бюджет.
  // Rockefeller передаёт готовый CSV/XLSX. Браузерный мост не реализован.
  // Четыре режима проверены живыми запросами 2026-10-08; общий бюджет $5.
  aiShieldAuthority: true,
  // Desktop strips Authorization on Nexus-origin requests. The dedicated data
  // plane validates this product-scoped Supabase session itself.
  aiUrl: 'https://zxcqweksn8n.duckdns.org/webhook/vertux-ai-trainer',

  // Доля менеджера с оплаченной сделки по умолчанию, % (правится в каждой сделке).
  managerPercent: 35,
};

// Снимаем tracked authority один раз при загрузке: подмена публичного CONFIG в
// DevTools или другим runtime-кодом не должна включать непроверенный webhook.
const AI_SHIELD_AUTHORIZED=CONFIG.aiShieldAuthority===true;

function safeHttpUrl(value){
  const raw=String(value==null?'':value).trim();
  if(!raw||raw.length>2048||/[\u0000-\u001F\u007F]/u.test(raw)) return '';
  try{
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password) return '';
    return url.href;
  }catch(_){ return ''; }
}

function safeHttpsUrl(value){
  const href=safeHttpUrl(value);
  return href&&new URL(href).protocol==='https:'?href:'';
}

function exactHttpsAssetUrl(value,expectedOrigin,expectedPath){
  const href=safeHttpsUrl(value);
  if(!href) return '';
  const url=new URL(href);
  return url.origin===expectedOrigin
    &&url.pathname===expectedPath
    &&!url.search
    &&!url.hash
    ?url.href:'';
}

/* ---------- Разбор CSV / XLSX ---------- */
function sniffDelim(line){
  const c={',':0,';':0,'\t':0}; let q=false;
  for(const ch of line){ if(ch==='"') q=!q; else if(!q && ch in c) c[ch]++; }
  const best=Object.keys(c).sort((a,b)=>c[b]-c[a])[0];
  return c[best]?best:',';
}
function parseCSV(text, delim){
  text=String(text).replace(/^﻿/,'');
  const d=delim||sniffDelim(text.split('\n')[0]||'');
  const rows=[]; let row=[], cur='', q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=c; }
    else if(c==='"') q=true;
    else if(c===d){ row.push(cur); cur=''; }
    else if(c==='\n'){ row.push(cur); rows.push(row); row=[]; cur=''; }
    else if(c!=='\r') cur+=c;
  }
  if(cur.length||row.length){ row.push(cur); rows.push(row); }
  return rows.filter(r=>r.some(x=>String(x).trim()!==''));
}
function rowsToObjects(rows){
  if(!rows.length) return [];
  const head=rows[0].map(h=>String(h).trim());
  return rows.slice(1).map(r=>{
    const o={}; head.forEach((h,i)=>{ o[h]=r[i]==null?'':String(r[i]).trim(); }); return o;
  });
}
/* SheetJS подгружаем только если реально бросили .xlsx.
 * Файл лежит рядом (vendor/) — CDN в РФ заблокирован. */
let xlsxLoading=null;
function loadXLSX(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  if(!xlsxLoading) xlsxLoading=new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src='vendor/xlsx.full.min.js';
    s.onload=()=>res(window.XLSX); s.onerror=()=>{ xlsxLoading=null; s.remove(); rej(new Error('Не удалось загрузить обработчик XLSX. Проверьте соединение и выберите файл ещё раз.')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}
async function readFileRows(file){
  const name=(file.name||'').toLowerCase();
  if(name.endsWith('.xlsx')||name.endsWith('.xls')){
    const XLSX=await loadXLSX();
    const wb=XLSX.read(await file.arrayBuffer(),{type:'array'});
    const sheet=wb.Sheets[wb.SheetNames[0]];
    const arr=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false});
    return rowsToObjects(arr.filter(r=>r.some(x=>String(x).trim()!=='')));
  }
  return rowsToObjects(parseCSV(await file.text()));
}

/* Отпечаток и локальный журнал защищают от случайной повторной загрузки одного
 * и того же файла. Журнал пишется только ПОСЛЕ успешного импорта. */
const IMPORT_HISTORY_KEY='vertux_workspace_import_history_v1';
async function fileFingerprint(file){
  if(!window.crypto||!window.crypto.subtle) throw new Error('браузер не поддерживает безопасную проверку файла');
  const digest=await window.crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function importHistory(){
  try{
    const value=JSON.parse(localStorage.getItem(IMPORT_HISTORY_KEY)||'[]');
    return Array.isArray(value)?value:[];
  }catch(e){ return []; }
}
function findImported(hash){ return importHistory().find(item=>item&&item.hash===hash)||null; }
function rememberImport(entry){
  try{
    const history=importHistory().filter(item=>item&&item.hash!==entry.hash);
    history.unshift(entry);
    localStorage.setItem(IMPORT_HISTORY_KEY,JSON.stringify(history.slice(0,50)));
  }catch(e){ console.warn('[Workspace] не удалось сохранить локальный журнал импорта'); }
}

/* ---------- Форматы источников ---------- */
const SOCIAL=/(t\.me|telegram|vk\.com|instagram|facebook|wa\.me|whatsapp|youtube|max\.ru|ok\.ru|api\.whatsapp)/i;
const pick=(o,...keys)=>{ for(const k of keys){ const actual=Object.keys(o).find(x=>x.trim().toLowerCase()===k.toLowerCase()); const v=o[actual]; if(v!=null&&String(v).trim()!=='') return String(v).trim(); } return ''; };
const num=v=>{ const n=parseFloat(String(v).replace(',','.')); return isFinite(n)?n:null; };
const int=v=>{ const n=parseInt(String(v).replace(/\s/g,''),10); return isFinite(n)?n:null; };
const multi=(o,base,n=3)=>{ const a=[]; for(let i=1;i<=n;i++){ const v=pick(o,base+' '+i); if(v) a.push(v); } return a; };

const FORMATS=[
  {
    id:'rockfeller', label:'Рокфеллер (готовый список для обзвона)',
    detect:h=>h.includes('company')&&(h.includes('call_script')||h.includes('antigravity_prompt')||h.includes('type')),
    map:o=>{
      const t=pick(o,'Type').toLowerCase();
      return {
        company:pick(o,'Company'),
        phone:pick(o,'Phone'), city:pick(o,'City'), niche:pick(o,'Category'),
        type:(t==='creation'||t==='redesign')?t:null,
        site:pick(o,'Website'), issues:pick(o,'Issues'), context:pick(o,'Context'),
        call_script:pick(o,'Call_Script'), gen_prompt:pick(o,'Antigravity_Prompt'),
        vk_link:pick(o,'VK_Link'), source_url:pick(o,'Source_URL'),
        processed:true, source:'rockfeller',
      };
    },
  },
  {
    id:'2gis', label:'Сырьё из 2GIS-парсера',
    detect:h=>h.includes('наименование')||h.includes('2gis url'),
    map:o=>{
      const sites=multi(o,'Веб-сайт');
      const real=sites.find(s=>!SOCIAL.test(s))||'';
      return {
        company:pick(o,'Наименование'),
        niche:pick(o,'Рубрики'), address:pick(o,'Адрес'), city:pick(o,'Город'),
        rating:num(pick(o,'Рейтинг')), reviews:int(pick(o,'Количество отзывов')),
        phone:pick(o,'Телефон 1'), email:pick(o,'E-mail 1'),
        site:real, vk_link:pick(o,'ВКонтакте 1'), source_url:pick(o,'2GIS URL'),
        context:pick(o,'Описание'),
        contacts:{
          phones:multi(o,'Телефон'), emails:multi(o,'E-mail'), sites:sites,
          telegram:multi(o,'Telegram'), whatsapp:multi(o,'WhatsApp'), instagram:multi(o,'Instagram'),
          hours:pick(o,'Часы работы'),
        },
        processed:false, source:'2gis',
      };
    },
  },
];

const normName=s=>String(s||'').trim().toLowerCase();
/* Эти поля — твоя работа руками. Слияние их не трогает НИКОГДА. */
const PROTECTED=['stage','progress','notes','demo','shield','blocks','launched','server','raw'];

function detectFormat(objs){
  if(!objs.length) return null;
  const h=Object.keys(objs[0]).map(k=>k.toLowerCase());
  return FORMATS.find(f=>f.detect(h))||null;
}
/* Файл → строки под схему БД. Пустые company выбрасываем, дубли внутри файла схлопываем. */
function mapRows(objs, fmt){
  const seen=new Set(); const out=[]; let skipped=0, dupes=0;
  for(const o of objs){
    const r=fmt.map(o);
    if(!r.company){ skipped++; continue; }
    const key=window.WorkspaceCore.identityKey(r);
    if(seen.has(key)){ dupes++; continue; }
    seen.add(key);
    Object.keys(r).forEach(k=>{ if(r[k]===''||r[k]==null) delete r[k]; });
    r.raw=o;
    out.push(r);
  }
  return { rows:out, skipped:skipped, dupes:dupes };
}

/* ---------- Supabase ---------- */
const db=()=>{
  const c=window.VCAuth&&window.VCAuth.client&&window.VCAuth.client();
  if(!c) throw new Error('нет соединения с базой');
  return c;
};

async function readProjectPages(columns='*'){
  const c=db(), rows=[];
  for(let offset=0;offset<50000;offset+=500){
    const {data,error}=await c.from('projects').select(columns).order('id',{ascending:true}).range(offset,offset+499);
    if(error) throw error;
    rows.push(...(data||[]));
    if(!data||data.length<500) return rows;
  }
  throw new Error('База превышает лимит загрузки. Импорт остановлен, чтобы не создавать дубли.');
}
async function loadProjects(){
  const c=window.VCAuth&&window.VCAuth.client&&window.VCAuth.client();
  if(!c) return null;
  return (await readProjectPages('*,finance:workspace_project_finance(money,updated_at)')).sort((a,b)=>Number(Boolean(b.processed))-Number(Boolean(a.processed))||(Number(b.rating)||0)-(Number(a.rating)||0));
}

async function savePatch(id, patch){
  const { data,error } = await db().from('projects')
    .update({ ...patch, updated_at:new Date().toISOString() }).eq('id', id).select('id').maybeSingle();
  if(error) throw error;
  if(!data) throw new Error('Запись не сохранена: нет доступа или карточка уже удалена. Обновите базу.');
}
const saveStage=(id,stage,progress)=>savePatch(id,{stage:stage,progress:progress});
const saveNotes=(id,notes)=>savePatch(id,{notes:notes});
const saveDemo=(id,demo)=>savePatch(id,{demo:demo});

/* Журнал и напоминания сохраняются в raw. Деньги отделены в таблицу с RLS
 * owner/admin; скрытие раздела в интерфейсе не используется как защита. */
const rowWrites=new Map();
function saveRaw(project, patch){
  const id=String(project.id);
  const task=(rowWrites.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
    for(let attempt=0;attempt<3;attempt++){
      const {data:current,error:readError}=await db().from('projects').select('raw,updated_at').eq('id',id).single();
      if(readError||!current) throw new Error('Не удалось прочитать карточку перед сохранением. Обновите базу.');
      const raw=current.raw&&typeof current.raw==='object'&&!Array.isArray(current.raw)?current.raw:{};
      const change=typeof patch==='function'?patch(raw):patch;
      if(Object.prototype.hasOwnProperty.call(change,'money')) throw new Error('Деньги сохраняются отдельно от карточки. Обновите Workspace.');
      const next={...raw,...change};
      const stamp=new Date(Math.max(Date.now(),(new Date(current.updated_at).getTime()||0)+1)).toISOString();
      let query=db().from('projects').update({raw:next,updated_at:stamp}).eq('id',id);
      query=current.updated_at?query.eq('updated_at',current.updated_at):query.is('updated_at',null);
      const {data:saved,error}=await query.select('id').maybeSingle();
      if(error) throw error;
      if(saved){project.raw=next;project.updated_at=stamp;return next;}
    }
    throw new Error('Карточку изменил другой сотрудник. Обновите данные и повторите сохранение.');
  });
  rowWrites.set(id,task);
  task.finally(()=>{if(rowWrites.get(id)===task)rowWrites.delete(id);}).catch(()=>{});
  return task;
}

const financeWrites=new Map();
function saveMoney(project,patch){
  const id=String(project.id);
  const task=(financeWrites.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
    for(let attempt=0;attempt<3;attempt++){
      const table=db().from('workspace_project_finance');
      const {data:current,error:readError}=await table.select('money,updated_at').eq('project_id',id).maybeSingle();
      if(readError)throw readError;
      const before=current?.money||{};
      const money=typeof patch==='function'?patch(before):{...before,...patch};
      const stamp=new Date(Math.max(Date.now(),(new Date(current?.updated_at).getTime()||0)+1)).toISOString();
      let query=db().from('workspace_project_finance');
      query=current?query.update({money,updated_at:stamp}).eq('project_id',id).eq('updated_at',current.updated_at):query.insert({project_id:id,money,updated_at:stamp});
      const {data:saved,error}=await query.select('project_id').maybeSingle();
      if(error?.code==='23505')continue;
      if(error)throw error;
      if(saved){project.finance={money,updated_at:stamp};return money;}
    }
    throw new Error('Деньги не сохранены: нет доступа или запись изменена. Обновите данные.');
  });
  financeWrites.set(id,task);
  task.finally(()=>{if(financeWrites.get(id)===task)financeWrites.delete(id);}).catch(()=>{});
  return task;
}

async function logCall(project, entry){
  const saved=await saveRaw(project,raw=>{
    const calls=Array.isArray(raw.calls)?raw.calls.slice():[];
    if(!calls.some(c=>entry.id?c.id===entry.id:c.at===entry.at)) calls.push(entry);
    return {calls};
  });
  return saved.calls;
}
const callsOf=p=>{
  const r=p&&p.raw; const a=r&&typeof r==='object'&&r.calls;
  return Array.isArray(a)?a:[];
};

/* ---------- Импорт ---------- */
/* Считаем, что упадёт, ДО того как что-то трогаем в базе. */
async function planImport(rows){
  const data=await readProjectPages('id,company,phone,city,address,source_url');
  const fresh=[], existing=[], conflicts=[];
  rows.forEach(r=>{
    const match=window.WorkspaceCore.matchLead(r,data);
    if(match.kind==='existing') existing.push({ ...r, id:match.id });
    else if(match.kind==='conflict') conflicts.push(r);
    else fresh.push(r);
  });
  return {fresh,existing,conflicts,total:data.length};
}

async function runImport(plan, mode, onProgress, meta){
  if(mode==='replace'){
    throw new Error('полная замена отключена: сначала нужен серверный импорт с транзакцией и откатом');
  }
  if(!['merge','add'].includes(mode)) throw new Error('Неизвестный режим импорта');

  const c=db();
  const report={ added:0, enriched:0, skipped:(plan.conflicts||[]).length, deleted:0, batchId:(meta&&meta.batchId)||null };
  const say=m=>{ if(onProgress) onProgress(m); };

  const importMeta=meta?{
    batch_id:meta.batchId||null, file_hash:meta.hash||null, file_name:meta.file||null,
    source:meta.source||null, imported_at:new Date().toISOString(),
  }:null;
  const toInsert=plan.fresh;
  for(let i=0;i<toInsert.length;i+=100){
    const chunk=toInsert.slice(i,i+100).map(r=>({
      ...r, stage:'new', progress:5,
      raw:importMeta?{ ...((r.raw&&typeof r.raw==='object')?r.raw:{}), _import:importMeta }:r.raw,
    }));
    say('добавляю '+(i+chunk.length)+' из '+toInsert.length+'…');
    const { error } = await c.from('projects').insert(chunk);
    if(error) throw error;
    report.added+=chunk.length;
  }

  if(mode==='merge'){
    for(let i=0;i<plan.existing.length;i+=100){
      const chunk=plan.existing.slice(i,i+100).map(r=>{
        const x={ ...r, updated_at:new Date().toISOString() };
        PROTECTED.forEach(k=>{ delete x[k]; });
        Object.keys(x).forEach(k=>{if(x[k]===null||x[k]===undefined||x[k]==='')delete x[k];});
        if(x.processed!==true) delete x.processed;
        return x;
      });
      say('обогащаю '+(i+chunk.length)+' из '+plan.existing.length+'…');
      for(const row of chunk){
        const {id,...patch}=row;
        const {data:saved,error}=await c.from('projects').update(patch).eq('id',id).select('id').maybeSingle();
        if(error) throw error;
        if(!saved) throw new Error('Компания исчезла или недоступна. Выбери файл снова для пересчёта импорта.');
        report.enriched++;
      }
    }
  } else if(mode==='add'){
    report.skipped+=plan.existing.length;
  }
  return report;
}

/* ---------- Вебхуки n8n (ключи и SQL живут на сервере, не в браузере) ---------- */
async function hookCall(url, payload){
  if(!AI_SHIELD_AUTHORIZED) throw new Error('AI-тренер отключён до подтверждения Vertux Shield');
  const endpoint=safeHttpsUrl(url);
  if(!endpoint) throw new Error('не настроено');
  let token='';
  try{
    const c=window.VCAuth&&window.VCAuth.client&&window.VCAuth.client();
    if(c){ const { data }=await c.auth.getSession(); token=(data&&data.session&&data.session.access_token)||''; }
  }catch(e){}
  if(!token) throw new Error('Сессия завершилась. Повтори вход через Nexus.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
  try{
    const res=await fetch(endpoint,{
      method:'POST',redirect:'error',cache:'no-store',signal:controller.signal,
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
      body:JSON.stringify(payload||{}),
    });
    const j=await res.json().catch(()=>null);
    const messages={401:'Сессия завершилась. Повтори вход через Nexus.',403:'Тренер недоступен для этого аккаунта.',404:'Сервис тренера ещё не подключён.',429:'Лимит тренера исчерпан. Попробуй позже.',503:'Тренер временно недоступен. Попробуй позже.'};
    if(j?.error==='total_budget_exhausted')throw new Error('Общий бюджет ИИ исчерпан. Автоматического пополнения нет — обратись к владельцу Workspace.');
    if(j?.error==='daily_budget_exhausted')throw new Error('Суточный лимит ИИ исчерпан. Он обновится после 03:00 МСК, если общий бюджет ещё доступен.');
    if(res.status===413)throw new Error('Текст слишком длинный. Сократи диалог или отправь отдельный фрагмент.');
    if(!res.ok||!j||j.error) throw new Error(messages[res.status]||'Тренер не смог ответить. Текст сохранён на экране; запрос можно повторить.');
    if(payload.mode!=='health'&&(!j.text||typeof j.text!=='string')) throw new Error('Тренер вернул пустой ответ. Попробуй ещё раз.');
    return j;
  }catch(e){
    if(e.name==='AbortError') throw new Error('Тренер не ответил за 45 секунд. Текст сохранён; повтори запрос позже.');
    throw e;
  }finally{clearTimeout(timer);}
}
const aiCall=(mode,payload)=>hookCall(CONFIG.aiUrl,{ ...(payload||{}),mode:mode,requestId:window.crypto.randomUUID() });

async function hookActive(url){
  if(!AI_SHIELD_AUTHORIZED) return false;
  const endpoint=safeHttpsUrl(url);
  if(!endpoint) return false;
  try{
    const body=await hookCall(endpoint,{mode:'health'});
    return body.ok===true&&body.service==='vertux-trainer'&&body.ready===true;
  }catch(e){ return false; }
}
async function probeAI(){CONFIG.aiActive=await hookActive(CONFIG.aiUrl);return CONFIG.aiActive;}

async function loadData(){
  const [projects,aiActive]=await Promise.all([
    loadProjects(),
    AI_SHIELD_AUTHORIZED?hookActive(CONFIG.aiUrl):Promise.resolve(false),
  ]);
  CONFIG.aiActive=aiActive;
  return { projects:projects||[], _source:projects?'db':'offline' };
}

window.VC = {
  CONFIG, loadData, loadProjects,
  safeHttpUrl, safeHttpsUrl, exactHttpsAssetUrl,
  saveStage, saveNotes, saveDemo, savePatch, saveRaw, saveMoney,
  logCall, callsOf, aiCall, probeAI,
  readFileRows, fileFingerprint, findImported, rememberImport,
  detectFormat, mapRows, planImport, runImport,
  FORMATS,
};
