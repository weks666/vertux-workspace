import {LeadError} from './errors.mjs';

async function readJSON(fetcher,url,options={},signal){
  let response;
  try{response=await fetcher(url,{...options,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}catch{throw new LeadError('provider_unavailable',503);}
  if(!response.ok)throw new LeadError(response.status===429?'provider_rate_limited':response.status===402?'provider_budget_exhausted':'provider_unavailable',503);
  const reader=response.body?.getReader();if(!reader)throw new LeadError('provider_invalid_response',502);
  const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>200000){await reader.cancel();throw new LeadError('provider_response_too_large',502);}chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch(error){throw error instanceof LeadError?error:new LeadError('provider_invalid_response',502);}
}
// Uses the existing OpenRouter integration. Selection is a server-owned allowlist,
// never an arbitrary provider URL or model supplied by external website content.
export function createLeadProvider({apiKey,models=['openai/gpt-4.1-mini'],providerName='OpenAI',providerSlug='openai',maxKeyUsd,fetcher=fetch,now=Date.now}){
  if(!apiKey||!Array.isArray(models)||!models.length||models.some(m=>!/^[-a-z0-9._]+\/[-a-z0-9._:]+$/i.test(m))||!Number.isFinite(maxKeyUsd)||maxKeyUsd<=0)throw new LeadError('provider_configuration_invalid',503);
  const pricing=new Map(),requests=new Map();
  async function verify(model,signal){
    if(!models.includes(model))throw new LeadError('model_not_allowed',403);
    const old=pricing.get(model);if(old&&now()-old.checkedAt<30000)return true;
    if(requests.has(model))return requests.get(model);
    const operation=(async()=>{
      const key=(await readJSON(fetcher,'https://openrouter.ai/api/v1/key',{headers:{Authorization:'Bearer '+apiKey},cache:'no-store'},signal))?.data;
      if(!key||!Number.isFinite(key.limit)||key.limit<=0||key.limit>maxKeyUsd||!Number.isFinite(key.limit_remaining)||key.limit_remaining<=0||key.limit_remaining>key.limit||key.limit_reset||key.is_management_key===true||key.disabled===true)throw new LeadError('provider_cap_unverified',503);
      const response=await readJSON(fetcher,'https://openrouter.ai/api/v1/models/'+model.split('/').map(encodeURIComponent).join('/')+'/endpoints',{},signal);
      const endpoints=response?.data?.endpoints?.filter(e=>e.provider_name===providerName);
      if(response?.data?.id!==model||!endpoints?.length)throw new LeadError('model_price_unverified',503);
      const rates=endpoints.map(e=>e.pricing),input=Math.max(...rates.map(p=>Number(p?.prompt))),output=Math.max(...rates.map(p=>Number(p?.completion)));
      if(!Number.isFinite(input)||input<0||!Number.isFinite(output)||output<0||rates.some(p=>Number(p?.request||0)!==0||Number(p?.image||0)!==0||Number(p?.web_search||0)!==0||Number(p?.internal_reasoning||0)!==0))throw new LeadError('model_price_unverified',503);
      pricing.set(model,{input,output,checkedAt:now()});return true;
    })();
    requests.set(model,operation);try{return await operation;}finally{requests.delete(model);}
  }
  function rate(model){const price=pricing.get(model);if(!price||now()-price.checkedAt>=30000)throw new LeadError('model_price_unverified',503);return price;}
  return {
    models:[...models],ready:verify,
    quote(model,prompt){const p=rate(model);return Math.ceil((prompt.inputBound*p.input+prompt.max_tokens*p.output)*1.1*1e9)+10000;},
    async complete(model,prompt,signal){
      const p=rate(model);
      const result=await readJSON(fetcher,'https://openrouter.ai/api/v1/chat/completions',{
        method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
        body:JSON.stringify({model,messages:prompt.messages,max_tokens:prompt.max_tokens,temperature:prompt.temperature,response_format:prompt.response_format,stream:false,
          provider:{only:[providerSlug],order:[providerSlug],allow_fallbacks:false,require_parameters:true,data_collection:'deny',max_price:{prompt:p.input*1e6,completion:p.output*1e6,request:0}}})
      },signal);
      return {text:result.choices?.[0]?.message?.content,usage:result.usage};
    }
  };
}
