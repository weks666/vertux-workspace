import {LeadError,publicCode} from './errors.mjs';

export const CHATGPT_HOST_URL='https://zxcqweksn8n.duckdns.org/webhook/vertux-lead-chatgpt';
// Fixed personal AI host, verified HTTPS, no redirects, retries or local fallback.
// The shared caller key is separate from OpenAI credentials and never reaches UI.
export function createRemoteChatGPT({url,key,fetcher=fetch}){
  if(url!==CHATGPT_HOST_URL||! /^[a-f0-9]{64}$/.test(key||''))throw new Error('Invalid personal ChatGPT host configuration');
  async function call(action,data={},signal){
    const deadline=AbortSignal.timeout(action==='complete'?160000:35000);
    const active=signal?AbortSignal.any([signal,deadline]):deadline;
    let response,value;
    try{
      response=await fetcher(url,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({action,...data}),redirect:'error',cache:'no-store',signal:active});
      if(response.redirected)throw new Error();
      const reader=response.body?.getReader();if(!reader)throw new Error();let bytes=0;const chunks=[];
      for(;;){const {done,value:part}=await reader.read();if(done)break;bytes+=part.byteLength;if(bytes>262144){await reader.cancel();throw new Error();}chunks.push(Buffer.from(part));}
      value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw new LeadError('chatgpt_host_unavailable',503);}
    if(!response.ok||value?.ok!==true){
      const code=publicCode({code:value?.error},'chatgpt_host_unavailable');
      throw Object.assign(new LeadError(code,response.status>=400&&response.status<=599?response.status:502),{pause:value?.pause===true});
    }
    return value.result;
  }
  return {
    remote:true,
    credentials:{status:()=>call('status'),disconnect:()=>call('disconnect')},
    provider:{
      type:'chatgpt_plan',
      listModels:signal=>call('models',{},signal),
      ready:(model,signal)=>call('ready',{model},signal),
      complete:(model,prompt,signal,context)=>call('complete',{model,prompt,requestId:context?.requestId},signal),
      clearUsageBlock:()=>call('resume')
    }
  };
}
