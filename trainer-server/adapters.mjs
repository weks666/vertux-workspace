import {TrainerError} from './prompts.mjs';

async function jsonResponse(fetcher,url,options,timeout){
  const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new TrainerError(response.status===401?401:503,'remote_service_unavailable');
  // Do not expose an upstream response body in errors or logs.
  const reader=response.body?.getReader();
  if(!reader)throw new TrainerError(502,'invalid_upstream_response');
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>100000){await reader.cancel();throw new TrainerError(502,'upstream_response_too_large');}chunks.push(Buffer.from(value));}
  const text=Buffer.concat(chunks).toString('utf8');
  try{return JSON.parse(text);}catch(_){throw new TrainerError(502,'invalid_upstream_response');}
}
export function supabaseAuthenticator({anonKey,fetcher=fetch}){
  if(!anonKey)throw new Error('Supabase public key is required');
  return async authorization=>jsonResponse(fetcher,'https://vertuxdb.duckdns.org/auth/v1/user',{
    headers:{apikey:anonKey,Authorization:authorization},cache:'no-store'
  },5000);
}
export function openRouterProvider({apiKey,model,maxKeyUsd,fetcher=fetch,now=Date.now}){
  if(!apiKey||!model||!Number.isFinite(maxKeyUsd)||maxKeyUsd<=0)throw new Error('Provider key, explicit model and approved key cap are required');
  let checkedAt=null,pricing=null;
  return {
    async ready(){
      if(checkedAt!==null&&now()-checkedAt<30000)return true;
      const result=await jsonResponse(fetcher,'https://openrouter.ai/api/v1/key',{
        headers:{Authorization:'Bearer '+apiKey},cache:'no-store'
      },5000);
      const key=result?.data;
      if(!key||typeof key.limit!=='number'||!Number.isFinite(key.limit)||key.limit<=0||key.limit>maxKeyUsd||typeof key.limit_remaining!=='number'||!Number.isFinite(key.limit_remaining)||key.limit_remaining<=0||key.limit_remaining>key.limit||key.limit_reset||key.is_management_key===true||key.disabled===true)return false;
      const endpoints=await jsonResponse(fetcher,'https://openrouter.ai/api/v1/models/'+model.split('/').map(encodeURIComponent).join('/')+'/endpoints',{},5000);
      const rates=endpoints?.data?.endpoints?.filter(e=>e.provider_name==='OpenAI').map(e=>e.pricing);
      if(endpoints?.data?.id!==model||!rates?.length)return false;
      const input=Math.max(...rates.map(p=>Number(p.prompt))),output=Math.max(...rates.map(p=>Number(p.completion)));
      if(!Number.isFinite(input)||input<=0||!Number.isFinite(output)||output<=0||rates.some(p=>Number(p.request||0)!==0))return false;
      pricing={input,output};
      checkedAt=now();return true;
    },
    quote(prompt){
      if(!pricing||checkedAt===null||now()-checkedAt>=30000)throw new TrainerError(503,'model_price_unverified');
      // USD nanounits; reserve the worst-case prompt/output plus a price margin.
      // The persistent product budget is separate from the provider key's cap.
      return Math.ceil((prompt.inputBound*pricing.input+prompt.max_tokens*pricing.output)*1.1*1e9)+10000;
    },
    async complete(prompt){
      const result=await jsonResponse(fetcher,'https://openrouter.ai/api/v1/chat/completions',{
        method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
        body:JSON.stringify({model,messages:prompt.messages,max_tokens:prompt.max_tokens,temperature:prompt.temperature,stream:false,provider:{order:['openai'],only:['openai'],allow_fallbacks:false,require_parameters:true,data_collection:'deny',max_price:{prompt:pricing.input*1e6,completion:pricing.output*1e6,request:0}}})
      },24000);
      return {text:result.choices?.[0]?.message?.content,usage:result.usage};
    }
  };
}
