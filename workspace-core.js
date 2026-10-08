/* Pure rules shared by the UI and isolated regression tests. */
(function(root){
  'use strict';
  const closed=new Set(['paid','refused','not_interested']);
  const clean=value=>String(value==null?'':value).trim();
  const name=value=>clean(value).toLocaleLowerCase('ru-RU').replace(/\s+/g,' ');
  function phone(value){
    const first=clean(value).split(/[;,\n]/)[0];
    let digits=first.replace(/\D/g,'');
    if(digits.length===11&&digits[0]==='8') digits='7'+digits.slice(1);
    if(digits.length===10) digits='7'+digits;
    return digits.length>=10&&digits.length<=15?'+'+digits:'';
  }
  function timestamp(value){
    if(!value) return null;
    const n=new Date(value).getTime();
    return Number.isFinite(n)?n:null;
  }
  function scheduledAt(project){return timestamp(project?.raw?.next_call);}
  function isDue(project,now=Date.now()){
    const at=scheduledAt(project);
    return !closed.has(project.stage)&&at!==null&&at<=now;
  }
  function nextLead(projects,now=Date.now()){
    const available=projects.filter(p=>phone(p.phone)&&!closed.has(p.stage));
    const due=available.filter(p=>isDue(p,now)).sort((a,b)=>scheduledAt(a)-scheduledAt(b));
    if(due.length) return due[0];
    const ready=available.filter(p=>scheduledAt(p)===null);
    const recentCall=p=>(Array.isArray(p.raw?.calls)?p.raw.calls:[]).reduce((t,c)=>Math.max(t,timestamp(c.at)||0),0);
    return ready.filter(p=>['new','contacted'].includes(p.stage||'new')).sort((a,b)=>
      recentCall(a)-recentCall(b)||Number(Boolean(b.call_script))-Number(Boolean(a.call_script))||
      (Number(b.rating)||0)-(Number(a.rating)||0))[0]||null;
  }
  function parseMoney(value,{percent=false}={}){
    const s=clean(value).replace(/[\s\u00a0\u202f]/g,'').replace(',','.');
    if(!s) return null;
    if(!/^\d+(?:\.\d{1,2})?$/.test(s)) throw new Error('Введите число без знака минус и лишних символов, например 15000 или 15000,50');
    const n=Number(s);
    if(!Number.isFinite(n)||n>(percent?100:1e12)) throw new Error(percent?'Доля должна быть от 0 до 100%':'Сумма слишком большая');
    return n;
  }
  function identityKey(row){
    return [name(row.source_url).replace(/[?#].*$/,''),name(row.company),name(row.city),name(row.address),phone(row.phone)].join('|');
  }
  function moneySplit(amount,percent){
    const minor=Math.round(amount*100),basisPoints=Math.round(percent*100);
    if(!Number.isSafeInteger(minor)||minor<0||basisPoints<0||basisPoints>10000) throw new Error('Некорректная сумма или доля');
    const manager=Number((BigInt(minor)*BigInt(basisPoints)+5000n)/10000n);
    return {minor,managerMinor:manager,studioMinor:minor-manager};
  }
  function matchLead(row,existing){
    const same=existing.filter(p=>name(p.company)===name(row.company));
    const source=name(row.source_url).replace(/[?#].*$/,'');
    const locationMatches=p=>(!row.city||!p.city||name(row.city)===name(p.city))&&(!row.address||!p.address||name(row.address)===name(p.address));
    let candidates=source?same.filter(p=>name(p.source_url).replace(/[?#].*$/,'')===source&&locationMatches(p)):[];
    if(!candidates.length&&phone(row.phone)) candidates=same.filter(p=>phone(p.phone)===phone(row.phone)&&(!row.city||!p.city||name(row.city)===name(p.city)));
    if(!candidates.length&&row.address) candidates=same.filter(p=>name(p.address)===name(row.address)&&name(p.city)===name(row.city));
    if(candidates.length===1) return {kind:'existing',id:candidates[0].id};
    if(candidates.length>1) return {kind:'conflict'};
    if(!same.length) return {kind:'fresh'};
    const distinct=same.every(p=>(row.city&&p.city&&name(row.city)!==name(p.city))||
      (phone(row.phone)&&phone(p.phone)&&phone(row.phone)!==phone(p.phone))||
      (row.address&&p.address&&name(row.address)!==name(p.address)));
    return distinct?{kind:'fresh'}:{kind:'conflict'};
  }
  function serviceAsset(config,origin){
    const version=String(config?.moduleVersion||'');
    if(config?.contractVersion!==2||!['1.2.2','1.2.3'].includes(version)) throw new Error('Nexus вернул неподдерживаемую версию системного модуля');
    if(origin!=='https://nexus.vertux.online') throw new Error('Недоверенный сервер Nexus');
    const pathname='/service-module/v'+version+'/vertux-service-center.js';
    const url=new URL(pathname,origin).href;
    if(config.assetUrl&&config.assetUrl!==url) throw new Error('Nexus вернул недоверенный адрес модуля');
    return {url,pathname};
  }
  const api={phone,timestamp,scheduledAt,isDue,nextLead,parseMoney,moneySplit,identityKey,matchLead,serviceAsset};
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.WorkspaceCore=api;
})(typeof window==='object'?window:globalThis);
