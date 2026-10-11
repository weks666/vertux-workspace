# AI Lead Intelligence — integration contract

Implementation baseline: Workspace commit 6daa17e. The owner authorized production publication on 2026-10-10 and chose a personal ChatGPT plan instead of a separate paid API. No external communication is implemented. Deployment and account acceptance are recorded separately in release evidence.

## Boundary

Node 24 server in lead-server/, Supabase/Postgres persistent data and queue. Reuse fresh server-side app_metadata authorization from trainer-server. Every operation is bound to the configured product/organization and existing projects. Service-role stays server-side. Browser calls POST /webhook/vertux-lead-intelligence with its existing product Supabase bearer token, exact Origin, JSON body {action,...}. GET is not used. All responses {ok:true,...} or {ok:false,error:code}.

## Browser actions

- chatgpt_status -> {chatgpt:{available,connected,planUsageEnabled,canManage,accountLabel,models:[{id,label}],requiresLocalConnection,requiresLocalSetup,setupInstruction}}. Only the configured, currently active owner sees account details. First login uses the protected local helper, not a public OAuth route.
- chatgpt_disconnect -> {remoteRevoked,chatgpt}; owner only, pauses AI before clearing credentials. The UI warns when remote revocation was not confirmed.

- overview -> {settings,leads,jobs,events,usage,analytics,capabilities}. leads are intelligence records keyed by project_id; merge into existing CRM companies. Jobs/events bounded to latest 100.
- detail {projectId} -> {lead, jobs, events, replies}. lead includes project_id,status,quick,deep,score,materials,materials_revision,checked_at,expires_at,excluded,opted_out,contact_permission.
- enqueue {projectId,kind:'quick'|'deep',force?:boolean} -> {job}; deep is allowed for every company independent of score, subject to budgets.
- job {jobId,operation:'pause'|'resume'|'retry'|'cancel'} -> {job}.
- settings {settings:partial} -> {settings}; owner/admin, but personal-plan configuration and enabled-plan changes require the exact configured active owner. Manual Deep with the personal plan and resume/retry with enabled plan AI have the same owner gate.
- materials {projectId,revision,materials:{summary,proposal,callScript,emailSubject,emailBody,icebreaker,followUps}} -> {lead}; optimistic revision, all string fields except followUps:string[].
- policy {projectId,excluded?,optedOut?,contactPermission?:{basis,recordedAt,note}} -> {lead}.
- reply {projectId,text} -> {reply:{classification,suggestedReply,nextAction,...}}; no outbound delivery.
- purge {projectId} -> {deleted:true}; owner/admin only, removes research/materials/replies and queued jobs; CRM company remains.

## Research contract

researchCompany(project,{kind,settings,previous,signal}) -> {schemaVersion:1,kind,status,checkedAt,expiresAt,officialSite:{url,status,confidence,reason},business:{industry,description,services,audience},pages:[],signals:[],opportunities:[],limitations:[],technologies:[],technical:{},score:{total,priority,components,reasons,services},usage:{httpRequests,browserPages}}. Each signal/opportunity has id,label,evidence:[{url,quote,checkedAt,confidence}],confidence and explicitly marked hypothesis where applicable. Pages include url,title,text,contentHash,checkedAt. No raw executable HTML is returned to UI. No unproven negative claims.

## Store contract

createLeadStore({supabaseUrl,serviceKey,organizationId,productId,fetcher}) in lead-server/store.mjs. RPC service-only, scoped in SQL. Methods async: getSettings(), saveSettings(patch), overview(), detail(projectId), getProject(projectId), enqueue(projectId,kind,{force,priority,manual}), controlJob(jobId,operation), claim(workerId), heartbeat(jobId,workerId,progress), complete(jobId,workerId,result), fail(jobId,workerId,code), saveMaterials(projectId,revision,materials), savePolicy(projectId,patch), addReply(projectId,reply), purge(projectId), schedule(), reserveUsage({requestId,projectId,jobId,costNanos,inputTokens,outputTokens,model}), settleUsage(requestId,{costNanos,inputTokens,outputTokens,state}). claim returns job or null including worker_id lease, project and previous (existing lead). claim enforces enabled/pause/concurrency and 500/50 configurable daily counts. complete stores result research, score, optional materials atomically with job completion. stale lease recoverable, stale completions fenced, retries bounded, import trigger idempotent. schedule enqueues due/stale research and top-scored deep at local configured time, persist last run date. Jobs: id,project_id,kind,status,priority,attempts,progress,error_code,next_run_at,lease_until. Usage: integer USD nanounits; reservations survive ambiguous failure/restart and consume daily/company ceilings. Scope fields on all operational rows. Typed settings validation in service and SQL defensive bounds.

## Settings (JSON keys)

enabled:true,paused:false,autoQuick:true,autoDeep:true,dailyQuick:500,dailyDeep:50,deepThreshold:60,scheduleTime:'09:00',timezone:'Europe/Moscow',staleDays:30,concurrency:2,maxAttempts:3,maxPagesQuick:2,maxPagesDeep:6,requestTimeoutMs:12000,requestsPerHostDelayMs:1000,aiEnabled:false,quickModel:'openai/gpt-4.1-mini',deepModel:'openai/gpt-4.1-mini',dailyBudgetUsd:0,companyBudgetUsd:0,maxInputTokens:12000,maxOutputTokens:1800,industryProfiles:['hotel','restaurant','banquet','general'],scoreWeights:{fit:25,opportunity:30,contacts:20,freshness:10,confidence:15},communication:{mode:'drafts',dailySendLimit:0}.

## Acceptance

Personal-plan settings additionally include `aiProvider:'chatgpt_plan'` and `dailyPlanRequests:10` (server ceiling 10 for this personal deployment). ChatGPT model IDs must come from the connected account catalog. `reserveUsage` accepts `provider:'chatgpt_plan',kind:'plan',dailyPlanCap` and counts reserved/uncertain/settled requests durably; actual USD cost is unknown/not applicable and never shown as free AI. Internal zero nanounits are only a non-monetary ledger placeholder. `suspendAI` changes only AI enabled state and records a safe event on subscription-limit failure. It does not replace concurrent settings edits. There is no provider fallback.

Isolated SQL migration/roles/import/job/budget tests, HTTP research fixtures (SSRF/robots/redirect/size/JS/unavailable), provider and evidence validation, real local server pipeline through persistence, UI desktop/mobile keyboard/reduced motion/errors, existing import/trainer/finance/Nexus regression suites. Production migration and paid provider acceptance remain explicit release steps.

## Personal AI host

With both `LEAD_CHATGPT_REMOTE_URL` and `LEAD_CHATGPT_REMOTE_KEY` configured, the main runtime creates only a remote personal-provider adapter and no local OAuth listener or credential store. The fixed HTTPS destination is `https://zxcqweksn8n.duckdns.org/webhook/vertux-lead-chatgpt`; verified TLS, no redirects/retries/local fallback. The dedicated host has a private caller key plus nginx source-IP restriction, bounded request body, fixed analysis instructions, catalog-selected models, concurrency one, a durable daily request ledger and pause. The same `analysisRequestId(job.id)` crosses both ledgers; uncertain inference cannot be sent twice even when a response is lost. The host starts paused and only explicit owner enable/resume lifts that pause. Disconnect pauses before revoking credentials. AI host failure is reflected in capabilities without preventing ordinary overview/detail actions. Credentials and caller keys are excluded from HTTP status, logs, evidence and frontend assets.
