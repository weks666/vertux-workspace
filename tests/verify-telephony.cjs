const {chromium}=require(process.env.WORKSPACE_PLAYWRIGHT||'../../../projects/vertux-invest-workspace/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const evidence=path.resolve(__dirname,'../evidence/sales-audit');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const errors=[],external=[],results=[];
  const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!=='http://127.0.0.1:47861'){
      external.push(route.request().url());return route.abort();
    }
    return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const test=async(name,fn)=>{await fn();results.push({name,status:'passed'});console.log('PASS '+name);};
  const storedCalls=()=>page.evaluate(()=>window.__fixture.rows.flatMap(r=>r.raw.calls||[]).length);
  try{
    await page.goto('http://127.0.0.1:47861/');await page.locator('#nextCallBtn').waitFor();
    const before=await storedCalls();
    await page.locator('[data-open=fixture-1]').click();
    await test('failed application launch shows recovery without a new call outcome',async()=>{
      await page.evaluate(()=>{window.open=()=>{throw new Error('simulated popup failure');};});
      await page.locator('#callBtn').click();
      assert.match(await page.locator('#dialMsg').innerText(),/Не удалось открыть/);
      assert.equal(await page.locator('#outcomeBox').evaluate(el=>el.classList.contains('live')),false);
      assert.equal(await storedCalls(),before);
    });
    await test('TEL uses a new-window request and does not invent a connected call',async()=>{
      await page.evaluate(()=>{window.__dialRequests=[];window.open=(...args)=>{window.__dialRequests.push(args);return null;};});
      const expected=await page.evaluate(()=>window.WorkspaceCore.phone(window.__fixture.rows.find(r=>r.id==='fixture-1').phone));
      await page.locator('#callBtn').focus();await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(()=>window.__dialRequests),[['tel:'+expected,'_blank','noopener,noreferrer']]);
      assert.equal(await storedCalls(),before);
      assert.equal(new URL(page.url()).pathname,'/');
      assert.match(await page.locator('#dialMsg').innerText(),/фактического звонка/);
      const phoneLink=page.locator('#drawer a[href^="tel:"]');
      assert.equal(await phoneLink.getAttribute('target'),'_blank');
      assert.equal(await phoneLink.getAttribute('rel'),'noopener noreferrer');
    });
    await test('setup is available beside the call button at desktop and mobile widths',async()=>{
      await page.locator('#drawer .telephony-help summary').click();
      assert.match(await page.locator('#drawer .telephony-help').innerText(),/Novofon \+ MicroSIP/);
      assert.match(await page.locator('#drawer .telephony-help').innerText(),/Т-Мобайла/);
      fs.mkdirSync(evidence,{recursive:true});
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:960});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert.ok(await page.locator('#drawer').evaluate(el=>el.scrollWidth<=el.clientWidth));
        await page.screenshot({path:path.join(evidence,'telephony-drawer-'+width+'.png')});
      }
      await page.keyboard.press('Escape');
      await page.locator('[data-id=calls]').click();
      await page.locator('#view .telephony-help summary').click();
      assert.match(await page.locator('#view .telephony-help').innerText(),/первым|Телефон|телефон/);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(evidence,'telephony-calls-390.png')});
    });
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    fs.writeFileSync(path.join(evidence,'telephony-ui.json'),JSON.stringify({at:new Date().toISOString(),status:'FIXTURE_TESTED',results,errors,externalRequests:external.length,actualCalls:0},null,2)+'\n');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
