/* Isolated UI acceptance only. Backend/persistence tests are separate. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.WORKSPACE_PLAYWRIGHT||path.resolve(__dirname,'../../../projects/vertux-invest-workspace/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),out=path.join(root,'evidence/lead-intelligence/ui'),port=47863,origin=`http://127.0.0.1:${port}`;
(async()=>{
  const {startPreview}=await import(pathToFileURL(path.join(__dirname,'preview-server.mjs')));
  const server=await startPreview(port),browser=await chromium.launch({channel:'chrome',headless:true});
  fs.mkdirSync(out,{recursive:true});const results=[],errors=[],external=[],assetErrors=[];
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce',acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)assetErrors.push({url:response.url(),status:response.status()});});page.on('dialog',dialog=>dialog.accept());
  const test=async(name,fn)=>{await fn();results.push({name,status:'passed'});console.log('PASS '+name);};
  const nav=async id=>{await page.locator(`.nav-item[data-id="${id}"]`).click();await page.locator(`.nav-item.active[data-id="${id}"]`).waitFor();};
  const open=async id=>{await nav('projects');await page.locator(`tr[data-id="${id}"]`).focus();await page.keyboard.press('Enter');await page.locator('#drawer.open').waitFor();};
  const tab=async id=>{await page.locator(`[data-li-card-tab="${id}"]`).click();if(id!=='crm')await page.locator('#leadCardMount[aria-busy=false]').waitFor();};
  const hub=async id=>{await nav('intelligence');await page.locator(`[data-li-tab="${id}"]`).click();};
  const saved=async text=>{await page.locator('#leadCardMount [role=status]').filter({hasText:text}).first().waitFor();};
  const close=async()=>{if(await page.locator('#drawer.open').count())await page.locator('[data-drawer-close]').click();};
  const waitReady=async()=>page.waitForFunction(()=>window.__fixture.lead.requests.some(r=>r.action==='overview')&&document.querySelectorAll('tr[data-id]').length===4);
  try{
    await page.goto(origin);await page.locator('#nextCallBtn').waitFor();
    await test('Projects research filters combine industry, priority, service and checked date',async()=>{
      await nav('projects');await waitReady();await page.waitForFunction(()=>!document.querySelector('[data-li-filter=priority]').disabled);
      assert.ok(await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>r.action==='overview'&&r.cursor).length>=3));
      await page.locator('[data-li-filter=status]').selectOption('ready');assert.equal(await page.locator('tr[data-id]').count(),3);await page.locator('[data-li-action=reset-filters]').click();
      await page.locator('[data-li-filter=priority]').selectOption('high');assert.equal(await page.locator('tr[data-id]').count(),1);
      await page.locator('[data-li-filter=industry]').selectOption('banquet');assert.equal(await page.locator('tr[data-id]').count(),1);
      await page.locator('[data-li-filter=service]').selectOption('booking');assert.equal(await page.locator('tr[data-id]').count(),1);
      await page.locator('[data-li-filter=freshness]').selectOption('week');assert.equal(await page.locator('tr[data-id]').count(),1);
      await page.locator('[data-li-action=reset-filters]').click();await page.locator('[data-li-filter=freshness]').selectOption('never');assert.equal(await page.locator('tr[data-id]').count(),1);
      assert.equal(await page.locator('tr[data-id]').getAttribute('data-id'),'fixture-3');await page.locator('[data-li-action=reset-filters]').click();
      await page.screenshot({path:path.join(out,'desktop-companies.png')});
    });
    await test('Company card keeps CRM and adds grounded research with source, date and confidence',async()=>{
      await open('fixture-1');assert.equal(await page.locator('#stageSel').isVisible(),true);await tab('research');
      await page.getByText('Опубликован телефон для бронирования',{exact:true}).waitFor();
      assert.equal(await page.locator('#leadCardCrm').isVisible(),false);
      await page.locator('.li-evidence').first().locator('summary').click();
      assert.match(await page.locator('.li-evidence').first().innerText(),/Тестовый источник.*телефон/);
      assert.equal(await page.locator('.li-evidence').first().locator('a').getAttribute('href'),'https://example.invalid/banquet');
      await page.getByText('Почему такая оценка',{exact:true}).click();assert.equal(await page.locator('.li-score-parts>div').count(),5);
      await page.screenshot({path:path.join(out,'desktop-research.png')});
    });
    await test('Fresh cache is reported honestly and explicit force creates one new research job',async()=>{
      const before=await page.evaluate(()=>window.__fixture.lead.jobs.length);await page.getByRole('button',{name:'Deep Research',exact:true}).click();await saved('новая задача не создана');
      assert.equal(await page.evaluate(()=>window.__fixture.lead.jobs.length),before);
      await page.locator('#liForceResearch').check();await page.getByRole('button',{name:'Deep Research',exact:true}).click();await saved('Исследование в очереди');
      assert.equal(await page.evaluate(()=>window.__fixture.lead.jobs.length),before+1);assert.equal(await page.locator('#liForceResearch').isChecked(),false);
      const job=await page.evaluate(()=>window.__fixture.lead.jobs.find(j=>j.project_id==='fixture-1'&&j.status==='queued'));assert.equal(job.force,true);
      await page.getByRole('button',{name:'Deep Research',exact:true}).click();await saved('Исследование в очереди');assert.equal(await page.evaluate(()=>window.__fixture.lead.jobs.length),before+1);
      await page.evaluate(id=>window.__fixture.lead.complete(id),job.id);await page.evaluate(()=>window.VCLead.refresh(true));
      assert.equal(await page.locator('#leadCardMount [role=status]').filter({hasText:'Результат появится после обработки'}).count(),0);
      assert.match(await page.locator('.li-research-meta').innerText(),/Готово/);
    });
    await test('Queue notices follow the requested job; partial research labels uncertainty without empty fields',async()=>{
      await close();await open('fixture-3');await tab('research');
      await page.getByRole('button',{name:'Quick Scan',exact:true}).click();await saved('Исследование в очереди');
      const job=await page.evaluate(()=>window.__fixture.lead.jobs.find(j=>j.project_id==='fixture-3'&&j.status==='queued'));
      await page.evaluate(id=>{const f=window.__fixture.lead;f.jobs.find(j=>j.id===id).status='running';const lead=f.leads.find(l=>l.project_id==='fixture-3');lead.status='researching';lead.updated_at=new Date().toISOString();},job.id);
      await page.evaluate(()=>window.VCLead.refresh(true));await saved('Исследование уже выполняется');
      assert.equal(await page.locator('#leadCardMount [role=status]').filter({hasText:'Исследование в очереди.'}).count(),0);
      await page.evaluate(id=>window.__fixture.lead.complete(id,{status:'partial',business:{industry:'unknown',description:'',services:[],audience:[]},officialSite:{url:'https://example.invalid/candidate',status:'candidate',confidence:.35,reason:'Недостаточно подтверждений, что сайт принадлежит компании.'},signals:[],opportunities:[],score:{total:0,priority:'unknown',components:[],reasons:[],services:[]}}),job.id);
      await page.evaluate(()=>window.VCLead.refresh(true));
      assert.equal(await page.locator('#leadCardMount [role=status]').filter({hasText:'Результат появится после обработки'}).count(),0);
      assert.equal(await page.locator('.li-mini-jobs').count(),0);assert.match(await page.locator('.li-research-meta').innerText(),/Частичные данные/);
      assert.equal(await page.locator('.li-business h4').innerText(),'Отрасль не определена');
      const business=await page.locator('.li-business').innerText();assert.doesNotMatch(business,/unknown|Аудитория:|Официальный сайт:/);assert.match(business,/Сайт-кандидат:.*\n.*35%/s);
      assert.equal(await page.locator('.li-business a').getAttribute('href'),'https://example.invalid/candidate');
      await page.screenshot({path:path.join(out,'desktop-partial-research.png')});
      await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.querySelector('#drawer').scrollWidth<=document.querySelector('#drawer').clientWidth+1),true);await page.screenshot({path:path.join(out,'mobile-partial-research.png')});await page.setViewportSize({width:1440,height:1000});
      for(const status of ['failed','cancelled']){
        await page.locator('#liForceResearch').check();await page.getByRole('button',{name:'Quick Scan',exact:true}).click();await saved('Исследование в очереди');
        await page.evaluate(status=>{const f=window.__fixture.lead;f.jobs.find(j=>j.project_id==='fixture-3'&&j.status==='queued').status=status;const lead=f.leads.find(l=>l.project_id==='fixture-3');lead.status=status==='failed'?'error':status;lead.updated_at=new Date().toISOString();},status);
        await page.evaluate(()=>window.VCLead.refresh(true));assert.equal(await page.locator('#leadCardMount [role=status]').filter({hasText:'Результат появится после обработки'}).count(),0);
      }
      await close();await open('fixture-1');await tab('research');assert.match(await page.locator('.li-business').innerText(),/Официальный сайт:/);
    });
    await test('Material editing saves revision, treats HTML as text, supports copy and download',async()=>{
      await tab('materials');const text='Проверенный черновик <img src=x onerror="window.injected=true">';
      await page.locator('#liMaterial_proposal').fill(text);await page.getByRole('button',{name:'Сохранить материалы',exact:true}).click();await saved('Материалы сохранены');
      await page.evaluate(()=>window.VCLead.refresh(true));await saved('Материалы сохранены');
      assert.equal(await page.evaluate(()=>window.__fixture.lead.leads[0].materials.proposal),text);
      assert.equal(await page.evaluate(()=>window.injected),undefined);
      assert.equal(await page.locator('#liMaterial_proposal').inputValue(),text);
      await page.getByRole('button',{name:'Скопировать всё',exact:true}).click();await saved('Материалы скопированы');assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/Проверенный черновик/);
      await page.evaluate(()=>window.VCLead.refresh(true));await saved('Материалы скопированы');
      const download=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать .txt',exact:true}).click();const file=await download;assert.match(file.suggestedFilename(),/\.txt$/);
      assert.match(fs.readFileSync(await file.path(),'utf8'),/Проверенный черновик/);
    });
    await test('Optimistic conflict preserves unsaved material; explicit reload recovers saved version',async()=>{
      await page.evaluate(()=>window.__fixture.lead.conflictOnce=true);await page.locator('#liMaterial_proposal').fill('Этот текст нельзя потерять при конфликте');
      await page.getByRole('button',{name:'Сохранить материалы',exact:true}).click();await page.locator('#leadCardMount [role=alert]').filter({hasText:'другом окне'}).waitFor();
      assert.equal(await page.locator('#liMaterial_proposal').inputValue(),'Этот текст нельзя потерять при конфликте');
      await page.getByRole('button',{name:'Загрузить сохранённое',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#liMaterial_proposal')?.value.startsWith('Проверенный черновик'));
    });
    await test('Manual reply classification stores refusal and consent rules require fresh evidence to clear it',async()=>{
      await tab('history');await page.locator('#liReplyText').fill('Не интересно, больше не пишите нам.');await page.getByRole('button',{name:'Сохранить и классифицировать',exact:true}).click();await saved('Ответ сохранён');
      assert.equal(await page.evaluate(()=>window.__fixture.lead.leads[0].opted_out),true);await page.locator('.li-reply').getByText('Отказ',{exact:true}).waitFor();
      await page.getByText('Основание контакта и исключения',{exact:true}).click();await page.locator('#liPolicyForm [name=optedOut]').uncheck();
      await page.getByRole('button',{name:'Сохранить правила контакта',exact:true}).click();await page.getByRole('alert').filter({hasText:'снять отказ'}).waitFor();
      if(!await page.locator('#liPolicyForm').isVisible())await page.getByText('Основание контакта и исключения',{exact:true}).click();await page.locator('#liPolicyForm [name=basis]').selectOption('customer_request');
      await page.locator('#liPolicyForm [name=note]').fill('Тест: компания позднее сама запросила подробности.');await page.getByRole('button',{name:'Сохранить правила контакта',exact:true}).click();await saved('Правила контакта сохранены');
      assert.equal(await page.evaluate(()=>window.__fixture.lead.leads[0].opted_out),false);assert.equal(await page.evaluate(()=>window.__fixture.lead.leads[0].contact_permission.basis),'customer_request');
      await page.screenshot({path:path.join(out,'desktop-history.png')});await close();
    });
    await test('Deep Research can be enqueued for a low-score company; queue supports pause resume cancel retry',async()=>{
      await open('fixture-4');await tab('research');assert.match(await page.locator('.li-score').innerText(),/Низкий/);
      await page.getByRole('button',{name:'Deep Research',exact:true}).click();await saved('Исследование в очереди');
      const job=await page.evaluate(()=>window.__fixture.lead.jobs.find(j=>j.project_id==='fixture-4'&&j.kind==='deep'));
      assert.equal(job.status,'queued');await close();await hub('queue');
      const ctl=op=>page.locator(`[data-job-id="${job.id}"][data-job-op="${op}"]`);
      await ctl('pause').click();await ctl('resume').waitFor();await ctl('resume').click();await ctl('cancel').waitFor();await ctl('cancel').click();await ctl('retry').waitFor();await ctl('retry').click();await ctl('pause').waitFor();
      await page.evaluate(id=>window.__fixture.lead.complete(id),job.id);await page.locator('.li-topline [data-li-action=refresh]').click();await page.waitForFunction(id=>window.__fixture.lead.jobs.find(j=>j.id===id).status==='completed',job.id);
      await open('fixture-4');await tab('research');await page.getByText('Deep Research',{exact:true}).last().waitFor();await tab('materials');assert.ok((await page.locator('#liMaterial_proposal').inputValue()).length>20);await close();
      await hub('queue');await page.screenshot({path:path.join(out,'desktop-queue.png')});
    });
    await test('Owner configures schedule, batch limits and weights; invalid weights are rejected before API',async()=>{
      await hub('settings');await page.locator('[name=dailyQuick]').fill('123');await page.locator('[name=scheduleTime]').fill('10:30');
      await page.getByText('Отрасли и объяснимый скоринг',{exact:true}).click();await page.locator('[name=weight_fit]').fill('30');const before=await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>r.action==='settings').length);
      await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.locator('#liSettingsMessage').filter({hasText:'равна 100'}).waitFor();assert.equal(await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>r.action==='settings').length),before);
      await page.locator('[name=weight_fit]').fill('25');await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.getByRole('status').filter({hasText:'Настройки сохранены'}).waitFor();
      assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.dailyQuick),123);assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.scheduleTime),'10:30');
      assert.equal(await page.locator('[name=aiEnabled]').isDisabled(),true);assert.equal(await page.locator('[name=deepModel] option').count(),1);
      await page.screenshot({path:path.join(out,'desktop-settings.png')});
    });
    await test('Analytics displays actual synthetic zero spend and explicitly unconnected campaigns',async()=>{
      await hub('analytics');await page.getByText('Результаты кампаний не измеряются:',{exact:false}).waitFor();
      assert.match(await page.locator('.li-stat-line').innerText(),/0,00/);assert.equal(await page.getByRole('button',{name:/Отправить/}).count(),0);
      await page.screenshot({path:path.join(out,'desktop-analytics.png')});
    });
    await test('Budget warnings use effective server ceiling and never treat disabled AI as spent budget',async()=>{
      await page.evaluate(()=>{const f=window.__fixture.lead;f.settings.aiEnabled=true;f.settings.dailyBudgetUsd=20;f.capabilities.maxDailyBudgetUsd=10;f.usage.costNanos=8e9;});await page.locator('.li-topline [data-li-action=refresh]').click();await page.getByRole('status').filter({hasText:'80% дневного бюджета'}).waitFor();
      await page.evaluate(()=>window.__fixture.lead.usage.reservedNanos=2e9);await page.locator('.li-topline [data-li-action=refresh]').click();await page.getByRole('alert').filter({hasText:'Дневной бюджет исчерпан'}).waitFor();
      await page.evaluate(()=>{const f=window.__fixture.lead;f.settings.aiEnabled=false;f.settings.dailyBudgetUsd=0;f.capabilities.maxDailyBudgetUsd=0;f.usage.costNanos=0;f.usage.reservedNanos=0;});await page.locator('.li-topline [data-li-action=refresh]').click();await page.waitForFunction(()=>!document.querySelector('.li-center [role=alert]'));
    });
    await test('Incremental summary pages update earlier companies without discarding unchanged records',async()=>{
      await page.evaluate(()=>{const lead=window.__fixture.lead.leads.find(l=>l.project_id==='fixture-1');lead.status='researching';lead.updated_at=new Date().toISOString();});await page.evaluate(()=>window.VCLead.refresh(true));await nav('projects');
      assert.equal(await page.locator('tr[data-id]').count(),4);assert.match(await page.locator('tr[data-id=fixture-1] .li-state-cell').innerText(),/Исследуется/);
      assert.ok(await page.evaluate(()=>window.__fixture.lead.requests.some(r=>r.action==='overview'&&r.since)));
      await page.evaluate(()=>{const lead=window.__fixture.lead.leads.find(l=>l.project_id==='fixture-1');lead.status='complete';lead.updated_at=new Date().toISOString();});await page.evaluate(()=>window.VCLead.refresh(true));await nav('intelligence');
    });
    await test('Service errors preserve the rest of CRM and retry restores the queue',async()=>{
      await page.evaluate(()=>window.__fixture.lead.fail=true);await page.locator('.li-topline [data-li-action=refresh]').click();await page.getByRole('alert').filter({hasText:'последние загруженные'}).waitFor();
      await nav('projects');assert.equal(await page.locator('tr[data-id]').count(),4);await page.evaluate(()=>window.__fixture.lead.fail=false);await nav('intelligence');await page.locator('.li-topline [data-li-action=refresh]').click();await page.waitForFunction(()=>!document.querySelector('.li-center [role=alert]'));
    });
    await test('Responsive layouts, source controls, keyboard tabs and reduced motion',async()=>{
      for(const [label,width,height] of [['tablet',768,1024],['mobile',390,844]]){
        await page.setViewportSize({width,height});
        for(const tabId of ['queue','analytics','settings']){await hub(tabId);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.evaluate(()=>document.querySelector('#view').scrollWidth<=document.querySelector('#view').clientWidth+1),true);await page.screenshot({path:path.join(out,`${label}-${tabId}.png`)});}
        await open('fixture-1');await tab('research');assert.equal(await page.evaluate(()=>document.querySelector('#drawer').scrollWidth<=document.querySelector('#drawer').clientWidth+1),true);await page.screenshot({path:path.join(out,`${label}-research.png`)});await close();
      }
      await nav('projects');await page.locator('#liCompanySearch').fill('банкет');assert.equal(await page.locator('tr[data-id]').count(),2);await page.locator('#liCompanySearch').fill('');
      await open('fixture-1');await page.locator('[data-li-card-tab=crm]').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('[data-li-card-tab=research]').getAttribute('aria-selected'),'true');
      assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#drawer')).transitionDuration),'0s');await page.keyboard.press('Escape');assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'),'true');
      await page.setViewportSize({width:1440,height:1000});
    });
    await test('Role restrictions and unconfigured service are honest, while existing import still works',async()=>{
      await page.goto(origin+'/?manager');await page.locator('#nextCallBtn').waitFor();await hub('settings');await page.getByText('Настройки может менять владелец',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Сохранить настройки',exact:true}).count(),0);
      await open('fixture-4');await tab('research');assert.equal(await page.getByRole('button',{name:'Deep Research',exact:true}).isEnabled(),true);await close();
      await page.goto(origin+'/?viewer');await page.locator('#nextCallBtn').waitFor();await open('fixture-1');await tab('materials');assert.ok((await page.locator('#liMaterial_proposal').inputValue()).length>20);assert.equal(await page.getByRole('button',{name:'Сохранить материалы',exact:true}).count(),0);assert.equal(await page.locator('#liMaterial_proposal').isDisabled(),true);await tab('research');assert.equal(await page.getByRole('button',{name:'Deep Research',exact:true}).isDisabled(),true);await close();
      await page.goto(origin+'/?lead-unconfigured');await page.locator('#nextCallBtn').waitFor();await nav('intelligence');await page.getByRole('heading',{name:'Подключение исследований'}).waitFor();assert.equal(await page.evaluate(()=>window.__fixture.lead.requests.length),0);await nav('projects');assert.equal(await page.locator('tr[data-id]').count(),4);await nav('import');
      const csv='Company,Phone,City,Call_Script\nСохранённый импорт,80000000009,Москва,Скрипт';await page.locator('#fileIn').setInputFiles({name:'regression.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});await page.locator('#impRun').click();await page.locator('#impOut').getByText(/Готово/).waitFor();assert.equal(await page.evaluate(()=>window.__fixture.rows.some(r=>r.company==='Сохранённый импорт')),true);
    });
    await test('ChatGPT setup is honest, status is functional, provider switching preserves API settings',async()=>{
      await page.goto(origin+'/?chatgpt');await page.locator('#nextCallBtn').waitFor();await hub('settings');
      await page.getByText('Подключение требует первого входа через локальный помощник',{exact:false}).waitFor();
      assert.equal(await page.locator('[name=aiProvider]').inputValue(),'chatgpt_plan');assert.equal(await page.locator('[name=aiEnabled]').isDisabled(),true);
      assert.equal(await page.locator('[name=dailyBudgetUsd]').count(),0);assert.equal(await page.locator('[name=companyBudgetUsd]').count(),0);assert.equal(await page.locator('[name=deepModel]').isDisabled(),true);
      assert.equal(await page.locator('[data-li-action=chatgpt-connect]').count(),0);assert.equal(await page.getByRole('button',{name:/Продолжить с ChatGPT/}).count(),0);
      await page.getByRole('button',{name:'Проверить подключение',exact:true}).click();await page.getByRole('status').filter({hasText:'Состояние подключения обновлено'}).waitFor();
      assert.equal(await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>r.action==='chatgpt_status').length),1);
      await page.locator('[name=aiProvider]').selectOption('openrouter');await page.locator('[name=dailyBudgetUsd]').waitFor();assert.equal(await page.locator('[name=deepModel]').inputValue(),'openai/gpt-4.1-mini');
      await page.locator('[name=aiProvider]').selectOption('chatgpt_plan');await page.locator('[name=dailyPlanRequests]').fill('10');await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.getByRole('status').filter({hasText:'Настройки сохранены'}).waitFor();
      assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.aiEnabled),false);assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.dailyBudgetUsd),0);
      await page.screenshot({path:path.join(out,'desktop-chatgpt-setup.png')});
    });
    await test('Connected plan requires explicit AI enable and uses the returned account model catalog',async()=>{
      await page.evaluate(()=>{localStorage.removeItem('vc.li.chatgptPlanAcknowledged.v1');window.__fixture.lead.connectChatgpt();});
      await page.getByRole('button',{name:'Проверить подключение',exact:true}).click();await page.getByRole('dialog').waitFor();
      assert.match(await page.getByRole('dialog').innerText(),/расходуют лимиты твоей подписки/);assert.equal(await page.getByRole('dialog').getByRole('link').getAttribute('href'),'https://chatgpt.com/settings/usage');
      await page.getByRole('button',{name:'Понятно',exact:true}).click();assert.equal(await page.locator('[name=aiEnabled]').isChecked(),false);
      assert.equal(await page.evaluate(()=>window.leaked),undefined);assert.match(await page.locator('.li-plan-connection').innerText(),/Тестовый аккаунт <script>/);
      assert.equal(await page.locator('[name=deepModel] option[value=fixture-account-model]').innerText(),'Модель тестового аккаунта');assert.equal(await page.locator('[name=deepModel] option').count(),2);
      await page.locator('[name=aiEnabled]').check();const before=await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>r.action==='settings').length);
      await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.locator('#liSettingsMessage').filter({hasText:'Выбери доступную модель'}).waitFor();assert.equal(await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>r.action==='settings').length),before);
      await page.locator('[name=deepModel]').selectOption('fixture-account-model');await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.getByRole('status').filter({hasText:'Настройки сохранены'}).waitFor();
      assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.aiEnabled),true);assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.deepModel),'fixture-account-model');
      await page.getByRole('button',{name:'Проверить подключение',exact:true}).click();await page.getByRole('status').filter({hasText:'Состояние подключения обновлено'}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
      await page.setViewportSize({width:390,height:844});await page.locator('.li-plan-connection').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(out,'mobile-chatgpt-settings.png')});await page.setViewportSize({width:1440,height:1000});
      await open('fixture-1');await tab('research');await page.getByText('Подписка ChatGPT. Расходует лимиты твоей подписки.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Deep Research',exact:true}).isEnabled(),true);await close();
    });
    await test('Plan analytics counts requests without a fictitious zero price and disconnect stops AI',async()=>{
      await page.evaluate(()=>Object.assign(window.__fixture.lead.usage,{planRequests:8,planCompletedRequests:6,planReservedRequests:2,planUncertainRequests:1,planInputTokens:1500,planOutputTokens:300,costNanos:5000000000,reservedNanos:2000000000}));await page.evaluate(()=>window.VCLead.refresh(true));await hub('analytics');
      await page.getByRole('status').filter({hasText:'80% дневного лимита AI-запросов приложения: 8 из 10'}).waitFor();assert.equal(await page.getByRole('alert').count(),0);
      assert.doesNotMatch(await page.locator('.li-center').innerText(),/USD|US\$|0,00|Средний подтверждённый расход/);assert.match(await page.locator('.li-stat-line').innerText(),/Запросы ChatGPT за день\s*8\s*В обработке\s*2/);
      assert.equal(await page.getByRole('link',{name:'Управлять лимитами ↗'}).first().getAttribute('href'),'https://chatgpt.com/settings/usage');
      await page.evaluate(()=>window.__fixture.lead.usage.planRequests=10);await page.evaluate(()=>window.VCLead.refresh(true));await page.getByRole('alert').filter({hasText:'Дневной лимит AI-запросов приложения исчерпан'}).waitFor();
      await page.screenshot({path:path.join(out,'desktop-chatgpt-analytics.png')});await hub('settings');await page.getByRole('button',{name:'Отключить ChatGPT',exact:true}).click();await page.getByRole('status').filter({hasText:'Подписка ChatGPT отключена'}).waitFor();
      assert.equal(await page.evaluate(()=>window.__fixture.lead.capabilities.chatgpt.connected),false);assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.aiEnabled),false);assert.equal(await page.locator('[name=aiEnabled]').isChecked(),false);assert.equal(await page.locator('[name=aiEnabled]').isDisabled(),true);
    });
    await test('Plan errors explain limits and account eligibility without repeated requests',async()=>{
      await page.goto(origin+'/?chatgpt-active');await page.locator('#nextCallBtn').waitFor();await hub('settings');
      await page.evaluate(()=>window.__fixture.lead.capabilities.chatgpt.error='subscription_sharing_user_not_eligible');await page.evaluate(()=>window.VCLead.refresh(true));await page.getByRole('alert').filter({hasText:'Подключённому аккаунту недоступно использование подписки'}).waitFor();
      await page.evaluate(()=>{delete window.__fixture.lead.capabilities.chatgpt.error;window.__fixture.lead.nextError={action:'enqueue',code:'subscription_sharing_usage_limit_exceeded'};});await page.evaluate(()=>window.VCLead.refresh(true));
      await open('fixture-1');await tab('research');const before=await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>r.action==='enqueue').length);await page.getByRole('button',{name:'Deep Research',exact:true}).click();
      await page.locator('#leadCardMount [role=alert]').filter({hasText:'Достигнут лимит подписки ChatGPT'}).waitFor();assert.equal(await page.locator('#leadCardMount .li-limit-action a').getAttribute('href'),'https://chatgpt.com/settings/usage');assert.equal(await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>r.action==='enqueue').length),before+1);await close();
      await page.evaluate(()=>window.__fixture.lead.jobs[0].error_code='plan_quota_exceeded');await page.evaluate(()=>window.VCLead.refresh(true));await hub('queue');await page.getByText('Дневной лимит AI-запросов Workspace исчерпан.',{exact:false}).waitFor();assert.equal(await page.locator('.li-job .li-limit-action a').getAttribute('href'),'https://chatgpt.com/settings/usage');
    });
    await test('Other members cannot enable or manually trigger AI through a personal ChatGPT account',async()=>{
      await page.goto(origin+'/?manager&chatgpt-active');await page.locator('#nextCallBtn').waitFor();await hub('settings');
      await page.getByText('Управление личной подпиской доступно только её владельцу.',{exact:false}).waitFor();assert.equal(await page.locator('[name=aiEnabled]').isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Проверить подключение',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Отключить ChatGPT',exact:true}).count(),0);
      await open('fixture-1');await tab('research');assert.equal(await page.getByRole('button',{name:'Deep Research',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Quick Scan',exact:true}).isEnabled(),true);await close();await hub('queue');
      assert.equal(await page.locator('[data-job-id=job-paused][data-job-op=resume]').isDisabled(),true);assert.equal(await page.locator('[data-job-id=job-failed][data-job-op=retry]').isDisabled(),true);assert.equal(await page.evaluate(()=>window.__fixture.lead.requests.filter(r=>['chatgpt_connect','chatgpt_disconnect','enqueue','job'].includes(r.action)).length),0);
      await page.evaluate(()=>window.__fixture.lead.settings.aiEnabled=false);await page.evaluate(()=>window.VCLead.refresh(true));await open('fixture-1');await tab('research');assert.equal(await page.getByRole('button',{name:'Deep Research',exact:true}).isDisabled(),true);await close();
    });
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(assetErrors,[]);
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),status:'LOCAL_FIXTURE_VERIFIED',data:'synthetic',backendPersistence:'verified separately',providerCalls:0,productionRequests:0,pageErrors:errors,assetErrors,viewports:[1440,768,390],scenarios:results},null,2));
  }catch(error){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
  finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
