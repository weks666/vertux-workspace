import {fail} from './errors.mjs';

export const SERVICES=Object.freeze({
  website:{label:'Сайт и структура заявок',benefit:'собрать информацию об услугах и путь к заявке в одном понятном сценарии',question:'Какие вопросы о ваших услугах приходится чаще всего разъяснять вручную?'},
  booking:{label:'Онлайн-запись и бронирование',benefit:'дать посетителю понятный способ оставить запрос на дату и получить подтверждение',question:'Как вы сейчас проверяете свободные даты и подтверждаете запросы клиентов?'},
  crm:{label:'CRM-интеграция',benefit:'собирать обращения в единую очередь с ответственным и следующим действием',question:'Где фиксируются обращения и кто следит за ответами на них?'},
  automation:{label:'Автоматизация обработки обращений',benefit:'сократить повторяющиеся ручные действия после получения обращения',question:'Какое действие после новой заявки команда повторяет вручную чаще всего?'}
});
const injection=/(?:ignore\s+(?:all|previous)|system\s+prompt|developer\s+message|игнорируй\s+(?:все|предыдущ)|системн\w*\s+(?:промпт|инструкц)|api[_ -]?key|bearer\s+[a-z0-9._-]{12}|выполни\s+команд|reveal\s+secret)/iu;
function clean(value,max=220){return String(value??'').replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
export function evidenceCatalog(research){
  const facts=[];
  for(const signal of research?.signals||[]){
    const evidence=(signal.evidence||[]).find(e=>{
      try{const u=new URL(e.url);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&typeof e.quote==='string'&&e.quote.trim()&&!injection.test(e.quote)&&!Number.isNaN(Date.parse(e.checkedAt));}catch{return false;}
    });
    if(evidence&&typeof signal.id==='string'&&signal.id.length<100&&Number(evidence.confidence??signal.confidence)>=0.5)
      facts.push({id:signal.id,label:clean(signal.label,100),quote:clean(evidence.quote),url:evidence.url,checkedAt:evidence.checkedAt,confidence:Number(evidence.confidence??signal.confidence)});
  }
  const rank=id=>id.startsWith('industry_')?0:['booking','menu','faq','hours'].includes(id)?1:['phone','email','messenger','contact_form'].includes(id)?3:2;
  return facts.sort((a,b)=>rank(a.id)-rank(b.id)).slice(0,24);
}
export function eligibleServices(research){
  const ids=new Set((research?.opportunities||[]).filter(o=>o.evidence?.length&&Number(o.confidence)>=0.4).map(o=>o.serviceId));
  return [...ids].filter(id=>Object.hasOwn(SERVICES,id));
}
export function defaultPlan(research){
  const facts=evidenceCatalog(research),services=eligibleServices(research);
  return {serviceId:services[0]||'website',evidenceIds:facts.slice(0,2).map(f=>f.id),approach:'discovery',questionIds:['current_process','decision_maker','priority'],objectionIds:['have_solution','no_time','budget']};
}
export function validateAnalysisPlan(value,research){
  const facts=evidenceCatalog(research),allowed=eligibleServices(research);
  const fields=['serviceId','evidenceIds','approach','questionIds','objectionIds'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))fail('ai_output_invalid',502);
  if(!Object.hasOwn(SERVICES,value.serviceId)||(allowed.length&&!allowed.includes(value.serviceId)))fail('ai_output_ungrounded',502);
  if(!Array.isArray(value.evidenceIds)||!value.evidenceIds.length||value.evidenceIds.length>3||new Set(value.evidenceIds).size!==value.evidenceIds.length||value.evidenceIds.some(id=>!facts.some(f=>f.id===id)))fail('ai_output_ungrounded',502);
  if(!['discovery','process','website'].includes(value.approach))fail('ai_output_invalid',502);
  for(const [key,choices] of [['questionIds',['current_process','decision_maker','priority','request_channels','next_step']],['objectionIds',['have_solution','no_time','budget','send_email']]]){
    if(!Array.isArray(value[key])||value[key].length<1||value[key].length>4||new Set(value[key]).size!==value[key].length||value[key].some(id=>!choices.includes(id)))fail('ai_output_invalid',502);
  }
  return structuredClone(value);
}
export function composeMaterials(project,research,plan=defaultPlan(research)){
  const facts=evidenceCatalog(research).filter(f=>plan.evidenceIds.includes(f.id));
  const name=clean(project?.company,160)||'компания',service=SERVICES[plan.serviceId]||SERVICES.website;
  const verified=research?.officialSite?.status==='verified';
  const report=facts.map(f=>`На проверенной странице указано: «${f.quote}» (${f.url}, проверено ${f.checkedAt.slice(0,10)}).`).join('\n');
  const observation=facts[0]?`На странице вашего сайта увидел информацию: «${facts[0].quote}». `:'';
  const factualOpening=verified?observation:'';
  const uncertainty=verified?'Потребность в изменениях — гипотеза до разговора с представителем компании.':'Принадлежность сайта и потребность в изменениях нужно подтвердить у компании.';
  const questionMap={current_process:service.question,decision_maker:'Кто в вашей команде отвечает за этот процесс?',priority:'Что в нём хотелось бы упростить в первую очередь?',request_channels:'Из каких каналов приходят обращения и как вы их объединяете?',next_step:'Если задача актуальна, удобно ли обсудить один конкретный сценарий?'};
  const objections={have_solution:'«У нас уже всё работает». — Понимаю. Есть ли в текущем процессе ручной шаг, который всё же отнимает время? Если нет, внедрение может не понадобиться.',no_time:'«Сейчас некогда». — Понял. Имеет ли смысл вернуться к разговору в выбранный вами день? Без вашего согласия напоминать не буду.',budget:'«Нет бюджета». — Тогда сначала определим, есть ли сама задача. Стоимость можно обсуждать только после понятного объёма.',send_email:'«Пришлите на почту». — Хорошо. На какой рабочий адрес и по какой задаче удобнее прислать краткое предложение?'};
  return {
    summary:`${name}\n${report||'Подтверждённых сведений о сайте недостаточно.'}\n\n${uncertainty}`,
    proposal:`${name}: ${service.label.toLowerCase()}.\n\n${report?report+'\n\n':''}Если такой процесс актуален, Vertux может ${service.benefit}. Сначала предлагаем разобрать текущий путь обращения и согласовать один полезный сценарий.\n\n${uncertainty} Наличие проблемы, бюджет и ожидаемый эффект нужно обсудить; измеренного роста или финансовых потерь мы не утверждаем.`,
    callScript:`Здравствуйте! Меня зовут [имя], студия Vertux. Подскажите, удобно задать короткий вопрос о работе с обращениями в ${name}?\n\n${factualOpening}${service.question}\n\nВопросы:\n${(plan.questionIds||[]).map(id=>'• '+questionMap[id]).join('\n')}\n\nВозможное предложение: если задача подтвердится, можем ${service.benefit}.\n\nВозражения:\n${(plan.objectionIds||[]).map(id=>objections[id]).join('\n\n')}\n\nСледующий шаг: согласовать задачу, контакт и разрешённый способ продолжения. При отказе завершить контакт.`,
    emailSubject:`${name}: вопрос о работе с обращениями`.slice(0,200),
    emailBody:`Здравствуйте!\n\nЯ [имя], студия Vertux. ${factualOpening}${service.question}\n\nЕсли задача актуальна, можем ${service.benefit}. Готов кратко обсудить ваш текущий процесс и понять, будет ли полезен конкретный вариант.\n\nЕсли тема не подходит, сообщите — больше писать по этому вопросу не будем.\n[имя и рабочий контакт]`,
    icebreaker:factualOpening.trim()||`Подскажите, кто в ${name} отвечает за обработку обращений?`,
    followUps:[`Здравствуйте! Возвращаюсь к согласованному вопросу о работе с обращениями. ${service.question} Если приоритет изменился, дайте знать — закрою вопрос.`,`Здравствуйте! Уточню, актуально ли продолжить обсуждение в согласованный срок. Если нет, дальнейших напоминаний по этой теме не будет.`]
  };
}
export function classifyReply(text,now=Date.now()){
  if(typeof text!=='string'||!text.trim()||text.length>12000)fail('invalid_reply');
  const normalized=text.toLowerCase().replace(/ё/g,'е').trim();
  let classification='unknown',confidence=0.35,optOut=false;
  const explicitOptOut=/(отпишите|удалите (?:меня|нас|мой|наш)|не (?:пишите|звоните|связывайтесь|беспокойте)|stop|unsubscribe)/iu.test(normalized);
  if(explicitOptOut){classification='refusal';confidence=0.98;optOut=true;}
  else if(/(не интересно|неинтересно|не актуально|неактуально|не нужно|отказываемся|не предлагайте|не заинтересован)/iu.test(normalized)){classification='refusal';confidence=0.85;optOut=true;}
  else if(/(позже|потом|через (?:неделю|месяц|\d+)|в следующем|после отпуска|later)/iu.test(normalized)){classification='later';confidence=0.8;}
  else if(/(подробнее|подробности|пришлите|отправьте|сколько стоит|какая стоимость|details|прайс)/iu.test(normalized)){classification='details';confidence=0.8;}
  else if(/(интересно|интересует|давайте обсудим|готовы обсудить|давайте созвонимся|актуально|заинтересован)/iu.test(normalized)){classification='interest';confidence=0.8;}
  const replies={interest:['Спасибо! Подскажите, какую задачу вам важнее решить и когда удобно коротко её обсудить?','Согласовать задачу и удобное время разговора'],details:['Спасибо! Уточните, какой процесс вы хотите упростить. Подготовлю краткий вариант с подходящим объёмом работ.','Уточнить задачу и подготовить согласованное предложение'],refusal:['Понял, спасибо за ответ. Больше обращаться по этому вопросу не будем.','Исключить из коммуникаций; никаких последующих сообщений'],later:['Понял. Подскажите, когда и каким способом удобно вернуться к вопросу?','Уточнить срок; поставить напоминание только после согласования'],unknown:['Спасибо за ответ. Уточните, пожалуйста, правильно ли я понял ваш запрос?','Менеджеру прочитать ответ и выбрать следующее действие']};
  return {text:text.trim(),classification,confidence,optOut,suggestedReply:replies[classification][0],nextAction:replies[classification][1],checkedAt:new Date(now).toISOString(),method:'rules',status:'draft'};
}
