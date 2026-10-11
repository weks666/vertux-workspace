import {LeadError,publicCode} from './errors.mjs';

export const CHATGPT_HOST_URL='https://zxcqweksn8n.duckdns.org/webhook/vertux-lead-chatgpt';
const TIMEOUTS={status:1500,models:4500,disconnect:4500,resume:4500,ready:35000,complete:160000};
async function abortable(signal,operation){
  signal.throwIfAborted();
  let abort;const stopped=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),stopped]);}
  finally{signal.removeEventListener('abort',abort);}
}
// Fixed personal AI host, verified HTTPS, no redirects, retries or local fallback.
// The shared caller key is separate from OpenAI credentials and never reaches UI.
export function createRemoteChatGPT({url,key,fetcher=fetch}){
  if(url!==CHATGPT_HOST_URL||! /^[a-f0-9]{64}$/.test(key||''))throw new Error('Invalid personal ChatGPT host configuration');
  async function call(action,data={},signal){
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),TIMEOUTS[action]);
    const active=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
    let response,value,reader;
    try{
      response=await abortable(active,()=>fetcher(url,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({action,...data}),redirect:'error',cache:'no-store',signal:active}));
      if(response.redirected)throw new Error();
      reader=response.body?.getReader();if(!reader)throw new Error();let bytes=0;const chunks=[];
      for(;;){const {done,value:part}=await abortable(active,()=>reader.read());if(done)break;bytes+=part.byteLength;if(bytes>262144)throw new Error();chunks.push(Buffer.from(part));}
      value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}throw new LeadError('chatgpt_host_unavailable',503);}
    finally{clearTimeout(timer);try{reader?.releaseLock();}catch{}}
    if(!response.ok||value?.ok!==true){
      const code=publicCode({code:value?.error},'chatgpt_host_unavailable');
      throw Object.assign(new LeadError(code,response.status>=400&&response.status<=599?response.status:502),{pause:value?.pause===true});
    }
    return value.result;
  }
  return {
    remote:true,
    credentials:{status:signal=>call('status',{},signal),disconnect:signal=>call('disconnect',{},signal)},
    provider:{
      type:'chatgpt_plan',
      listModels:signal=>call('models',{},signal),
      ready:(model,signal)=>call('ready',{model},signal),
      complete:(model,prompt,signal,context)=>call('complete',{model,prompt,requestId:context?.requestId},signal),
      clearUsageBlock:signal=>call('resume',{},signal)
    }
  };
}
