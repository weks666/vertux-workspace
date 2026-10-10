import {randomUUID} from 'node:crypto';
import {generateSalesMaterials} from './ai.mjs';
import {composeMaterials} from './sales.mjs';
import {LeadError,publicCode} from './errors.mjs';
import {DEFAULT_SETTINGS} from './settings.mjs';

export function createLeadWorker({store,researchCompany,provider=null,providers=null,budgetCaps=null,workerId=randomUUID(),pollMs=5000,heartbeatMs=15000,jobTimeoutMs=240000,notice=()=>{},now=Date.now}){
  const active=new Map();let timer=null,ticking=false,stopping=false,lastSchedule=-Infinity,tickFinished=Promise.resolve();
  async function processJob(job,settings){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(new Error('job_timeout')),jobTimeoutMs);timeout.unref?.();
    const record={controller,promise:null};active.set(job.id,record);
    let beating=false;
    const pulse=setInterval(async()=>{
      if(beating||controller.signal.aborted)return;beating=true;
      try{const current=await store.heartbeat(job.id,job.worker_id,{stage:'researching',percent:30});if(!current||current.status!=='running')controller.abort(new Error('lease_lost'));}
      catch{controller.abort(new Error('lease_lost'));}finally{beating=false;}
    },heartbeatMs);pulse.unref?.();
    try{
      const result=await researchCompany(job.project,{kind:job.kind,settings,previous:job.force?null:job.previous,force:job.force===true,signal:controller.signal});
      if(controller.signal.aborted)throw controller.signal.reason;
      if(!result.pages?.length){
        const transient=(result.limitations||[]).find(item=>['REQUEST_TIMEOUT','REQUEST_FAILED','DNS_FAILED','ROBOTS_UNAVAILABLE','RATE_LIMITED','HTTP_UNAVAILABLE'].includes(item.code));
        if(transient)throw new LeadError(transient.code.toLowerCase(),503);
      }
      const lease=await store.heartbeat(job.id,job.worker_id,{stage:'materials',percent:75});
      if(!lease||lease.status!=='running')throw new Error('lease_lost');
      const selected=providers?providers[settings.aiProvider]:provider;
      const sales=job.kind==='deep'?await generateSalesMaterials({project:job.project,research:result,settings,job,store,provider:selected,signal:controller.signal}):{materials:composeMaterials(job.project,result),ai:{status:'not_requested',method:'evidence_templates'}};
      if(controller.signal.aborted)throw controller.signal.reason;
      // complete checks the lease again in the same transaction as all writes.
      await store.complete(job.id,job.worker_id,{...result,...sales});
      notice({code:'lead_job_completed',jobId:job.id,kind:job.kind,aiStatus:sales.ai.status});
    }catch(error){
      const code=controller.signal.aborted?(stopping?'worker_stopped':'job_interrupted'):publicCode(error,'research_failed');
      try{await store.fail(job.id,job.worker_id,code);}catch{}
      notice({code,jobId:job.id,kind:job.kind});
    }finally{clearTimeout(timeout);clearInterval(pulse);active.delete(job.id);}
  }
  async function tick(){
    if(ticking||stopping)return;ticking=true;
    let finishTick;tickFinished=new Promise(resolve=>{finishTick=resolve;});
    try{
      const settings={...structuredClone(DEFAULT_SETTINGS),...await store.getSettings()};
      if(budgetCaps){
        settings.dailyBudgetUsd=Math.min(settings.dailyBudgetUsd,Math.max(0,Number(budgetCaps.maxDailyBudgetUsd)||0));
        settings.companyBudgetUsd=Math.min(settings.companyBudgetUsd,Math.max(0,Number(budgetCaps.maxCompanyBudgetUsd)||0));
        settings.dailyPlanRequests=Math.min(settings.dailyPlanRequests,budgetCaps.maxDailyPlanRequests||50);
        if(settings.aiProvider==='openrouter'&&(!settings.dailyBudgetUsd||!settings.companyBudgetUsd))settings.aiEnabled=false;
        if(settings.aiProvider==='chatgpt_plan'&&!budgetCaps.chatgptOwnerId)settings.aiEnabled=false;
      }
      if(now()-lastSchedule>=60000){await store.schedule();lastSchedule=now();}
      if(!settings.enabled||settings.paused)return;
      const slots=Math.max(0,Math.min(6,Number(settings.concurrency)||1)-active.size);
      for(let i=0;i<slots&&!stopping;i++){
        const job=await store.claim(workerId);if(!job)break;
        if(stopping){await store.fail(job.id,job.worker_id,'worker_stopped');break;}
        if(!job.project?.id||!['quick','deep'].includes(job.kind)||!job.worker_id){await store.fail(job.id,job.worker_id,'invalid_job');continue;}
        const promise=processJob(job,settings);const record=active.get(job.id);if(record)record.promise=promise;
      }
    }catch(error){notice({code:publicCode(error),component:'lead_worker'});}
    finally{ticking=false;finishTick();}
  }
  return {
    tick,
    start(){if(timer)return;stopping=false;timer=setInterval(()=>{void tick();},pollMs);timer.unref?.();void tick();},
    async drain(){await Promise.allSettled([...active.values()].map(item=>item.promise));},
    async stop(){stopping=true;clearInterval(timer);timer=null;for(const item of active.values())item.controller.abort(new Error('worker_stopped'));await tickFinished;for(const item of active.values())item.controller.abort(new Error('worker_stopped'));await this.drain();},
    state(){return {workerId,running:active.size,stopping};}
  };
}
