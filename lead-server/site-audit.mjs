import {Parser} from 'htmlparser2';

// Versioned legal references are rules reviewed by a person, never model inventions.
export const LEGAL_REFERENCES=Object.freeze({
  policy:{title:'152-ФЗ, часть 2 статьи 18.1',url:'https://www.consultant.ru/document/cons_doc_LAW_61801/eeeebe22bf738fd65bb66b95cc278911ae2525ee/',reviewedAt:'2026-10-11',condition:'Когда оператор собирает персональные данные через сайт, на страницах сбора должен быть доступ к политике обработки.'},
  consent:{title:'152-ФЗ, части 1 и 3 статьи 9',url:'https://www.consultant.ru/document/cons_doc_LAW_61801/6c94959bc017ac80140621762d2ac59f6006b08c/',reviewedAt:'2026-10-11',condition:'Если основание обработки — согласие, его оформление и доказательства получения проверяются отдельно. Возможны другие законные основания; их нельзя определить по внешнему виду формы.'}
});
const text=value=>String(value||'').replace(/[<>\u0000-\u001f]/g,' ').replace(/\s+/g,' ').slice(0,240).trim();
export function inspectMarkup(html,url){
  const facts={viewport:false,imageCount:0,imagesWithoutAlt:0,inputsWithoutLabel:0,mixedResources:[],forms:[],policyLinks:[]};
  const labels=new Set(),inputs=[];let form=null,anchor=null,depth=0,formDepth=0,anchorDepth=0,nodes=0;
  const safe=value=>{try{const u=new URL(value,url);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
  const p=new Parser({onopentag(name,a){
    if(++nodes>100000)throw new Error('markup_too_complex');depth++;
    if(name==='meta'&&a.name?.toLowerCase()==='viewport'&&/width\s*=\s*device-width/i.test(a.content||''))facts.viewport=true;
    if(name==='label'&&a.for)labels.add(a.for);
    if(name==='img'){facts.imageCount++;if(!Object.hasOwn(a,'alt'))facts.imagesWithoutAlt++;}
    if(['script','img','iframe'].includes(name)||(name==='link'&&/(?:^|\s)(?:stylesheet|preload|icon)(?:\s|$)/i.test(a.rel||''))){const u=safe(a.src||a.href);if(url.startsWith('https:')&&u?.startsWith('http:')&&facts.mixedResources.length<5)facts.mixedResources.push({tag:name,url:u});}
    if(name==='form'){form={index:facts.forms.length+1,fields:[],text:'',checkboxes:0,prechecked:0};formDepth=depth;}
    if(['input','textarea','select'].includes(name)&&!['hidden','submit','button','reset'].includes(a.type)){
      inputs.push({id:a.id,aria:a['aria-label']||a['aria-labelledby']});
      if(form){const key=text([a.type,a.name,a.autocomplete,a.placeholder].join(' '));form.fields.push(key);if(a.type==='checkbox'){form.checkboxes++;if(Object.hasOwn(a,'checked'))form.prechecked++;}}
    }
    if(name==='a'){anchor={href:safe(a.href),text:''};anchorDepth=depth;}
  },ontext(value){if(form)form.text=(form.text+' '+value).slice(0,2000);if(anchor)anchor.text=(anchor.text+value).slice(0,200);},onclosetag(name){
    if(name==='a'&&anchorDepth===depth&&anchor){if(anchor.href&&/privacy|policy|персональн|конфиденц|политик/i.test(anchor.href+' '+anchor.text))facts.policyLinks.push({url:anchor.href,text:text(anchor.text)});anchor=null;}
    if(name==='form'&&formDepth===depth&&form){form.text=text(form.text);form.personalData=form.fields.some(v=>/email|tel|phone|имя|name|телефон|почт/i.test(v));facts.forms.push(form);form=null;}depth--;
  }},{decodeEntities:true});p.end(String(html).slice(0,1024*1024));
  // A placeholder alone is not an accessible label. Wrapping labels require visual review.
  facts.inputsWithoutLabel=inputs.filter(i=>!i.aria&&(!i.id||!labels.has(i.id))).length;
  return facts;
}
export function buildSiteAudit(research,{now=Date.now()}={}){
  const checkedAt=new Date(now).toISOString(),pages=(research.pages||[]).filter(p=>p.markupAudit);
  const verified=research.officialSite?.status==='verified';
  const report={schemaVersion:1,checkedAt,status:verified&&pages.length?'completed':'not_verified',method:'public_pages',legalReviewedAt:'2026-10-11',legalReviewDue:now>Date.parse('2027-01-09T00:00:00Z'),pages:pages.map(p=>({url:p.url,checkedAt:p.checkedAt,rendered:!!p.rendered})),findings:[],limitations:[
    'Проверены доступные публичные страницы; заявки не отправлялись, покупки и вход не выполнялись.',
    'Исходный серверный код, база данных, авторизация, обработка заявок и наличие уязвимостей не проверены. Это не тест на проникновение.',
    'Юридическая применимость зависит от фактических процессов. Автоматический отчёт не устанавливает нарушение, штраф или полное соответствие закону.',
    'Работу кнопок, отправку формы и адаптивность нужно подтвердить отдельным пользовательским тестом.'
  ]};
  if(!verified){report.limitations.unshift('Принадлежность сайта компании не подтверждена; выводы о её сайте не формируются.');return report;}
  if(!pages.length){report.limitations.unshift('В сохранённом исследовании нет замеров HTML. Запусти новую проверку сайта.');return report;}
  function add(p,id,category,title,observation,fix,certainty='observed',law=null){
    if(report.findings.length>=32)return;
    report.findings.push({id:id+'-'+report.findings.length,category,title,observation,fix,certainty,severity:category==='legal'?'review':'improvement',url:p.url,checkedAt:p.checkedAt,selector:id.startsWith('form')?'form':id.startsWith('viewport')?'meta[name="viewport"]':id.startsWith('image')?'img':'document',...(law?{law}:{}),reproduce:`Открой ${p.url}. ${observation} Сверь текущее состояние со временем проверки.`});
  }
  for(const p of pages){const f=p.markupAudit;
    if(!f.viewport)add(p,'viewport','technical','Не найдена настройка ширины мобильного экрана','В полученном HTML нет meta viewport с width=device-width.','Проверить страницу на телефоне и при необходимости добавить корректный viewport.','review');
    if(f.imagesWithoutAlt)add(p,'images','accessibility','У изображений отсутствует атрибут alt',`В полученном HTML ${f.imagesWithoutAlt} изображений без alt.`,'Для информативных изображений описать смысл, для декоративных использовать пустой alt. Проверить назначение каждого изображения.');
    if(f.inputsWithoutLabel)add(p,'form-label','accessibility','Проверить подписи полей формы',`${f.inputsWithoutLabel} полей без найденной явной связи label/aria. Вложенная подпись может быть допустима.`,'Проверить доступное имя поля и связать подпись с вводом.','review');
    if(f.mixedResources.length)add(p,'mixed','security','Ссылки на ресурсы по HTTP на HTTPS-странице',f.mixedResources.map(r=>`${r.tag}: ${r.url}`).join('; '),'Проверить загрузку в браузере и перевести ресурсы на HTTPS. Это наблюдение конфигурации, не подтверждение уязвимости.');
    for(const form of f.forms.filter(x=>x.personalData)){
      if(!f.policyLinks.length)add(p,'form-policy','legal','На странице сбора данных не найдена ссылка на политику',`В форме №${form.index} найдены поля для контактных данных; в HTML этой страницы ссылка на политику не обнаружена.`,'Вручную проверить доступность политики на странице, в том числе после загрузки JavaScript. При подтверждении добавить доступ к документу.','review',LEGAL_REFERENCES.policy);
      if(/согласи|consent/i.test(form.text))add(p,'form-consent','legal','Проверить отдельное оформление согласия',`В форме №${form.index} есть текст о согласии${form.prechecked?'; обнаружен заранее отмеченный checkbox':''}.`,'Проверить основание обработки, отдельность согласия от оферты/других документов и доказательства волеизъявления. Наличие галочки само по себе ничего не доказывает.','review',LEGAL_REFERENCES.consent);
    }
  }
  for(const l of research.limitations||[])if(l.code==='HTTP_UNAVAILABLE'&&[404,410,500,502,503].includes(l.status))add({url:l.url,checkedAt},'http','technical',`Связанная страница вернула HTTP ${l.status}`,`GET ${l.url} вернул ${l.status} во время проверки.`,'Повторить проверку и восстановить страницу либо исправить ведущую на неё ссылку.');
  if(!report.findings.length)report.limitations.unshift('По выполненным проверкам конкретные замечания не обнаружены. Это не подтверждение отсутствия иных проблем.');
  return report;
}
