import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {LeadError,fail,publicCode} from './errors.mjs';
import {ANALYSIS_INSTRUCTIONS} from './ai.mjs';
import {createChatGPTCredentials} from './chatgpt-auth.mjs';
import {createChatGPTProvider} from './chatgpt-provider.mjs';
import {createChatGPTLoopback} from './chatgpt-loopback.mjs';

const ROUTE='/webhook/vertux-lead-chatgpt';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS={status:[],models:[],ready:['model'],complete:['model','prompt','requestId'],disconnect:[],resume:[]};
export function createHostLedger({path,dailyCap=10,now=Date.now}){
  if(!Number.isInteger(dailyCap)||dailyCap<1||dailyCap>50)throw new Error('Invalid personal quota');
  const db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, day TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS switches (id INTEGER PRIMARY KEY, paused INTEGER NOT NULL); INSERT OR IGNORE INTO switches VALUES (1,1);');
  return {
    reserve(id){
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now());
      db.exec('BEGIN IMMEDIATE');
      try{
        if(db.prepare('SELECT paused FROM switches WHERE id=1').get().paused)throw Object.assign(new LeadError('chatgpt_usage_paused',429),{pause:true});
        if(db.prepare('SELECT id FROM requests WHERE id=?').get(id))fail('request_already_reserved',409);
        if(db.prepare('SELECT count(*) AS n FROM requests WHERE day=?').get(day).n>=dailyCap)throw Object.assign(new LeadError('plan_quota_exceeded',429),{pause:true});
        db.prepare('INSERT INTO requests VALUES (?,?,?)').run(id,day,'reserved');db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    settle(id,state){db.prepare('UPDATE requests SET state=? WHERE id=?').run(state,id);},
    pause(){db.exec('UPDATE switches SET paused=1 WHERE id=1');},
    resume(){db.exec('UPDATE switches SET paused=0 WHERE id=1');},
    close(){db.close();}
  };
}
async function readBody(request){
  if(!request.headers.get('content-type')?.startsWith('application/json'))fail('json_required',415);
  if(Number(request.headers.get('content-length')||0)>65536)fail('body_too_large',413);
  const reader=request.body?.getReader();if(!reader)fail('invalid_json');let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();fail('body_too_large',413);}chunks.push(Buffer.from(value));}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json');}
  if(!body||Array.isArray(body)||!Object.hasOwn(FIELDS,body.action)||Object.keys(body).some(k=>k!=='action'&&!FIELDS[body.action].includes(k)))fail('invalid_action');
  return body;
}
function validatePrompt(prompt){
  if(!prompt||!Array.isArray(prompt.messages)||prompt.messages.length!==2||prompt.messages[0]?.role!=='system'||prompt.messages[0]?.content!==ANALYSIS_INSTRUCTIONS||prompt.messages[1]?.role!=='user'||typeof prompt.messages[1]?.content!=='string'||Buffer.byteLength(JSON.stringify(prompt))>32768)fail('chatgpt_prompt_invalid');
  // No tools, arbitrary instructions, URLs to fetch or client-selected API routes.
  for(const item of prompt.messages)if(Object.keys(item).some(key=>!['role','content'].includes(key)))fail('chatgpt_prompt_invalid');
  let data;try{data=JSON.parse(prompt.messages[1].content);}catch{fail('chatgpt_prompt_invalid');}
  if(typeof data.company!=='string'||data.company.length>160||!Array.isArray(data.facts)||!data.facts.length||data.facts.length>100||!Array.isArray(data.services)||Object.keys(data).some(k=>!['company','facts','services'].includes(k)))fail('chatgpt_prompt_invalid');
  return {messages:prompt.messages};
}
function failureDiagnostic(error){
  const result={event:'chatgpt_inference_failed',code:publicCode(error,'chatgpt_host_unavailable')};
  if(Number.isInteger(error?.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599)result.httpStatus=error.httpStatus;
  if(typeof error?.requestId==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(error.requestId))result.requestId=error.requestId;
  if(['text/event-stream','application/json','text/plain','text/html','application/octet-stream','other','missing'].includes(error?.contentType))result.contentType=error.contentType;
  if(['error_object','detail_text','completed_event','response_object','json_object','json_array','sse_text','html','text','empty','sse:response.failed','sse:error'].includes(error?.bodyShape))result.bodyShape=error.bodyShape;
  return result;
}
export function createChatGPTHostHandler({key,credentials,provider,ledger,now=Date.now,onDiagnostic=()=>{}}){
  if(!/^[a-f0-9]{64}$/.test(key||''))throw new Error('Private host caller key required');
  const expected=Buffer.from('Bearer '+key);let running=null,bucket={minute:0,count:0};
  return async request=>{
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Vertux-Lead-ChatGPT':'v1'};
    const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(new URL(request.url).pathname!==ROUTE)fail('not_found',404);
      const sent=Buffer.from(request.headers.get('authorization')||'');
      if(sent.length!==expected.length||!timingSafeEqual(sent,expected))fail('not_authenticated',401);
      if(request.headers.has('origin'))fail('origin_not_allowed',403);
      if(request.method!=='POST')fail('method_not_allowed',405);
      const minute=Math.floor(now()/60000);if(bucket.minute!==minute)bucket={minute,count:0};if(++bucket.count>120)fail('rate_limit_reached',429);
      const body=await readBody(request);let result;
      switch(body.action){
        case 'status':{
          const s=await credentials.status();result={connected:s.connected===true,scopes:s.scopes,account:s.account?{label:s.account.label}:null};break;
        }
        case 'models':result=await provider.listModels(request.signal);break;
        case 'ready':result=await provider.ready(body.model,request.signal);break;
        case 'resume':await provider.clearUsageBlock();ledger.resume();result=true;break;
        case 'disconnect':
          ledger.pause();running?.abort(Object.assign(new LeadError('chatgpt_disconnected',499),{pause:true}));
          result=await credentials.disconnect();break;
        case 'complete':{
          if(!UUID.test(body.requestId||'')||typeof body.model!=='string'||body.model.length>128)fail('invalid_input');
          const prompt=validatePrompt(body.prompt);
          if(running)fail('chatgpt_host_busy',429);
          const controller=new AbortController(),active=AbortSignal.any([request.signal,controller.signal]);
          ledger.reserve(body.requestId);running=controller;
          let abort;
          try{
            active.throwIfAborted();
            const stopped=new Promise((_,reject)=>{abort=()=>reject(active.reason);active.addEventListener('abort',abort,{once:true});});
            result=await Promise.race([provider.complete(body.model,prompt,active),stopped]);
            active.throwIfAborted();ledger.settle(body.requestId,'settled');
          }
          catch(error){ledger.settle(body.requestId,'uncertain');if(error?.pause===true)ledger.pause();try{onDiagnostic(failureDiagnostic(error));}catch{}if(active.aborted&&!(error instanceof LeadError))throw new LeadError('chatgpt_request_aborted',499);throw error;}
          finally{if(abort)active.removeEventListener('abort',abort);running=null;}
          break;
        }
      }
      return reply(200,{ok:true,result});
    }catch(error){return reply(error instanceof LeadError?error.status:503,{ok:false,error:publicCode(error,'chatgpt_host_unavailable'),pause:error.pause===true});}
  };
}

