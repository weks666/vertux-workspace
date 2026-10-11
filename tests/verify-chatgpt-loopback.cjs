// Isolated browser regression: no OpenAI requests, credentials, or production data.
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createServer}=require('node:net');
const {once}=require('node:events');
const {chromium}=require(process.env.WORKSPACE_PLAYWRIGHT||path.resolve(__dirname,'../../../projects/vertux-invest-workspace/node_modules/playwright'));

(async()=>{
  const {createChatGPTLoopback}=await import(pathToFileURL(path.join(__dirname,'../lead-server/chatgpt-loopback.mjs')));
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`,authorizationUrl=origin+'/auth/health?state=fixture-state';let begins=0,callbacks=0,submittedOrigin,redirectReferrer,externalRequests=0;
  const helper=await createChatGPTLoopback({port,credentials:{
    async begin({redirectUri}){begins++;assert.equal(redirectUri,origin+'/auth/callback');return {authorizationUrl};},
    async callback(input){callbacks++;assert.equal(input.code,'fixture-code');return {connected:true};}
  }});
  helper.server.on('request',req=>{if(req.method==='POST'&&req.url==='/auth/start')submittedOrigin=req.headers.origin;if(req.url==='/auth/health?state=fixture-state')redirectReferrer=req.headers.referer;});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  try{
    const context=await browser.newContext();
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin)return route.continue();
      externalRequests++;
      return route.abort();
    });
    const page=await context.newPage();
    await page.goto(origin);
    const response=page.waitForResponse(r=>r.url()===origin+'/auth/start');
    await page.getByRole('button',{name:'Продолжить с ChatGPT'}).click();
    assert.equal((await response).status(),303,`Home form rejected; browser submitted Origin=${submittedOrigin}`);
    await page.waitForURL(authorizationUrl);
    assert.equal(submittedOrigin,origin);assert.equal(begins,1);assert.equal(externalRequests,0);assert.equal(redirectReferrer,undefined);
    const callback=await page.goto(origin+'/auth/callback?state=fixture-state&code=fixture-code');
    assert.equal(callback.status(),200);assert.equal(callback.headers()['referrer-policy'],'no-referrer');
    assert.equal(await page.getByRole('heading').innerText(),'ChatGPT подключён');assert.equal(callbacks,1);
    const replay=await page.goto(origin+'/auth/callback?state=fixture-state&code=fixture-code');
    assert.equal(replay.status(),400);assert.equal(callbacks,1);
    console.log(JSON.stringify({status:'LOCAL_BROWSER_SIGN_IN_VERIFIED',sameOriginFormAccepted:true,redirectReferrerAbsent:true,callbackBoundToBrowser:true,replayRejected:true,upstreamNetworkRequests:0}));
  }finally{await browser.close();await helper.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
