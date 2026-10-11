import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {createLeadStore} from './store.mjs';
import {createLeadHandler} from './handler.mjs';
import {createLeadWorker} from './worker.mjs';
import {createLeadProvider} from './provider.mjs';
import {createResearcher} from './research.mjs';
import {createChatGPTCredentials} from './chatgpt-auth.mjs';
import {createChatGPTProvider} from './chatgpt-provider.mjs';
import {createChatGPTLoopback} from './chatgpt-loopback.mjs';
import {createRemoteChatGPT} from './chatgpt-remote.mjs';

function positive(env,key,fallback,min=1,max=1000000){const value=Number(env[key]??fallback);if(!Number.isInteger(value)||value<min||value>max)throw new Error('Invalid setting: '+key);return value;}
function cap(env,key){const value=Number(env[key]||0);if(!Number.isFinite(value)||value<0||value>10000)throw new Error('Invalid setting: '+key);return value;}
export function readLeadConfig(env=process.env){
  const supabaseUrl=String(env.LEAD_SUPABASE_URL||'');let url;
  try{url=new URL(supabaseUrl);}catch{throw new Error('LEAD_SUPABASE_URL required');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('HTTPS Supabase origin required');
  if(!env.LEAD_SUPABASE_SERVICE_KEY||!env.LEAD_SUPABASE_ANON_KEY)throw new Error('Server Supabase credentials required');
  const models=String(env.LEAD_ALLOWED_MODELS||'openai/gpt-4.1-mini').split(',').map(s=>s.trim()).filter(Boolean);
  return {
    enabled:env.LEAD_ENABLED==='true',supabaseUrl:url.origin,serviceKey:env.LEAD_SUPABASE_SERVICE_KEY,anonKey:env.LEAD_SUPABASE_ANON_KEY,
    organizationId:env.LEAD_ORGANIZATION_ID,productId:env.LEAD_PRODUCT_ID,usageSalt:env.LEAD_USAGE_SALT,
    origins:String(env.LEAD_ORIGINS||'https://weks666.github.io,https://workspace.vertux.online').split(',').map(s=>s.trim()),
    models,aiAvailable:Boolean(env.LEAD_OPENROUTER_KEY),apiKey:env.LEAD_OPENROUTER_KEY,
    providerName:env.LEAD_PROVIDER_NAME||'OpenAI',providerSlug:env.LEAD_PROVIDER_SLUG||'openai',
    maxKeyUsd:cap(env,'LEAD_MAX_KEY_USD'),maxDailyBudgetUsd:cap(env,'LEAD_MAX_DAILY_USD'),maxCompanyBudgetUsd:cap(env,'LEAD_MAX_COMPANY_USD'),
    requestsPerMinute:positive(env,'LEAD_REQUESTS_PER_MINUTE',60,10,300),port:positive(env,'LEAD_PORT',47921,1024,65535),pollMs:positive(env,'LEAD_POLL_MS',5000,1000,60000),
    browserImage:env.LEAD_BROWSER_IMAGE||'',pageSpeedKey:env.LEAD_PAGESPEED_KEY||''
    ,chatgptOwnerId:env.LEAD_CHATGPT_OWNER_ID||'',chatgptDirectory:env.LEAD_CHATGPT_DIRECTORY||'',
    chatgptRemoteUrl:env.LEAD_CHATGPT_REMOTE_URL||'',chatgptRemoteKey:env.LEAD_CHATGPT_REMOTE_KEY||'',
    maxDailyPlanRequests:positive(env,'LEAD_MAX_DAILY_PLAN_REQUESTS',10,1,50),chatgptPort:positive(env,'LEAD_CHATGPT_PORT',47922,1024,65535)
  };
}
export function createAuthenticator({supabaseUrl,anonKey,fetcher=fetch}){
  return async authorization=>{
    const res=await fetcher(supabaseUrl+'/auth/v1/user',{headers:{apikey:anonKey,Authorization:authorization},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(!res.ok)throw new Error('Authentication failed');
    const reader=res.body?.getReader();if(!reader)throw new Error('Authentication failed');let count=0;const chunks=[];
    for(;;){const {value,done}=await reader.read();if(done)break;count+=value.byteLength;if(count>65536){await reader.cancel();throw new Error('Authentication failed');}chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}

export async function startLeadServer(env=process.env){
  const config=readLeadConfig(env);
  const store=createLeadStore(config);
  const provider=config.aiAvailable?createLeadProvider(config):null;
  if((config.chatgptDirectory||config.chatgptRemoteUrl)&&!/^[0-9a-f-]{36}$/i.test(config.chatgptOwnerId))throw new Error('ChatGPT personal owner required');
  if(Boolean(config.chatgptRemoteUrl)!==Boolean(config.chatgptRemoteKey))throw new Error('Complete ChatGPT host configuration required');
  const credentials=!config.chatgptRemoteUrl&&config.chatgptDirectory?createChatGPTCredentials({directory:config.chatgptDirectory}):null;
  const chatgpt=config.chatgptRemoteUrl?createRemoteChatGPT({url:config.chatgptRemoteUrl,key:config.chatgptRemoteKey}):credentials?{credentials,provider:createChatGPTProvider({credentials})}:null;
  const notice=event=>process.stderr.write(JSON.stringify({at:new Date().toISOString(),...event})+'\n');
  const authenticate=createAuthenticator(config);
  const handle=createLeadHandler({config,store,authenticate,chatgpt,notice});
  const worker=createLeadWorker({store,providers:{openrouter:provider,chatgpt_plan:chatgpt?.provider},budgetCaps:config,pollMs:config.pollMs,notice,researchCompany:createResearcher({env})});
  const attempts=new Map();
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({service:'vertux-lead-intelligence',alive:true}));return;}
    if(req.url!=='/webhook/vertux-lead-intelligence'){res.writeHead(404).end();return;}
    const minute=Math.floor(Date.now()/60000),ip=createHmac('sha256',config.usageSalt).update(req.socket.remoteAddress||'').digest('hex');
    if(attempts.size>1024)for(const [key,value] of attempts)if(value.minute!==minute)attempts.delete(key);
    const bucket=attempts.get(ip)||{minute,count:0};if(bucket.minute!==minute){bucket.minute=minute;bucket.count=0;}
    bucket.count++;attempts.set(ip,bucket);if(bucket.count>600){res.writeHead(429,{'Cache-Control':'no-store'}).end();return;}
    try{
      const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:req,duplex:'half'})});
      const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    }catch{res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"ok":false,"error":"lead_service_unavailable"}');}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.maxHeadersCount=40;
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',done);});
  const login=credentials?await createChatGPTLoopback({credentials,port:config.chatgptPort}):null;
  if(config.enabled)worker.start();
  return {server,worker,async close(){await worker.stop();await login?.close();await new Promise(done=>server.close(done));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(resolve(process.argv[1]))).href){
  try{
    const runtime=await startLeadServer();let closing=false;
    for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{if(closing)return;closing=true;void runtime.close().then(()=>process.exit(0));});
    process.stdout.write('Lead Intelligence listening on loopback. Liveness is not provider acceptance.\n');
  }catch(error){process.stderr.write('Lead Intelligence refused to start: '+(String(error.message).startsWith('Invalid setting:')?error.message:'configuration or runtime unavailable')+'\n');process.exitCode=1;}
}
