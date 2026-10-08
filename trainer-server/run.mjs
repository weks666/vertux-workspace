import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {openBudget} from './budget.mjs';
import {createTrainerHandler} from './handler.mjs';
import {supabaseAuthenticator,openRouterProvider} from './adapters.mjs';

// No credentials are accepted over HTTP, passed on the command line or printed.
export function startTrainer(env=process.env){
  const integer=name=>{const n=Number(env[name]);if(!Number.isInteger(n)||n<=0)throw new Error('Missing positive setting: '+name);return n;};
  const config={enabled:env.TRAINER_ENABLED==='true',productId:env.TRAINER_PRODUCT_ID,organizationId:env.TRAINER_ORGANIZATION_ID,
    usageSalt:env.TRAINER_USAGE_SALT,origins:['https://weks666.github.io','https://workspace.vertux.online'],
    dailyTokens:integer('TRAINER_DAILY_TOKENS'),userDailyTokens:integer('TRAINER_USER_DAILY_TOKENS'),requestsPerMinute:integer('TRAINER_REQUESTS_PER_MINUTE'),totalBudgetNanos:Math.floor(Number(env.TRAINER_TOTAL_BUDGET_USD)*1e9)};
  const filename=env.TRAINER_BUDGET_DB;
  if(!filename||filename===':memory:')throw new Error('A persistent trainer budget database is required');
  const provider=openRouterProvider({apiKey:env.TRAINER_OPENROUTER_KEY,model:env.TRAINER_MODEL,maxKeyUsd:Number(env.TRAINER_MAX_KEY_USD)});
  const authenticate=supabaseAuthenticator({anonKey:env.TRAINER_SUPABASE_ANON_KEY});
  const budget=openBudget(filename);
  const handle=createTrainerHandler({config,provider,authenticate,budget,notice:event=>process.stderr.write(JSON.stringify(event)+'\n')});
  const attempts=new Map();
  const server=createServer(async(req,res)=>{
    if(req.url!=='/webhook/vertux-ai-trainer'){res.writeHead(404).end();return;}
    const minute=Math.floor(Date.now()/60000),ip=createHmac('sha256',config.usageSalt).update(req.socket.remoteAddress||'unknown').digest('hex');
    // The socket address is authoritative; arbitrary X-Forwarded-For is ignored.
    if(attempts.size>1024)for(const [k,v] of attempts)if(v.minute!==minute)attempts.delete(k);
    const bucket=attempts.get(ip)||{minute,count:0};if(bucket.minute!==minute){bucket.minute=minute;bucket.count=0;}
    bucket.count++;attempts.set(ip,bucket);
    if(bucket.count>120){res.writeHead(429,{'Cache-Control':'no-store'}).end();return;}
    try{
      const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:req,duplex:'half'})});
      const response=await handle(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    }catch(_){res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"error":"trainer_unavailable"}');}
  });
  server.requestTimeout=50000;server.headersTimeout=10000;server.maxHeadersCount=40;
  server.on('close',()=>budget.close());
  // External access must use the existing authenticated, TLS reverse proxy.
  server.listen(integer('TRAINER_PORT'),'127.0.0.1');
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(resolve(process.argv[1]))).href){
  try{startTrainer();process.stdout.write('Trainer listening on loopback. No production activation is implied.\n');}
  catch(error){process.stderr.write('Trainer refused to start: '+error.message+'\n');process.exitCode=1;}
}
