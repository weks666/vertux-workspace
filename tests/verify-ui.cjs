const {chromium}=require(process.env.WORKSPACE_PLAYWRIGHT||'../../../projects/vertux-invest-workspace/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'evidence/sales-audit');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const results=[],errors=[],external=[];fs.mkdirSync(dir,{recursive:true});
 const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block',reducedMotion:'reduce'});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin!=='http://127.0.0.1:47861'){external.push(route.request().url());return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const nav=async id=>{await page.locator('[data-id='+id+']').click();await page.waitForFunction(id=>document.querySelector('[data-id='+id+']').classList.contains('active'),id);};
 const test=async(name,fn)=>{await fn();results.push({name,status:'passed'});console.log('PASS '+name);};
 const row=id=>page.evaluate(id=>structuredClone({...window.__fixture.rows.find(r=>r.id===id),finance:window.__fixture.finances.find(f=>f.project_id===id)||null}),id);
 const waitRow=async(id,predicate)=>{const check=new Function('r','return ('+predicate+')');for(let i=0;i<100;i++){if(check(await row(id)))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Fixture row did not reach expected state: '+id);};
 try{
  await page.goto('http://127.0.0.1:47861/');await page.locator('#nextCallBtn').waitFor();
  await test('saved reminder is explicitly not call history and can be cleared',async()=>{
   await page.locator('[data-open=fixture-1]').click();assert.match(await page.locator('#ncMsg').innerText(),/Звонков в журнале нет/);
   await page.locator('#ncClear').click();await waitRow('fixture-1','r.raw.next_call===null');assert.equal((await row('fixture-1')).raw.calls.length,0);
  });
  await test('manual call is saved only after outcome; demo requested is not sent',async()=>{
   await page.locator('#manualCall').click();assert.equal((await row('fixture-1')).raw.calls.length,0);
   await page.locator('[data-out=demo]').click();await waitRow('fixture-1','r.stage==="contacted"&&r.raw.calls.length===1');
   assert.equal((await row('fixture-1')).raw.calls[0].out,'demo');assert.equal((await row('fixture-1')).stage,'contacted');
  });
  await test('saving demo link does not invent a sent demo',async()=>{
   await page.locator('#demoBtn').click();await page.locator('#mLink').fill('https://example.invalid/preview');await page.locator('#mSave').click();
   await waitRow('fixture-1','r.demo==="https://example.invalid/preview"');assert.equal((await row('fixture-1')).stage,'contacted');
   await page.keyboard.press('Escape');
  });
  await test('money accepts Russian amounts and zero, rejects invalid share and preserves payment date',async()=>{
   await nav('money');await page.locator('[data-amt=fixture-2]').fill('20 000,50');await page.locator('[data-amt=fixture-2]').press('Enter');
   await waitRow('fixture-2','r.finance.money.amount===20000.5');assert.equal((await row('fixture-2')).finance.money.paid_at,'2026-10-01T12:00:00');
   await page.locator('[data-pct=fixture-2]').fill('101');await page.locator('[data-pct=fixture-2]').press('Enter');await page.locator('[data-pct=fixture-2].bad').waitFor();assert.equal((await page.evaluate(()=>window.__fixture.finances.find(f=>f.project_id==='fixture-2'))).money.percent,35);
   await page.locator('[data-pct=fixture-2]').fill('12,5');await page.locator('[data-pct=fixture-2]').press('Enter');await waitRow('fixture-2','r.finance.money.percent===12.5');
   await page.locator('[data-amt=fixture-2]').fill('0');await page.locator('[data-amt=fixture-2]').press('Enter');await waitRow('fixture-2','r.finance.money.amount===0');
   await page.waitForFunction(()=>document.querySelector('[data-amt="fixture-2"]').value==='0');assert.doesNotMatch(await page.locator('#view').innerText(),/оплаченная сделка без суммы/);
  });
  await test('keyboard opens company card, traps focus and restores focus on Escape',async()=>{
   await nav('projects');const tr=page.locator('tr[data-id=fixture-1]');await tr.focus();await page.keyboard.press('Enter');
   assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'),'false');await page.keyboard.press('Shift+Tab');
   assert.equal(await page.evaluate(()=>document.querySelector('#drawer').contains(document.activeElement)),true);await page.keyboard.press('Escape');
   assert.equal(await tr.evaluate(el=>el===document.activeElement),true);
  });
  await test('trainer manual transcript, hint and review work and review survives tabs',async()=>{
   await nav('trainer');await page.locator('#trLeadSel').selectOption('fixture-1');await page.locator('#trAuto').uncheck();
   await page.locator('#trManual').fill('Менеджер: Подскажите, на какую дату и сколько гостей вы планируете корпоратив?');await page.locator('#trAddLine').click();
   await page.locator('#trHintBtn').click();await page.locator('#trHints').getByText(/ТЕСТОВЫЙ РАЗБОР/).waitFor();
   await page.locator('#trToReview').click();await page.locator('#trReviewBtn').click();await waitRow('fixture-1','r.raw.reviews?.length===1');
   await page.locator('[data-ttab=roleplay]').click();await page.locator('[data-ttab=review]').click();assert.match(await page.locator('#trResult').innerText(),/ТЕСТОВЫЙ РАЗБОР/);
  });
  await test('roleplay keeps failed draft and debrief excludes coach and system messages',async()=>{
   await page.locator('[data-ttab=roleplay]').click();await page.locator('#trMsg').fill('Здравствуйте, удобно коротко обсудить заявки на банкеты?');await page.locator('#trSend').click();
   await page.locator('#trChat .c').waitFor();await page.locator('#trDebrief').click();await page.locator('#trChat .coach').waitFor();
   await page.evaluate(()=>window.__fixture.failAI=true);await page.locator('#trMsg').fill('Сохрани этот черновик при ошибке');await page.locator('#trSend').click();
   await page.waitForFunction(()=>document.querySelector('#trMsg').value==='Сохрани этот черновик при ошибке');
   await page.evaluate(()=>window.__fixture.failAI=false);await page.locator('#trDebrief').click();await page.waitForFunction(()=>document.querySelectorAll('#trChat .coach').length===2);
   const history=await page.evaluate(()=>window.__fixture.aiRequests.filter(x=>x.mode==='debrief').at(-1).history);assert.ok(history.every(x=>['m','c'].includes(x.who)));
   await page.screenshot({path:path.join(dir,'desktop-roleplay.png')});
  });
  await test('microphone network error stops restarts and navigation aborts microphone',async()=>{
   await page.locator('[data-ttab=live]').click();await page.locator('#trMic').click();await page.evaluate(()=>window.__fixture.speech.onerror({error:'network'}));
   await page.locator('#trSpeechError').getByText(/не отвечает/).waitFor();const count=await page.evaluate(()=>window.__fixture.speechStarts);
   await page.waitForTimeout(550);assert.equal(await page.evaluate(()=>window.__fixture.speechStarts),count);
   await page.locator('#trMic').click();await nav('projects');assert.ok(await page.evaluate(()=>window.__fixture.speechAborts>=2));
  });
  await test('CSV preview separates same-name cities and preserves existing call history on merge',async()=>{
   await nav('import');const csv='Company,Phone,City,Call_Script,Context\nТестовый банкетный зал,80000000001,Санкт-Петербург,Обновлённый скрипт,Проверенный контекст\nНовый зал,80000000005,Москва,Скрипт А,Контекст А\nНовый зал,80000000006,Казань,Скрипт Б,Контекст Б';
   await page.locator('#fileIn').setInputFiles({name:'isolated-fixture.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});await page.locator('#impRun').waitFor();
   await page.locator('#impRun').click();await page.locator('#impOut').getByText(/Готово/).waitFor();
   const added=await page.evaluate(()=>window.__fixture.rows.filter(r=>r.company==='Новый зал'));assert.equal(added.length,2);assert.equal((await row('fixture-1')).raw.calls.length,1);assert.equal((await row('fixture-1')).call_script,'Обновлённый скрипт');
  });
  await test('real XLSX parser accepts compatible workbook',async()=>{
   const XLSX=require('../vendor/xlsx.full.min.js'),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([{Company:'XLSX тест',Phone:'80000000007',City:'Москва',Call_Script:'Скрипт'}]),'Leads');
   await page.locator('#fileIn').setInputFiles({name:'isolated-fixture.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}))});
   await page.locator('#impRun').waitFor();assert.match(await page.locator('#impOut').innerText(),/XLSX тест/);
  });
  await test('current Service Center renders all three sections using local bridge only',async()=>{
   for(const section of ['subscription','support','access']){await nav(section);await page.locator('vertux-service-center').waitFor({state:'visible'});await page.locator('vertux-service-center [data-section='+section+']').waitFor();}
  });
  await test('Workspace switcher calls product selection',async()=>{
   await page.locator('#productSwitcher').focus();await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>window.__fixture.switches),['products']);
  });
  await test('database failure does not display fabricated zero counts',async()=>{
   await page.evaluate(()=>window.__fixture.failDB=true);await page.locator('#refreshBtn').click();await page.getByRole('heading',{name:'База недоступна'}).waitFor();
   assert.equal(await page.locator('#view .kpi').count(),0);await page.evaluate(()=>window.__fixture.failDB=false);await page.locator('#refreshBtn').click();
  });
  await test('manager sees no finance section; viewer has no edit controls',async()=>{
   await page.goto('http://127.0.0.1:47861/?manager');await page.locator('#nextCallBtn').waitFor();assert.equal(await page.locator('[data-id=money]').count(),0);
   await page.goto('http://127.0.0.1:47861/?viewer');await page.locator('#nextCallBtn').waitFor();await nav('projects');assert.equal(await page.locator('[data-stage],[data-demo],[data-call]').count(),0);await nav('trainer');assert.equal(await page.locator('#trHintBtn').isDisabled(),true);
  });
  await test('project list exposes rows beyond 300 instead of silently truncating',async()=>{
   await page.evaluate(()=>{for(let i=0;i<310;i++)window.__fixture.rows.push({id:'bulk-'+i,company:'Тест '+i,stage:'new',raw:{}});});await page.locator('#refreshBtn').click();await nav('projects');
   assert.equal(await page.locator('tr[data-id]').count(),300);await page.locator('#projectsMore').click();assert.equal(await page.locator('tr[data-id]').count(),314);
  });
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  fs.writeFileSync(path.join(dir,'ui-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),status:'LOCAL_VERIFIED',data:'synthetic',ai:'simulated',productionRequests:0,pageErrors:errors,scenarios:results},null,2));
 }catch(error){await page.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{});throw error;}
 finally{await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
