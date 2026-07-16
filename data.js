/* Vertux Workspace — данные.
 * Источник правды — твоя Supabase (таблица public.projects). Демо-цифр здесь нет:
 * всё, что показывает приложение, либо лежит в базе, либо честно пишет «нет данных». */

const CONFIG = {
  supabaseUrl: 'https://vertuxdb.duckdns.org',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgyMDkxMjExLCJleHAiOjIwOTc0NTEyMTF9.Kj4VayNI8XRINRxNyq037_t8LLsn0IeNwblzuJu9AqI',

  // Мост к n8n и OpenRouter (вкл/выкл виджетов, баланс ключа).
  // Пусто → кнопки управления скрыты. Заполняется после деплоя
  // edge-функции widget-bridge (см. backend/README.md).
  bridgeUrl: '',

  // Доля менеджера с оплаченной сделки по умолчанию, % (правится в каждой сделке).
  managerPercent: 35,
};

/* Наши собственные виджеты — для раздела Shield.
 * Метрики (сколько заблокировано, последний алерт) пока не подключены к n8n,
 * поэтому их здесь нет: лучше «нет данных», чем выдуманное число. */
const WIDGETS = [
  // workflowId — id воркфлоу в n8n; нужен мосту, чтобы включать/выключать виджет.
  { company:'Vertux (портфолио)', site:'https://vertux.online', niche:'Своё агентство', server:'vpn8n', shield:true,  state:'live', workflowId:'' },
  { company:'КовроСити',          site:'https://kovrocity.ru',  niche:'Химчистка ковров', server:'vpn8n', shield:false, state:'work', workflowId:'' },
];

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
    s.onload=()=>res(window.XLSX); s.onerror=()=>rej(new Error('не удалось загрузить читалку XLSX'));
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

/* ---------- Форматы источников ---------- */
const SOCIAL=/(t\.me|telegram|vk\.com|instagram|facebook|wa\.me|whatsapp|youtube|max\.ru|ok\.ru|api\.whatsapp)/i;
const pick=(o,...keys)=>{ for(const k of keys){ const v=o[k]; if(v!=null&&String(v).trim()!=='') return String(v).trim(); } return ''; };
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
        vk_link:pick(o,'VK_Link'),
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
    const key=normName(r.company);
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

async function loadProjects(){
  const c=window.VCAuth&&window.VCAuth.client&&window.VCAuth.client();
  if(!c) return null;
  const { data, error } = await c.from('projects').select('*')
    .order('processed',{ascending:false})
    .order('rating',{ascending:false,nullsFirst:false})
    .limit(1000);
  if(error){ console.warn('[Workspace] не удалось прочитать проекты:', error.message); return null; }
  return data;
}

async function savePatch(id, patch){
  const { error } = await db().from('projects')
    .update({ ...patch, updated_at:new Date().toISOString() }).eq('id', id);
  if(error) throw error;
}
const saveStage=(id,stage,progress)=>savePatch(id,{stage:stage,progress:progress});
const saveNotes=(id,notes)=>savePatch(id,{notes:notes});
const saveDemo=(id,demo)=>savePatch(id,{demo:demo});

/* Всё «наше» (журнал звонков, напоминания, деньги) живёт в projects.raw —
 * отдельные таблицы без SSH-доступа не создать, а raw в PROTECTED:
 * переживает и слияние, и обогащение при импорте. */
async function saveRaw(project, patch){
  const raw=(project.raw&&typeof project.raw==='object')?project.raw:{};
  const next={ ...raw, ...patch };
  await savePatch(project.id, { raw:next });
  project.raw=next;
  return next;
}

async function logCall(project, entry){
  const raw=(project.raw&&typeof project.raw==='object')?project.raw:{};
  const calls=Array.isArray(raw.calls)?raw.calls.slice():[];
  calls.push(entry);
  await saveRaw(project, { calls:calls });
  return calls;
}
const callsOf=p=>{
  const r=p&&p.raw; const a=r&&typeof r==='object'&&r.calls;
  return Array.isArray(a)?a:[];
};

/* ---------- Импорт ---------- */
/* Считаем, что упадёт, ДО того как что-то трогаем в базе. */
async function planImport(rows){
  const { data, error } = await db().from('projects').select('id, company').limit(5000);
  if(error) throw error;
  const idx=new Map(); (data||[]).forEach(r=>idx.set(normName(r.company), r.id));
  const fresh=[], existing=[];
  rows.forEach(r=>{
    const id=idx.get(normName(r.company));
    if(id) existing.push({ ...r, id:id }); else fresh.push(r);
  });
  return { fresh:fresh, existing:existing, total:data?data.length:0 };
}

async function runImport(plan, mode, onProgress){
  const c=db();
  const report={ added:0, enriched:0, skipped:0, deleted:0 };
  const say=m=>{ if(onProgress) onProgress(m); };

  if(mode==='replace'){
    say('стираю старые записи…');
    const { error } = await c.from('projects').delete().not('id','is',null);
    if(error) throw error;
    report.deleted=plan.total;
  }

  const toInsert = mode==='replace' ? plan.fresh.concat(plan.existing.map(r=>{ const x={...r}; delete x.id; return x; })) : plan.fresh;
  for(let i=0;i<toInsert.length;i+=100){
    const chunk=toInsert.slice(i,i+100).map(r=>({ ...r, stage:'new', progress:5 }));
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
        return x;
      });
      say('обогащаю '+(i+chunk.length)+' из '+plan.existing.length+'…');
      const { error } = await c.from('projects').upsert(chunk,{ onConflict:'id' });
      if(error) throw error;
      report.enriched+=chunk.length;
    }
  } else if(mode==='add'){
    report.skipped=plan.existing.length;
  }
  return report;
}

async function loadData(){
  const projects=await loadProjects();
  return { projects:projects||[], widgets:WIDGETS, _source:projects?'db':'offline' };
}

window.VC = {
  CONFIG, loadData, loadProjects,
  saveStage, saveNotes, saveDemo, savePatch, saveRaw,
  logCall, callsOf,
  readFileRows, detectFormat, mapRows, planImport, runImport,
  FORMATS,
};
