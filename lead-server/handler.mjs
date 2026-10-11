import {createHmac} from 'node:crypto';
import {LeadError,fail,publicCode} from './errors.mjs';
import {DEFAULT_SETTINGS,validateSettings,validateMaterials} from './settings.mjs';
import {classifyReply} from './sales.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier=value=>{if(typeof value!=='string'||!UUID.test(value))fail('invalid_identifier');return value;};
async function bodyJSON(request){
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))fail('json_required',415);
  const max=65536;if(Number(request.headers.get('content-length')||0)>max)fail('body_too_large',413);
  const reader=request.body?.getReader();if(!reader)fail('invalid_json');const chunks=[];let bytes=0;
  for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max){await reader.cancel();fail('body_too_large',413);}chunks.push(Buffer.from(value));}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json');}
  if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.action!=='string')fail('invalid_input');return body;
}
function responseStatus(error,code){
  if(error instanceof LeadError)return error.status;
  if(/not_found|missing_project/.test(code))return 404;
  if(/conflict|revision|lease|already/.test(code))return 409;
  if(/budget|quota|rate|limit_reached/.test(code))return 429;
  if(/denied|forbidden|access|role|scope/.test(code))return 403;
  if(/invalid|unsupported/.test(code))return 400;
  return 503;
}
export function createLeadHandler({config,store,authenticate,chatgpt=null,now=Date.now,notice=()=>{}}){
  if(!config||!UUID.test(config.organizationId)||!UUID.test(config.productId)||typeof config.usageSalt!=='string'||config.usageSalt.length<32||!Array.isArray(config.origins)||!config.origins.length||config.origins.some(origin=>{try{const url=new URL(origin);return url.origin!==origin||url.protocol!=='https:';}catch{return true;}}))throw new Error('Explicit lead service scope, origins and private salt required');
  const buckets=new Map();
  const policy={...config,origins:[...config.origins],models:[...(config.models||['openai/gpt-4.1-mini'])]};
  const adminActions=new Set(['settings','purge']);
  const readActions=new Set(['overview','detail','health','chatgpt_status']);
  return async function handle(request){
    const origin=request.headers.get('origin'),allowed=policy.origins.includes(origin);
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
    if(allowed)Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS'});
    const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(!allowed)fail('origin_not_allowed',403);
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
      if(request.method!=='POST')fail('method_not_allowed',405);
      if(policy.enabled!==true)fail('lead_service_disabled',503);
      const authorization=request.headers.get('authorization')||'';
      if(!/^Bearer [\w.~-]{16,8192}$/.test(authorization))fail('not_authenticated',401);
      let user;try{user=await authenticate(authorization);}catch{fail('not_authenticated',401);}
      const meta=user?.app_metadata;
      if(!UUID.test(user?.id)||!meta?.nexus_managed||meta.nexus_access!=='active'||meta.nexus_product_id!==policy.productId||meta.nexus_organization_id!==policy.organizationId||!['owner','admin','manager','viewer'].includes(meta.role))fail('workspace_access_required',403);
      const actor=createHmac('sha256',policy.usageSalt).update(user.id).digest('hex'),minute=Math.floor(now()/60000);
      if(buckets.size>2048)for(const [id,value] of buckets)if(value.minute!==minute)buckets.delete(id);
      const bucket=buckets.get(actor)||{minute,count:0};if(bucket.minute!==minute){bucket.minute=minute;bucket.count=0;}
      bucket.count++;buckets.set(actor,bucket);if(bucket.count>(policy.requestsPerMinute||60))fail('rate_limit_reached',429);
      const body=await bodyJSON(request),action=body.action;
      const canConfigure=['owner','admin'].includes(meta.role),canEdit=canConfigure||meta.role==='manager';
      if(adminActions.has(action)&&!canConfigure||!readActions.has(action)&&!canEdit)fail('role_not_allowed',403);
      const db=store.withActor?store.withActor(user.id):store;
      const canManageChatGPT=Boolean(chatgpt&&policy.chatgptOwnerId===user.id&&meta.role==='owner');
      let chatgptInfo={available:Boolean(chatgpt),connected:false,planUsageEnabled:false,canManage:canManageChatGPT,models:[],requiresLocalConnection:true,requiresLocalSetup:true,setupInstruction:'Подключение требует первого входа через локальный помощник на твоём компьютере. После входа сервер сможет использовать разрешённые лимиты.'};
      if(chatgpt?.remote)chatgptInfo.setupInstruction='Войди через локальный помощник. Подключение ChatGPT хранится на отдельном личном AI-сервере; после входа компьютер можно выключить.';
      if(canManageChatGPT)try{
        const status=await chatgpt.credentials.status();
        chatgptInfo={...chatgptInfo,connected:status.connected===true,planUsageEnabled:status.connected===true&&status.scopes?.includes('chatgpt.tokens.use.direct'),accountLabel:status.account?.label||null};
        if(chatgptInfo.planUsageEnabled)try{
          const catalog=await chatgpt.provider.listModels();
          chatgptInfo.models=catalog.models.map(m=>({id:m.slug,label:m.display_name||m.slug}));chatgptInfo.requiresLocalSetup=false;
        }catch(error){chatgptInfo.error=publicCode(error,'chatgpt_models_unavailable');}
      }catch(error){chatgptInfo.error=publicCode(error,'chatgpt_host_unavailable');}
      const capabilities={canEdit,canConfigure,models:policy.models,aiAvailable:policy.aiAvailable===true,maxDailyBudgetUsd:policy.maxDailyBudgetUsd||0,maxCompanyBudgetUsd:policy.maxCompanyBudgetUsd||0,maxDailyPlanRequests:policy.maxDailyPlanRequests||50,chatgpt:chatgptInfo,delivery:'drafts_only',replyIngestion:'manual'};
      switch(action){
        case 'chatgpt_status':await db.getSettings();return reply(200,{ok:true,chatgpt:chatgptInfo});
        case 'chatgpt_disconnect':{
          if(!canManageChatGPT)fail('chatgpt_owner_required',403);
          await db.getSettings();await store.suspendAI('chatgpt_disconnected');
          const status=await chatgpt.credentials.disconnect();
          return reply(200,{ok:true,remoteRevoked:status.remoteRevoked,chatgpt:{...chatgptInfo,connected:false,planUsageEnabled:false,models:[],requiresLocalSetup:true}});
        }
        case 'health':await db.getSettings();return reply(200,{ok:true,service:'vertux-lead-intelligence',ready:true,capabilities});
        case 'overview':{
          if(body.cursor!==undefined&&body.cursor!==null)identifier(body.cursor);
          if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>1000))fail('invalid_page_limit');
          if(body.since!==undefined&&body.since!==null&&(typeof body.since!=='string'||body.since.length>40||Number.isNaN(Date.parse(body.since))))fail('invalid_cursor');
          return reply(200,{ok:true,...await db.overview({cursor:body.cursor||null,limit:body.limit||500,since:body.since||null}),capabilities});
        }
        case 'detail':{const result=await db.detail(identifier(body.projectId));return reply(200,{ok:true,...result,capabilities});}
        case 'enqueue':{
          if(!['quick','deep'].includes(body.kind)||body.force!==undefined&&typeof body.force!=='boolean')fail('invalid_job');
          if(body.kind==='deep'&&chatgpt&&!canManageChatGPT&&(await db.getSettings()).aiProvider==='chatgpt_plan')fail('chatgpt_owner_required',403);
          const job=await db.enqueue(identifier(body.projectId),body.kind,{force:body.force===true,priority:body.kind==='deep'?100:80,manual:true});return reply(200,{ok:true,job});
        }
        case 'job':{
          if(!['pause','resume','retry','cancel'].includes(body.operation))fail('invalid_job_operation');
          if(chatgpt&&!canManageChatGPT&&['resume','retry'].includes(body.operation)){
            const current=await db.getSettings();if(current.aiProvider==='chatgpt_plan'&&current.aiEnabled)fail('chatgpt_owner_required',403);
          }
          return reply(200,{ok:true,job:await db.controlJob(identifier(body.jobId),body.operation)});
        }
        case 'settings':{
          const current={...structuredClone(DEFAULT_SETTINGS),...await db.getSettings()};
          if((body.settings?.aiProvider==='chatgpt_plan'||current.aiProvider==='chatgpt_plan')&&!canManageChatGPT)fail('chatgpt_owner_required',403);
          const settings=validateSettings(body.settings,{current,models:policy.models,chatgptModels:chatgptInfo.models.map(m=>m.id),chatgptAvailable:chatgptInfo.planUsageEnabled&&canManageChatGPT,maxDailyPlanRequests:capabilities.maxDailyPlanRequests,aiAvailable:capabilities.aiAvailable,maxDailyBudgetUsd:capabilities.maxDailyBudgetUsd,maxCompanyBudgetUsd:capabilities.maxCompanyBudgetUsd});
          if(settings.aiEnabled&&settings.aiProvider==='chatgpt_plan')await chatgpt.provider.clearUsageBlock?.();
          return reply(200,{ok:true,settings:await db.saveSettings(settings)});
        }
        case 'materials':{
          if(!Number.isInteger(body.revision)||body.revision<0)fail('invalid_revision');
          return reply(200,{ok:true,lead:await db.saveMaterials(identifier(body.projectId),body.revision,validateMaterials(body.materials))});
        }
        case 'policy':{
          const patch={};
          for(const [key,target] of [['excluded','excluded'],['optedOut','opted_out']])if(Object.hasOwn(body,key)){if(typeof body[key]!=='boolean')fail('invalid_policy');patch[target]=body[key];}
          if(Object.hasOwn(body,'contactPermission')){
            const p=body.contactPermission;
            if(p!==null&&(!p||typeof p!=='object'||Object.keys(p).some(k=>!['basis','recordedAt','note'].includes(k))||!['consent','customer_request','manual_review'].includes(p.basis)||typeof p.note!=='string'||p.note.length>1000||typeof p.recordedAt!=='string'||Number.isNaN(Date.parse(p.recordedAt))||Date.parse(p.recordedAt)>now()+60000))fail('invalid_contact_permission');
            patch.contact_permission=p;
          }
          if(body.optedOut===false&&(!patch.contact_permission||patch.contact_permission.basis==='manual_review'||!patch.contact_permission.note.trim()))fail('renewed_permission_required');
          if(!Object.keys(patch).length)fail('invalid_policy');
          return reply(200,{ok:true,lead:await db.savePolicy(identifier(body.projectId),patch)});
        }
        case 'reply':{
          const result=classifyReply(body.text,now());return reply(200,{ok:true,reply:await db.addReply(identifier(body.projectId),result)});
        }
        case 'purge':await db.purge(identifier(body.projectId));return reply(200,{ok:true,deleted:true});
        default:fail('unknown_action');
      }
    }catch(error){const code=publicCode(error),status=responseStatus(error,code);if(status>=500||status===429)try{notice({code,component:'lead_api'});}catch{}return reply(status,{ok:false,error:code});}
  };
}