export async function startChatGPTHost(env=process.env){
  process.umask(0o077);
  const directory=env.LEAD_CHATGPT_DIRECTORY;if(!directory)throw new Error('Private state directory required');
  const credentials=createChatGPTCredentials({directory});await credentials.status();
  const provider=createChatGPTProvider({credentials});
  const ledger=createHostLedger({path:join(directory,'requests.sqlite'),dailyCap:Number(env.LEAD_MAX_DAILY_PLAN_REQUESTS||10)});
  const handle=createChatGPTHostHandler({key:env.LEAD_CHATGPT_REMOTE_KEY,credentials,provider,ledger,onDiagnostic:value=>process.stderr.write(JSON.stringify(value)+'\n')});
  const port=Number(env.LEAD_CHATGPT_HOST_PORT||47923);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid host port');
  const server=createServer(async(req,res)=>{
    if(req.url==='/health'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"alive":true,"role":"personal_chatgpt_host"}');return;}
    const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
    try{
      const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,signal:controller.signal,...(['GET','HEAD'].includes(req.method)?{}:{body:req,duplex:'half'})});
      const result=await handle(request);res.writeHead(result.status,Object.fromEntries(result.headers)).end(await result.text());
    }catch{res.writeHead(503,{'Cache-Control':'no-store'}).end();}
  });
  server.requestTimeout=20000;server.headersTimeout=5000;server.maxHeadersCount=24;
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
  const login=await createChatGPTLoopback({credentials,port:47922});
  return {server,async close(){await login.close();await new Promise(done=>server.close(done));ledger.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(resolve(process.argv[1]))).href){
  try{const host=await startChatGPTHost();let closing=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(closing)return;closing=true;void host.close().then(()=>process.exit(0));});process.stdout.write('Personal ChatGPT host ready; owner sign-in and model acceptance pending.\n');}
  catch{process.stderr.write('Personal ChatGPT host refused to start.\n');process.exitCode=1;}
}
