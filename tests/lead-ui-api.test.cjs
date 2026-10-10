const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../data.js'),'utf8');
function harness({token='isolated-session',response={ok:true},status=200,fetchError,endpoint=''}={}){
  const requests=[];
  const window={WorkspaceCore:require('../workspace-core.js'),VCAuth:{client:()=>({auth:{getSession:async()=>({data:{session:token?{access_token:token}:null}})}})}};
  const context=vm.createContext({window,URL,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{requests.push({url,options});if(fetchError)throw fetchError;return {ok:status>=200&&status<300,status,json:async()=>response};}});
  vm.runInContext(source,context,{filename:'data.js'});
  window.VC.CONFIG.leadIntelligenceUrl=endpoint;
  return {api:window.VC,requests};
}
test('Lead API stays disabled until configured and rejects unsafe endpoint URLs before obtaining a session',async()=>{
  const {api,requests}=harness();assert.equal(api.leadConfigured(),false);await assert.rejects(api.leadCall('overview'),{code:'not_configured'});
  for(const url of ['http://example.test/','javascript:alert(1)','https://user:pass@example.test/']){api.CONFIG.leadIntelligenceUrl=url;assert.equal(api.leadConfigured(),false);await assert.rejects(api.leadCall('overview'),{code:'not_configured'});}
  assert.equal(requests.length,0);
});
test('Lead API sends explicit POST action with product session, no redirects or cached responses',async()=>{
  const {api,requests}=harness();api.CONFIG.leadIntelligenceUrl='https://example.test/webhook/vertux-lead-intelligence';
  const result=await api.leadCall('enqueue',{projectId:'project-fixture',kind:'deep',action:'malicious-override'});
  assert.equal(result.ok,true);assert.equal(requests.length,1);
  const request=requests[0];assert.equal(request.options.method,'POST');assert.equal(request.options.redirect,'error');assert.equal(request.options.cache,'no-store');
  assert.equal(request.options.headers.Authorization,'Bearer isolated-session');assert.equal(JSON.parse(request.options.body).action,'enqueue');assert.equal(JSON.parse(request.options.body).projectId,'project-fixture');
});
test('Lead API requires session, maps revision conflicts and preserves network uncertainty without automatic retries',async()=>{
  const missing=harness({token:''});missing.api.CONFIG.leadIntelligenceUrl='https://example.test/lead';await assert.rejects(missing.api.leadCall('overview'),{code:'session_required'});assert.equal(missing.requests.length,0);
  const conflict=harness({status:409,response:{ok:false,error:'revision_conflict'}});conflict.api.CONFIG.leadIntelligenceUrl='https://example.test/lead';await assert.rejects(conflict.api.leadCall('materials'),error=>error.code==='revision_conflict'&&/другом окне/.test(error.message));assert.equal(conflict.requests.length,1);
  const abort=new Error('synthetic timeout');abort.name='AbortError';const timed=harness({fetchError:abort});timed.api.CONFIG.leadIntelligenceUrl='https://example.test/lead';await assert.rejects(timed.api.leadCall('enqueue'),error=>error.code==='timeout'&&/Обнови состояние/.test(error.message));assert.equal(timed.requests.length,1);
});
test('Generic company adapter preserves Rockefeller and 2GIS detection and normalizes duplicate company rows',()=>{
  const {api}=harness();assert.equal(api.detectFormat([{Company:'A',Call_Script:'existing'}]).id,'rockfeller');assert.equal(api.detectFormat([{'Наименование':'A','2GIS URL':'https://example.test/1'}]).id,'2gis');
  const rows=[{Company:'A',Phone:'+7 900 000-00-01',City:'Москва',Website:'https://example.test/'},{Company:'A',Phone:'79000000001',City:'Москва'},{Company:'A',Phone:'79000000002',City:'Казань'}],format=api.detectFormat(rows),mapped=api.mapRows(rows,format);
  assert.equal(format.id,'companies');assert.equal(mapped.rows.length,2);assert.equal(mapped.dupes,1);assert.equal(mapped.rows[0].site,'https://example.test/');assert.equal(mapped.rows[0].source,'companies');
});
