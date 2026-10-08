const {chromium}=require(process.env.WORKSPACE_PLAYWRIGHT||'../../../projects/vertux-invest-workspace/node_modules/playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const results=[];
 try{
  fs.mkdirSync('evidence/sales-audit',{recursive:true});
  for(const [name,width,height] of [['desktop',1440,960],['tablet',768,1024],['mobile',390,844]]){
   const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block',reducedMotion:'reduce'});
   const page=await context.newPage(),errors=[],external=[],assetErrors=[];
   await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!=='http://127.0.0.1:47861'){external.push(route.request().url());return route.abort();}return route.continue();});
   page.on('pageerror',e=>errors.push(e.message));
   page.on('response',r=>{if(r.status()>=400)assetErrors.push({url:r.url(),status:r.status()});});
   await page.goto('http://127.0.0.1:47861/');
   await page.locator('#nextCallBtn').waitFor();
   for(const section of ['dashboard','projects','calls','trainer','money','import','subscription','support','access']){
    await page.locator('[data-id='+section+']').click();
    if(['subscription','support','access'].includes(section))await page.locator('vertux-service-center').waitFor({state:'visible'});
    const overflow=await page.evaluate(()=>[...document.querySelectorAll('#view,.topbar,.main')].map(e=>({surface:e.className,width:e.clientWidth,scroll:e.scrollWidth})).filter(e=>e.scroll>e.width+1));
    assert.deepEqual(overflow,[]);results.push({name,section,overflow});
    if(name!=='tablet'&&['dashboard','trainer','subscription','money'].includes(section))await page.screenshot({path:`evidence/sales-audit/${name}-${section}.png`});
   }
   await page.locator('#profileBtn').click();
   assert.equal(await page.getByText('Product identity',{exact:true}).count(),0);
   await page.locator('[data-id=dashboard]').click();
   const reduced=await page.evaluate(()=>{const items=[...document.querySelectorAll('.bar,.fn-fill')];return items.length>0&&items.every(e=>getComputedStyle(e).transitionDuration==='0s');});
   assert.equal(reduced,true);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(assetErrors,[]);
   results.push({name,section:'profile',errors,external,assetErrors,reducedMotion:true});await context.close();
  }
  fs.writeFileSync('evidence/sales-audit/layout-verification.json',JSON.stringify({checkedAt:new Date().toISOString(),data:'synthetic',status:'LOCAL_VERIFIED',results},null,2));
  console.log(JSON.stringify({status:'LOCAL_VERIFIED',widths:[1440,768,390],sections:10,errors:0,externalRequests:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
