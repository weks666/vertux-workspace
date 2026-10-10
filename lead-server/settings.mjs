import {fail} from './errors.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled:true, paused:false, autoQuick:true, autoDeep:true, dailyQuick:500, dailyDeep:50,
  deepThreshold:60, scheduleTime:'09:00', timezone:'Europe/Moscow', staleDays:30, retentionDays:90,
  concurrency:2, maxAttempts:3, maxPagesQuick:2, maxPagesDeep:6, requestTimeoutMs:12000,
  requestsPerHostDelayMs:1000, aiEnabled:false, aiProvider:'openrouter', dailyPlanRequests:10, quickModel:'openai/gpt-4.1-mini',
  deepModel:'openai/gpt-4.1-mini', dailyBudgetUsd:0, companyBudgetUsd:0,
  maxInputTokens:12000, maxOutputTokens:1800,
  industryProfiles:['hotel','restaurant','banquet','general'],
  scoreWeights:{fit:25,opportunity:30,contacts:20,freshness:10,confidence:15},
  communication:{mode:'drafts',dailySendLimit:0}
});
const integers={dailyQuick:[0,10000],dailyDeep:[0,1000],dailyPlanRequests:[1,50],deepThreshold:[0,100],staleDays:[1,365],retentionDays:[7,365],concurrency:[1,6],maxAttempts:[1,5],maxPagesQuick:[1,4],maxPagesDeep:[1,12],requestTimeoutMs:[2000,30000],requestsPerHostDelayMs:[500,30000],maxInputTokens:[3000,32000],maxOutputTokens:[300,4000]};
const booleans=new Set(['enabled','paused','autoQuick','autoDeep','aiEnabled']);
export function validateSettings(patch,{current=DEFAULT_SETTINGS,models=['openai/gpt-4.1-mini'],chatgptModels=[],chatgptAvailable=false,maxDailyPlanRequests=50,aiAvailable=false,maxDailyBudgetUsd=0,maxCompanyBudgetUsd=0}={}) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch))fail('invalid_settings');
  const result=structuredClone(current);
  for(const [key,value] of Object.entries(patch)) {
    if(!Object.hasOwn(DEFAULT_SETTINGS,key))fail('unknown_setting');
    if(booleans.has(key)){if(typeof value!=='boolean')fail('invalid_settings');}
    else if(integers[key]){const [low,high]=integers[key];if(!Number.isInteger(value)||value<low||value>high)fail('invalid_settings');if(key==='dailyPlanRequests'&&value>maxDailyPlanRequests)fail('plan_quota_above_server_limit');}
    else if(key==='aiProvider'){if(!['openrouter','chatgpt_plan'].includes(value))fail('invalid_ai_provider');}
    else if(['dailyBudgetUsd','companyBudgetUsd'].includes(key)) {
      const cap=key==='dailyBudgetUsd'?maxDailyBudgetUsd:maxCompanyBudgetUsd;
      if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>cap||Math.round(value*1e6)!==value*1e6)fail('budget_above_server_limit');
    } else if(key==='scheduleTime'){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail('invalid_schedule');}
    else if(key==='timezone'){try{if(typeof value!=='string'||value.length>80)throw Error();new Intl.DateTimeFormat('en',{timeZone:value}).format();}catch{fail('invalid_timezone');}}
    else if(['quickModel','deepModel'].includes(key)){if(typeof value!=='string'||!([...models,...chatgptModels].includes(value)||value===current[key]))fail('model_not_allowed');}
    else if(key==='industryProfiles'){if(!Array.isArray(value)||!value.length||value.length>4||new Set(value).size!==value.length||value.some(x=>!['hotel','restaurant','banquet','general'].includes(x)))fail('invalid_industry_profiles');}
    else if(key==='scoreWeights'){
      const keys=Object.keys(DEFAULT_SETTINGS.scoreWeights);
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Number.isInteger(value[k])||value[k]<0||value[k]>100)||keys.reduce((sum,k)=>sum+value[k],0)!==100)fail('invalid_score_weights');
    } else if(key==='communication') {
      if(!value||Object.keys(value).some(k=>!['mode','dailySendLimit'].includes(k))||value.mode!=='drafts'||value.dailySendLimit!==0)fail('delivery_not_connected');
    }
    result[key]=structuredClone(value);
  }
  if(result.maxPagesQuick>result.maxPagesDeep)fail('invalid_page_limits');
  if(result.companyBudgetUsd>result.dailyBudgetUsd)fail('company_budget_above_daily');
  if(result.aiEnabled&&result.aiProvider==='openrouter'&&(!aiAvailable||!models.includes(result.deepModel)||result.dailyBudgetUsd<=0||result.companyBudgetUsd<=0))fail('ai_budget_not_configured');
  if(result.aiEnabled&&result.aiProvider==='chatgpt_plan'&&(!chatgptAvailable||!chatgptModels.includes(result.deepModel)))fail('chatgpt_connection_required');
  return result;
}

export function validateMaterials(value) {
  const limits={summary:6000,proposal:6000,callScript:8000,emailSubject:200,emailBody:6000,icebreaker:1200};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(limits,k)&&k!=='followUps'))fail('invalid_materials');
  const result={};
  for(const [key,max] of Object.entries(limits)){
    if(typeof value[key]!=='string'||value[key].length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value[key]))fail('invalid_materials');
    result[key]=value[key].trim();
  }
  if(!Array.isArray(value.followUps)||value.followUps.length>3||value.followUps.some(s=>typeof s!=='string'||s.length>3000))fail('invalid_materials');
  result.followUps=value.followUps.map(s=>s.trim());
  return result;
}
