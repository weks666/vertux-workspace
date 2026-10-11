/* Local drafts and offline ZIP. No delivery, network requests or provider access. */
(function(root){
  'use strict';
  const text=v=>String(v||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
  const esc=v=>text(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl=v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
  function sources(project,research){
    const rows=[...(research?.pages||[]),...(research?.signals||[]).flatMap(s=>s.evidence||[]),...(project.raw?._researchBrief?.sources||[])];
    const found=new Map();for(const r of rows){const url=safeUrl(r.url||r.href||r);if(url&&!found.has(url))found.set(url,{url,title:text(r.title||r.label||'Источник'),checkedAt:r.checkedAt||research?.checkedAt||null});}
    return [...found.values()];
  }
  function playbook(project,research){
    const name=text(project.company),audit=research?.audit,findings=audit?.status==='completed'?(audit.findings||[]):[];
    const observation=findings.find(f=>f.category!=='legal'&&f.certainty==='observed')||findings[0];
    const noSite=!project.site;
    const opening=observation?`При просмотре страницы ${observation.url} мы отметили: ${observation.observation} Это результат проверки на ${observation.checkedAt?.slice(0,10)||'указанную дату'}, а не вывод обо всём сайте. Удобно коротко пояснить?`:noSite?'Нашли вашу компанию в открытых источниках. Подскажите, есть ли у вас отдельный сайт? Мы могли его не найти. Как сейчас клиенты смотрят услуги и связываются с вами?':'Посмотрели доступную информацию о вашей компании. Подскажите, кто отвечает за сайт и обращения клиентов? Хотим понять, есть ли задача, с которой можем помочь.';
    return [
      ['Перед звонком',`Компания: ${name}. Проверь карточку, номер и дату источников. Выбери один подтверждённый факт и один вопрос. Не называй гипотезу доказанным недостатком. Цель первого разговора — понять задачу и согласовать следующий шаг, а не продать всё сразу.`],
      ['1. Начало разговора','Здравствуйте! Меня зовут [имя], студия Vertux. Подскажите, пожалуйста, с кем можно обсудить сайт и обращения клиентов? Удобно буквально полминуты объяснить, по какому вопросу?'],
      ['2. Секретарь или администратор','Мы разрабатываем сайты и помогаем с обработкой обращений. Есть конкретный вопрос по публичной информации о вашей компании. Кто принимает такие решения: управляющий, владелец или маркетолог?\nЕсли не соединяют: «Понимаю. Как корректно передать этому человеку краткую информацию? Можно ли оставить для него тему и мой контакт?» Не выдавай себя за клиента или проверяющего.'],
      ['3. Разговор с ответственным',opening+'\nЕсли разрешили продолжить: «Какой канал сейчас приносит обращения? Что чаще спрашивают перед бронированием или визитом? Что на сайте хотели бы улучшить?» Слушай ответ и запиши его словами клиента.'],
      ['4. Объяснить конкретное замечание',observation?`«Могу показать страницу и шаги проверки: ${observation.reproduce} Возможно, есть контекст, которого мы не видим. Вы замечали такое?»\nПредлагаемое исправление: ${observation.fix}`:'Подтверждённого технического замечания пока нет. Не говори, что функция сломана, сайт медленный или компания теряет деньги. Сначала предложи проверку и уточни процесс.'],
      ['5. Вопрос о законах или штрафе','«В отчёте указаны наблюдение, ссылка на норму и условия её применимости. По внешней странице нельзя установить все процессы компании. Это пункт для проверки, а не заключение о нарушении или штрафе». Не представляйся государственным органом, юристом или аудитором с полномочиями проверки. Не используй угрозу штрафом как аргумент продажи.'],
      ['6. «У нас уже есть сайт / подрядчик»','«Хорошо. Мы можем передать конкретные замечания вашему специалисту. Есть ли вопрос, который нынешний сайт пока не закрывает?» Если всё устраивает — поблагодари и не спорь. Если есть задача — уточни её границы и предложи небольшой первый этап.'],
      ['7. «Сайта нет, нам хватает соцсетей»','«Понимаю. Как новый клиент находит условия, меню/номера, адрес и способ бронирования? Есть ли вопросы, которые приходится повторять вручную?» Отсутствие сайта — возможность обсудить задачу, а не доказательство обязательной потребности. Предложи понятную страницу только если есть польза.'],
      ['8. «Сколько стоит?»','«Рассчитываем индивидуально: зависит от страниц, материалов, интеграций и того, что уже есть. Чтобы назвать обоснованную сумму, уточню задачу и подготовлю состав работ». Уточни: исправления или новый сайт; кто готовит тексты/фото; бронирование/оплата/CRM; сроки; кто согласует. Не обещай цену или срок до оценки.'],
      ['9. «Нет бюджета / дорого»','«Понимаю. Что сейчас важнее: решить одну конкретную проблему или рассмотреть сайт целиком?» Можно отдельно оценить необходимое исправление и редизайн. Если бюджет не планируется — не дави и не выдумывай скидку. Спроси о возврате к вопросу только при интересе.'],
      ['10. «Некогда» / «Перезвоните»','«Конечно. Когда и кому будет удобно коротко вернуться к вопросу?» Уточни день, время и номер. Повтори договорённость и запиши следующий шаг. Если времени не дают — предложи оставить контакт и заверши разговор.'],
      ['11. «Пришлите на почту»','«Что включить: список замечаний, вариант решения или концепт сайта? На какой рабочий адрес и на чьё имя отправить? Можно ли после просмотра связаться, и когда?» Запиши согласованный адрес и разрешённый следующий контакт. Скачай пакет, проверь его и подготовь письмо. Система сама ничего не отправляет.'],
      ['12. «Откуда номер?» / «Докажите проблему»','Назови фактический публичный источник из карточки, без догадок. «Номер указан на [источник]. По замечанию пришлю точный URL, дату и порядок проверки. Если у вас сейчас всё работает, перепроверим». Не спорь с клиентом и не скрывай ограничений проверки.'],
      ['13. «Нам интересно»','«Давайте зафиксируем задачу: [повтори своими словами]. Кто будет согласовывать? Какой результат и срок важны? Предлагаю [короткую встречу / показать концепт / оценить конкретный этап]». Запиши ответственного, нужные материалы, срок ответа и договорённость. Не обещай измеренный рост продаж без данных.'],
      ['14. Отказ, раздражение, грубость','«Понял, спасибо. Больше по этому вопросу беспокоить не будем. Всего доброго». Заверши разговор. Если попросили не звонить/не писать, включи «Компания отказалась от контактов» в карточке → История. Не назначай follow-up и не пытайся обойти отказ через другого сотрудника.'],
      ['15. Не ответили / ошибочный номер','Не выдавай отсутствие ответа за отказ или интерес. Отметь фактический итог. При ошибочном номере проверь источник и исправь карточку; не продолжай расспрашивать постороннего человека.'],
      ['После разговора','Во вкладке CRM выбери дату/время, внеси короткую заметку и нажми итог звонка. Это работает и после звонка с обычного телефона. Запиши: с кем говорил, потребность словами клиента, ограничения, индивидуальную оценку после расчёта, разрешённый канал и следующий шаг. Исправляй последний итог отдельной кнопкой; новый разговор сохраняется отдельной записью.']
    ].map(([title,body])=>({title,body}));
  }
  const guideText=(p,r)=>playbook(p,r).map(s=>s.title+'\n'+s.body).join('\n\n');
  function auditHTML(project,research){
    const a=research?.audit,findings=a?.status==='completed'?a.findings||[]:[],links=sources(project,research);
    const link=(url,label)=>safeUrl(url)?`<a href="${esc(safeUrl(url))}" rel="noopener noreferrer">${esc(label||url)}</a>`:esc(label||'Ссылка не подтверждена');
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка сайта — ${esc(project.company)}</title><style>body{font:16px/1.6 system-ui;color:#17201c;max-width:920px;margin:36px auto;padding:0 24px}h1{font-size:32px;line-height:1.2}h2{margin-top:38px}article{border-top:1px solid #ccd1cd;padding:20px 0;break-inside:avoid}a{color:#24583e;overflow-wrap:anywhere}small{color:#4b574f}p{white-space:pre-line}li{margin:10px 0}@media print{body{margin:0}a{color:inherit}h2{break-after:avoid}}</style><h1>${esc(project.company)}<br>Проверка публичных страниц</h1><p>Дата отчёта: ${esc(a?.checkedAt||'проверка не выполнялась')}<br>Статус: ${a?.status==='completed'?'публичные страницы проверены':'для выводов недостаточно данных'}</p><p>Этот документ содержит наблюдения и вопросы для проверки, а не заключение о нарушении закона или наличии уязвимостей. Исправления и стоимость обсуждаются индивидуально.</p>${a?.legalReviewDue?'<p>Справочник правовых норм требует обновления. Перепроверь актуальную редакцию перед использованием отчёта.</p>':''}<h2>Конкретные замечания</h2>${findings.length?findings.map((f,i)=>`<article><h3>${i+1}. ${esc(f.title)}</h3><small>${f.category==='legal'?'Правовой вопрос':f.category==='security'?'Наблюдение конфигурации':'Техническое наблюдение'} · ${f.certainty==='observed'?'обнаружено в полученной разметке':'требует ручного подтверждения'}</small><p>${esc(f.observation)}</p><p>Страница: ${link(f.url)}<br>Проверено: ${esc(f.checkedAt)}</p><p><b>Как проверить:</b> ${esc(f.reproduce)}</p><p><b>Вариант исправления:</b> ${esc(f.fix)}</p>${f.law?`<p><b>Норма:</b> ${link(f.law.url,f.law.title)}<br>${esc(f.law.condition)}<br>Редакция проверялась: ${esc(f.law.reviewedAt)}</p>`:''}</article>`).join(''):'<p>Подтверждённого списка замечаний нет. Это не означает, что сайт полностью соответствует всем требованиям. При отсутствии сайта сначала нужно уточнить у компании, действительно ли отдельного сайта нет.</p>'}<h2>Границы проверки</h2><ul>${(a?.limitations||['Автоматическая проверка этого сайта ещё не выполнена.']).map(x=>`<li>${esc(x)}</li>`).join('')}</ul><h2>Источники</h2><ol>${links.map(s=>`<li>${link(s.url,s.title)}<br>${link(s.url)}<br><small>Проверено: ${esc(s.checkedAt||'дата не указана')}</small></li>`).join('')}</ol></html>`;
  }
  const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
  function zipFiles(files){
    const encoder=new TextEncoder(),parts=[],central=[];let offset=0,size=0;
    const header=(length,fill)=>{const b=new Uint8Array(length);fill(new DataView(b.buffer));return b;};
    for(const [path,content] of Object.entries(files)){
      if(!path||path.includes('..')||path.startsWith('/')||path.includes('\\'))throw new Error('invalid_archive_path');
      const name=encoder.encode(path),data=encoder.encode(content),crc=crc32(data);
      if(data.length>2000000||name.length>500)throw new Error('archive_too_large');
      const local=header(30,d=>{d.setUint32(0,0x04034b50,true);d.setUint16(4,20,true);d.setUint16(6,0x800,true);d.setUint16(12,33,true);d.setUint32(14,crc,true);d.setUint32(18,data.length,true);d.setUint32(22,data.length,true);d.setUint16(26,name.length,true);});
      const center=header(46,d=>{d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,crc,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);});
      parts.push(local,name,data);central.push(center,name);offset+=local.length+name.length+data.length;size+=center.length+name.length;
    }
    const count=Object.keys(files).length;if(count>50||offset>5000000)throw new Error('archive_too_large');
    const end=header(22,d=>{d.setUint32(0,0x06054b50,true);d.setUint16(8,count,true);d.setUint16(10,count,true);d.setUint32(12,size,true);d.setUint32(16,offset,true);});
    const all=[...parts,...central,end],out=new Uint8Array(offset+size+end.length);let cursor=0;for(const p of all){out.set(p,cursor);cursor+=p.length;}return out;
  }
  function packageFiles(project,lead,materials){
    const research=lead?.deep||lead?.quick,src=sources(project,research),m=materials||lead?.materials||{};
    const files={
      'Начать-здесь.txt':`${text(project.company)}\n\nМатериалы для проверки менеджером. Откройте Аудит.html в браузере: его можно распечатать или сохранить как PDF. Согласуйте факты, объём, индивидуальную цену и разрешение на отправку. Пакет ничего не отправляет. Демо — локальный концепт, не опубликованный рабочий сайт.`,
      'Аудит.html':auditHTML(project,research),
      'Источники.txt':src.map(s=>`${s.title}\n${s.url}\nПроверено: ${s.checkedAt||'не указано'}`).join('\n\n')||'Источники пока не подтверждены.',
      'Письмо.txt':`Тема: ${text(m.emailSubject)}\n\n${text(m.emailBody)}\n\nПриложение: проверка публичных страниц и вопросы к обсуждению. Юридическая применимость требует проверки, технические выводы ограничены указанными страницами.`,
      'Предложение.txt':`${text(m.proposal)}\n\nИндивидуальный расчёт\nСостав работ: [заполнить после разговора]\nСтоимость: [индивидуальная оценка]\nСроки и этапы: [согласовать]\nЧто входит и что оплачивается отдельно: [уточнить]\nОснование оценки и срок её действия: [уточнить]`,
      'Сценарий-звонка.txt':guideText(project,research),
      'Заметки-менеджера.txt':`${text(m.callScript)}\n\n${text(project.notes)}`
    };
    if(lead?.demo?.status==='completed'&&typeof lead.demo.html==='string')files['Демо/index.html']=lead.demo.html;
    return files;
  }
  const api={playbook,guideText,auditHTML,packageFiles,zipFiles,sources};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.VCLeadKit=api;
})(typeof window!=='undefined'?window:globalThis);
