import {createHmac} from 'node:crypto';
import {makePrompt,trainerModes,TrainerError} from './prompts.mjs';

function assertConfig(config){
  if(!config||!config.productId||!config.organizationId||typeof config.usageSalt!=='string'||config.usageSalt.length<32)throw new Error('Trainer scope and private usage salt are required');
  if(!Array.isArray(config.origins)||!config.origins.length||config.origins.some(o=>{try{const u=new URL(o);return u.origin!==o||u.protocol!=='https:';}catch(_){return true;}}))throw new Error('Exact HTTPS origins are required');
  for(const key of ['dailyTokens','userDailyTokens','requestsPerMinute','totalBudgetNanos'])if(!Number.isSafeInteger(config[key])||config[key]<1)throw new Error('Positive trainer budgets are required');
  if(config.userDailyTokens>config.dailyTokens)throw new Error('User budget exceeds global budget');
}
export function createTrainerHandler({config,authenticate,provider,budget,now=Date.now,notice=()=>{}}){
  assertConfig(config);
  const policy=Object.freeze({...config,origins:[...config.origins]});
  return async function handle(request){
    const origin=request.headers.get('origin');
    const allowed=policy.origins.includes(origin);
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Vertux-Trainer':'v1'};
    if(allowed){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Headers']='Authorization, Content-Type';headers['Access-Control-Allow-Methods']='POST, OPTIONS';}
    const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    let reservedId=null;
    try{
      if(!allowed)throw new TrainerError(403,'origin_not_allowed');
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
      if(request.method!=='POST')throw new TrainerError(405,'method_not_allowed');
      if(!request.headers.get('content-type')?.startsWith('application/json'))throw new TrainerError(415,'json_required');
      const auth=request.headers.get('authorization')||'';
      if(!/^Bearer [\w.~-]{16,8192}$/.test(auth))throw new TrainerError(401,'not_authenticated');
      const user=await authenticate(auth);
      const meta=user?.app_metadata;
      if(!user?.id||!meta?.nexus_managed||meta.nexus_access!=='active'||meta.nexus_product_id!==policy.productId||meta.nexus_organization_id!==policy.organizationId||!['owner','admin','manager'].includes(meta.role))throw new TrainerError(403,'workspace_access_required');
      const bytes=await readBounded(request,65536);
      let body;try{body=JSON.parse(bytes);}catch(_){throw new TrainerError(400,'invalid_json');}
      if(!body||typeof body!=='object'||Array.isArray(body))throw new TrainerError(400,'invalid_input');
      if(policy.enabled!==true)throw new TrainerError(503,'trainer_disabled');
      // A provider cap is checked without a paid completion, and cannot be asserted by the browser.
      if(!await provider.ready())throw new TrainerError(503,'provider_budget_not_verified');
      if(body.mode==='health')return reply(200,{ok:true,service:'vertux-trainer',ready:true,modes:trainerModes,answerVerified:false,budget:budget.balance(policy.totalBudgetNanos)});
      const prompt=makePrompt(body);
      const actor=createHmac('sha256',policy.usageSalt).update(user.id+'|'+policy.productId).digest('hex');
      const costNanos=provider.quote(prompt);
      budget.reserve({requestId:prompt.requestId,actor,tokens:prompt.inputBound+prompt.max_tokens,costNanos,now:now(),policy});
      reservedId=prompt.requestId;
      const answer=await provider.complete(prompt);
      const usage=answer?.usage,text=answer?.text;
      if(typeof text!=='string'||!text.trim()||text.length>16000)throw new TrainerError(502,'empty_answer');
      if(!usage||!Number.isInteger(usage.prompt_tokens)||!Number.isInteger(usage.completion_tokens)||!Number.isInteger(usage.total_tokens)||usage.prompt_tokens<0||usage.completion_tokens<0||usage.prompt_tokens>prompt.inputBound||usage.completion_tokens>prompt.max_tokens||usage.total_tokens!==usage.prompt_tokens+usage.completion_tokens)throw new TrainerError(502,'usage_unverified');
      if(typeof usage.cost!=='number'||!Number.isFinite(usage.cost)||usage.cost<0)throw new TrainerError(502,'cost_unverified');
      budget.settle(prompt.requestId,usage.total_tokens,Math.ceil(usage.cost*1e9));reservedId=null;
      return reply(200,{ok:true,text:text.trim(),requestId:prompt.requestId,budget:budget.balance(policy.totalBudgetNanos)});
    }catch(error){
      if(reservedId)budget.uncertain(reservedId); // Ambiguous failures keep the worst-case charge.
      const status=error instanceof TrainerError?error.status:502;
      const code=error instanceof TrainerError?error.code:'upstream_unavailable';
      if(status===429||status>=500){try{notice({at:new Date(now()).toISOString(),code});}catch(_){}}
      return reply(status,{ok:false,error:code});
    }
  };
}
async function readBounded(request,max){
  if(Number(request.headers.get('content-length')||0)>max)throw new TrainerError(413,'input_too_long');
  const reader=request.body?.getReader();if(!reader)return '';
  const chunks=[];let length=0;
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();throw new TrainerError(413,'input_too_long');}chunks.push(Buffer.from(value));}
  return Buffer.concat(chunks).toString('utf8');
}
