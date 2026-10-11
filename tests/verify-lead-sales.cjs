/* Isolated browser data only; every external request is blocked. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {chromium}=require(path.resolve(__dirname,'../../../projects/vertux-invest-workspace/node_modules/playwright'));
const out=path.resolve(__dirname,'../evidence/lead-intelligence/sales-ui');
(async()=>{
 const {startPreview}=await import(pathToFileURL(path.resolve(__dirname,'preview-server.mjs'))),server=await startPreview(47864),browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1100,height:900},reducedMotion:'reduce',acceptDownloads:true}),page=await context.newPage(),errors=[],external=[],results=[];
 await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('vc.li.chatgptPlanAcknowledged.v1','true');});
 await context.route('**/*',r=>{if(new URL(r.request().url()).origin!=='http://127.0.0.1:47864'){external.push(r.request().url());return r.abort();}return r.continue();});page.on('pageerror',e=>errors.push(e.message));
 const test=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);},nav=id=>page.locator(`.nav-item[data-id=${id}]`).click();
 const close=async()=>{if(await page.locator('#drawer.open').count())await page.locator('[data-drawer-close]').click();};
 const tab=async id=>{await page.locator(`[data-li-card-tab=${id}]`).click();await page.locator('#leadCardMount[aria-busy=false]').waitFor();};
 fs.mkdirSync(out,{recursive:true});
 try{
  await page.goto('http://127.0.0.1:47864/?chatgpt-active');await page.locator('#nextCallBtn').waitFor();await nav('projects');await page.waitForFunction(()=>document.querySelectorAll('tr[data-id]').length===4);
  await test('All five compact columns fit 1100/900/768/390 without horizontal scrolling',async()=>{
   for(const width of [1440,1100,900,768,390]){await page.setViewportSize({width,height:900});await page.waitForTimeout(50);assert.ok(await page.locator('.li-company-table').evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await page.locator('tr[data-id=fixture-1] td').count(),5);assert.equal(await page.locator('tr[data-id=fixture-1] [data-li-open-tab=demo]').isVisible(),true);await page.screenshot({path:path.join(out,'companies-'+width+'.png')});}
   await page.setViewportSize({width:1100,height:900});
  });
  await test('Ordinary phone calls save as separate records; correction preserves history and no dial occurs',async()=>{
   await page.locator('tr[data-id=fixture-1]').focus();await page.keyboard.press('Enter');await page.locator('#outcomeBox').waitFor();
   await page.evaluate(()=>{window.__dials=0;window.open=()=>{window.__dials++;};});
   const count=()=>page.evaluate(()=>window.__fixture.rows.find(r=>r.id==='fixture-1').raw.calls?.length||0),before=await count();
   await page.locator('#callOccurredAt').fill('2026-10-10T15:30');await page.locator('#callResultNote').fill('Звонил с мобильного, согласовали письмо');await page.locator('[data-out=callback]').click();await page.getByText('Выбери дату следующего звонка ниже.',{exact:true}).waitFor();assert.equal(await count(),before+1);
   await page.locator('#callResultNote').fill('Второй фактический разговор');await page.locator('[data-out=callback]').click();await page.getByText('Выбери дату следующего звонка ниже.',{exact:true}).waitFor();assert.equal(await count(),before+2);
   await page.locator('#editLastOutcome').click();await page.locator('#callResultNote').fill('Уточнил итог второго разговора');await page.locator('[data-out=callback]').click();await page.getByText('Выбери дату следующего звонка ниже.',{exact:true}).waitFor();assert.equal(await count(),before+2);assert.equal(await page.evaluate(()=>window.__dials),0);await page.screenshot({path:path.join(out,'mobile-call-outcome.png')});await close();
  });
  await test('Research and demo model selections persist independently',async()=>{
   await page.evaluate(()=>{const f=window.__fixture.lead;f.capabilities.chatgpt.models.push({id:'fixture-astra',label:'Astra fixture'});f.settings.demoModel='fixture-astra';});await page.evaluate(()=>window.VCLead.refresh(true));await nav('intelligence');await page.locator('[data-li-tab=settings]').click();
   assert.equal(await page.locator('[name=deepModel]').inputValue(),'fixture-account-model');assert.equal(await page.locator('[name=demoModel]').inputValue(),'fixture-astra');await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.getByText('Настройки сохранены.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.demoModel),'fixture-astra');assert.equal(await page.evaluate(()=>window.__fixture.lead.settings.deepModel),'fixture-account-model');await page.screenshot({path:path.join(out,'model-settings.png')});
  });
  await test('Demo button works without website or legacy prompt; completed result is sandboxed and downloadable',async()=>{
   await nav('projects');await page.locator('tr[data-id=fixture-1] [data-li-open-tab=demo]').click();await page.locator('#leadCardMount[aria-busy=false]').waitFor();await page.locator('[data-li-action=generate-demo]').click();
   await page.waitForFunction(()=>window.__fixture.lead.jobs.some(j=>j.kind==='demo'&&j.status==='queued'));
   await page.evaluate(()=>{const f=window.__fixture.lead,j=f.jobs.find(j=>j.kind==='demo');j.status='completed';const l=f.leads.find(l=>l.project_id===j.project_id);l.demo={kind:'demo',status:'completed',checkedAt:new Date().toISOString(),html:'<!doctype html><meta name="viewport" content="width=device-width"><h1>Изолированный концепт</h1><script>parent.injected=true</script>',ai:{model:'fixture-astra',billing:'chatgpt_plan'}};l.updated_at=new Date().toISOString();});await page.evaluate(()=>window.VCLead.refresh(true));
   await page.locator('#liDemoPreview').waitFor();assert.equal(await page.locator('#liDemoPreview').getAttribute('sandbox'),'');await page.frameLocator('#liDemoPreview').getByRole('heading',{name:'Изолированный концепт'}).waitFor();assert.equal(await page.evaluate(()=>window.injected),undefined);
   const promise=page.waitForEvent('download');await page.locator('[data-li-action=download-demo]').click();assert.match((await promise).suggestedFilename(),/\.html$/);await page.screenshot({path:path.join(out,'demo-preview.png')});
  });
  await test('Audit evidence and legal applicability stay visible; one UTF-8 ZIP includes all manager drafts',async()=>{
   await page.evaluate(()=>{const l=window.__fixture.lead.leads.find(l=>l.project_id==='fixture-1');l.deep.audit={status:'completed',checkedAt:new Date().toISOString(),pages:[{url:'https://example.invalid/form',checkedAt:new Date().toISOString()}],findings:[{title:'Вопрос к политике',category:'legal',certainty:'review',observation:'На тестовой странице не найдена ссылка',fix:'Проверить вручную',url:'https://example.invalid/form',checkedAt:new Date().toISOString(),reproduce:'Открыть тестовую страницу',law:{title:'152-ФЗ, статья 18.1',url:'https://www.consultant.ru/document/cons_doc_LAW_61801/',condition:'Применимость требует проверки',reviewedAt:'2026-10-11'}}],limitations:['Внешняя проверка не подтверждает нарушение.']};});await tab('audit');await page.getByText('Вопрос к политике',{exact:true}).waitFor();await page.locator('.li-audit-finding summary').click();await page.getByText('Применимость требует проверки',{exact:true}).waitFor();
   await page.screenshot({path:path.join(out,'audit-evidence.png')});await tab('materials');await page.getByText('Сценарий менеджера: варианты разговора',{exact:true}).waitFor();assert.ok(await page.locator('.li-playbook details').count()>=15);
   const promise=page.waitForEvent('download');await page.locator('[data-li-action=download-kit]').click();const file=await promise;assert.match(file.suggestedFilename(),/\.zip$/);fs.copyFileSync(await file.path(),path.join(out,'fixture-materials.zip'));const bytes=fs.readFileSync(await file.path());assert.ok(bytes.includes(Buffer.from('Демо/index.html')));assert.ok(bytes.includes(Buffer.from('Аудит.html')));assert.ok(bytes.includes(Buffer.from('Сценарий-звонка.txt')));
  });
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({status:'FIXTURE_TESTED',results,errors,externalRequests:0,providerRequests:0,actualCalls:0},null,2));
 }finally{await browser.close();await new Promise(done=>server.close(done));}
})().catch(e=>{console.error(e);process.exitCode=1;});
