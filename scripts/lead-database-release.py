"""Bounded Workspace Lead Intelligence database release.

Default: root-only host backup, isolated PG restore/migration/RLS/concurrency/
rollback rehearsal. --preflight is read-only. --apply requires the exact local
and server rehearsal receipt, unchanged candidate and unchanged source snapshot.
No row contents, credentials or backups are downloaded. No production rollback
is automatic: once real lead data exists, rollback is a separate operator action.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = {
    "migration": "supabase/migrations/20261010004715_workspace_lead_intelligence.sql",
    "rollback": "supabase/rollback/lead-intelligence.sql",
    "leadTests": "supabase/tests/lead_intelligence.sql",
    "financeTests": "supabase/tests/finance_isolation.sql",
}
REMOTE = r'''
import concurrent.futures,datetime,hashlib,json,os,pathlib,re,subprocess,sys,threading,uuid
os.umask(0o077)
p=PAYLOAD
CONTAINER='supabase-db'
SOURCE='postgres'
PREFIX='workspace_lead_release_test_'
BACKUPS=pathlib.Path('/var/backups/vertux-workspace/lead-intelligence')
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
stage='preflight'

class GateError(Exception): pass
def require(condition,code):
    if not condition: raise GateError(code)
def run(argv,body=None,timeout=120):
    try: r=subprocess.run(argv,input=body,capture_output=True,timeout=timeout)
    except subprocess.TimeoutExpired: raise GateError('database_command_timeout') from None
    if r.returncode:
        # PostgreSQL VERBOSITY=sqlstate avoids values/SQL excerpts in diagnostics.
        code=re.search(rb'(?:ERROR|FATAL):\s+([A-Z0-9]{5})\b',r.stderr)
        raise GateError('database_command_failed'+(':'+code.group(1).decode() if code else ''))
    return r.stdout
def sql(text,database=SOURCE):
    require(database==SOURCE or re.fullmatch(PREFIX+r'[a-z0-9_]+',database),'invalid_database_name')
    return run(['docker','exec','-i',CONTAINER,'psql','-U','postgres','-d',database,'-XAtq','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],
      ("SET TIME ZONE 'UTC'; SET search_path=pg_catalog,public; SET lock_timeout='15s'; SET statement_timeout='90s';\n"+text).encode()).decode().strip()
def isolated_sql(text,database):
    require(database!=SOURCE and database.startswith(PREFIX),'refusing_fixture_outside_isolated_database')
    return sql(text,database)
def literal(value): return "'"+str(value).replace("'","''")+"'"
def digest(value): return hashlib.sha256(value).hexdigest()
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def private_dir(path):
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    s=path.stat(); require(s.st_uid==0 and s.st_mode&0o077==0,'backup_directory_permissions_unsafe')
def write_private(path,data):
    require(path.parent.resolve().is_relative_to(BACKUPS.resolve()),'backup_path_outside_root')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f: f.write(data)
def table_hash(table,key):
    return "SELECT md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY "+key+"),'')) FROM "+table+" t"

# Whitelisted identity fields contain no email, name, password, token or key.
identity_rows="""SELECT u.id,u.deleted_at,u.banned_until,jsonb_build_object(
 'role',u.raw_app_meta_data->'role','nexus_managed',u.raw_app_meta_data->'nexus_managed',
 'nexus_access',u.raw_app_meta_data->'nexus_access','nexus_organization_id',u.raw_app_meta_data->'nexus_organization_id',
 'nexus_product_id',u.raw_app_meta_data->'nexus_product_id') AS raw_app_meta_data
 FROM auth.users u CROSS JOIN workspace_private.scope s
 WHERE u.raw_app_meta_data->>'nexus_organization_id'=s.organization_id::text
   AND u.raw_app_meta_data->>'nexus_product_id'=s.product_id::text"""
identity_hash="SELECT md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),'')) FROM ("+identity_rows+") t"

def schema_hash(contract=False):
    # Contract mode allowlists only this migration's additive lead trigger/scope
    # key and read grants to the already privileged service_role. Client grants,
    # policies, original functions, table layout and finance remain exact.
    table_grant_filter="AND NOT (x.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role') AND x.grantor=c.relowner AND x.privilege_type='SELECT' AND NOT x.is_grantable AND c.oid IN ('public.projects'::regclass,'workspace_private.scope'::regclass))" if contract else ''
    schema_grant_filter="AND NOT (x.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role') AND x.grantor=n.nspowner AND x.privilege_type='USAGE' AND NOT x.is_grantable)" if contract else ''
    constraint_filter="AND conname<>'lead_scope_unique'" if contract else ''
    index_filter="AND ic.relname<>'lead_scope_unique'" if contract else ''
    trigger_filter="AND tgname<>'workspace_lead_project_changed'" if contract else ''
    query="""SELECT md5(jsonb_build_object('tables',(SELECT jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
      'acl',(SELECT jsonb_agg(jsonb_build_array(x.grantor,x.grantee,x.privilege_type,x.is_grantable) ORDER BY x.grantor,x.grantee,x.privilege_type,x.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x WHERE true TABLE_GRANT_FILTER),
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid CONSTRAINT_FILTER),
      'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid INDEX_FILTER),
      'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal TRIGGER_FILTER),
      'policies',(SELECT jsonb_agg(jsonb_build_array(polname,polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)) ORDER BY polname) FROM pg_policy WHERE polrelid=c.oid)
    ) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid IN ('public.projects'::regclass,'public.workspace_project_finance'::regclass,'workspace_private.scope'::regclass)),
    'privateSchema',(SELECT jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',(SELECT jsonb_agg(jsonb_build_array(x.grantor,x.grantee,x.privilege_type,x.is_grantable) ORDER BY x.grantor,x.grantee,x.privilege_type,x.is_grantable) FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x WHERE true SCHEMA_GRANT_FILTER)) FROM pg_namespace n WHERE n.nspname='workspace_private'),
    'roleFunction',(SELECT jsonb_build_object('definition',pg_get_functiondef(f.oid),'owner',pg_get_userbyid(f.proowner),'acl',(SELECT jsonb_agg(jsonb_build_array(x.grantor,x.grantee,x.privilege_type,x.is_grantable) ORDER BY x.grantor,x.grantee,x.privilege_type,x.is_grantable) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) x)) FROM pg_proc f WHERE f.oid='workspace_private.current_role()'::regprocedure)
    )::text)"""
    return query.replace('TABLE_GRANT_FILTER',table_grant_filter).replace('SCHEMA_GRANT_FILTER',schema_grant_filter).replace('CONSTRAINT_FILTER',constraint_filter).replace('INDEX_FILTER',index_filter).replace('TRIGGER_FILTER',trigger_filter)

fingerprints_sql={
 'projects':table_hash('public.projects','id'),
 'finance':table_hash('public.workspace_project_finance','project_id'),
 'scope':table_hash('workspace_private.scope','singleton'),
 'identities':identity_hash,
 'schema':schema_hash(),
 'crmSecurityContract':schema_hash(True),
 'authHelpers':"SELECT md5(string_agg(pg_get_functiondef(oid),E'\\n' ORDER BY proname)) FROM pg_proc WHERE oid IN ('auth.uid()'::regprocedure,'auth.jwt()'::regprocedure)"
}
def fingerprint(database=SOURCE):
    return json.loads(sql('SELECT json_build_object('+','.join(literal(k)+',('+v+')' for k,v in fingerprints_sql.items())+')',database))
def preflight():
    q="""SELECT json_build_object('serverVersion',current_setting('server_version'),
      'scope',(SELECT json_agg(json_build_object('organizationId',organization_id,'productId',product_id)) FROM workspace_private.scope),
      'leadPresent',to_regclass('public.workspace_lead_settings') IS NOT NULL,
      'projectRows',(SELECT count(*) FROM public.projects),'financeRows',(SELECT count(*) FROM public.workspace_project_finance),
      'userTriggers',(SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('public.projects'::regclass,'public.workspace_project_finance'::regclass,'workspace_private.scope'::regclass) AND NOT tgisinternal),
      'unexpectedForeignKeys',(SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid IN ('public.projects'::regclass,'public.workspace_project_finance'::regclass,'workspace_private.scope'::regclass) AND confrelid NOT IN ('public.projects'::regclass,'public.workspace_project_finance'::regclass,'workspace_private.scope'::regclass)),
      'privateTables',(SELECT json_agg(c.relname ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='workspace_private' AND c.relkind IN ('r','p','v','m','f')),
      'privateFunctions',(SELECT json_agg(proname ORDER BY proname) FROM pg_proc WHERE pronamespace='workspace_private'::regnamespace),
      'ownerCandidates',(SELECT coalesce(json_agg(json_build_object('id',u.id,'role',u.raw_app_meta_data->>'role') ORDER BY u.id),'[]') FROM auth.users u CROSS JOIN workspace_private.scope s WHERE u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now()) AND u.raw_app_meta_data->>'nexus_managed'='true' AND u.raw_app_meta_data->>'nexus_access'='active' AND u.raw_app_meta_data->>'role'='owner' AND u.raw_app_meta_data->>'nexus_organization_id'=s.organization_id::text AND u.raw_app_meta_data->>'nexus_product_id'=s.product_id::text))"""
    meta=json.loads(sql(q))
    require(meta['serverVersion'].startswith('17.6'),'unexpected_postgres_version')
    require(len(meta['scope'] or [])==1,'workspace_scope_not_singleton')
    for value in meta['scope'][0].values(): uuid.UUID(value)
    require(not meta['leadPresent'],'lead_migration_already_present')
    require(meta['userTriggers']==0,'existing_user_trigger_requires_restore_review')
    require(meta['unexpectedForeignKeys']==0,'unexpected_cross_table_dependency')
    require(meta['privateTables']==['scope'] and meta['privateFunctions']==['current_role'],'unexpected_private_schema_objects')
    return meta,fingerprint()

def rpc(action,payload,database,scope):
    body='BEGIN; SET LOCAL ROLE service_role; SELECT public.workspace_lead_rpc('+literal(scope['organizationId'])+'::uuid,'+literal(scope['productId'])+'::uuid,'+literal(action)+','+literal(json.dumps(payload))+'::jsonb); COMMIT;'
    return json.loads(isolated_sql(body,database))

def concurrency_tests(database,scope):
    global stage
    ids=[str(uuid.uuid4()) for _ in range(4)]
    stage='isolated_concurrency_settings'
    rpc('save_settings',{'settings':{'autoQuick':False,'autoDeep':False,'aiProvider':'chatgpt_plan','aiEnabled':True,'dailyPlanRequests':1,'dailyBudgetUsd':0,'companyBudgetUsd':0,'concurrency':2}},database,scope)
    stage='isolated_concurrency_fixtures'
    isolated_sql('INSERT INTO public.projects(id,company,raw) VALUES '+','.join('('+literal(v)+'::uuid,'+literal('ISOLATED LEAD RELEASE FIXTURE '+v)+',\'{}\'::jsonb)' for v in ids),database)
    stage='isolated_concurrency_probe'
    isolated_sql("""CREATE FUNCTION workspace_private.lead_release_probe(action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $f$
      DECLARE v jsonb; s workspace_private.scope;
      BEGIN SELECT * INTO s FROM workspace_private.scope;
        v:=public.workspace_lead_rpc(s.organization_id,s.product_id,action,payload);
        RETURN jsonb_build_object('accepted',true,'value',v);
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM IN ('plan_quota_exceeded','budget_exceeded','stale_lease','idempotency_conflict') THEN RETURN jsonb_build_object('accepted',false,'code',SQLERRM); END IF;
        RAISE;
      END $f$;
      REVOKE ALL ON FUNCTION workspace_private.lead_release_probe(text,jsonb) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION workspace_private.lead_release_probe(text,jsonb) TO service_role;""",database)
    def simultaneous(action,payloads):
        barrier=threading.Barrier(len(payloads))
        def call(payload):
            barrier.wait(timeout=10)
            q="BEGIN; SET LOCAL ROLE service_role; SELECT pg_sleep(0.3); SELECT jsonb_build_object('pid',pg_backend_pid(),'probe',workspace_private.lead_release_probe("+literal(action)+','+literal(json.dumps(payload))+"::jsonb)); COMMIT;"
            return json.loads(isolated_sql(q,database))
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(payloads)) as pool: rows=list(pool.map(call,payloads))
        require(len(set(r['pid'] for r in rows))==len(payloads),'concurrency_connections_not_distinct')
        return [r['probe'] for r in rows]
    plan=[{'requestId':'release-plan-'+str(i),'projectId':ids[i%4],'provider':'chatgpt_plan','kind':'plan','costNanos':0,'inputTokens':100,'outputTokens':20,'model':'isolated-plan-fixture','dailyPlanCap':1} for i in range(6)]
    stage='isolated_plan_quota_race'
    outcomes=simultaneous('reserve_usage',plan)
    accepted=[r for r in outcomes if r['accepted']]
    require(len(accepted)==1 and all(r['accepted'] or r['code']=='plan_quota_exceeded' for r in outcomes),'plan_concurrency_quota_failed')
    held=accepted[0]['value']; winner=next(v for v in plan if v['requestId']==held['request_id'])
    stage='isolated_plan_uncertainty'
    rpc('settle_usage',{'requestId':held['request_id'],'state':'uncertain'},database,scope)
    require(rpc('reserve_usage',winner,database,scope)['duplicate'],'plan_reservation_duplicate_not_fenced')
    settings=rpc('get_settings',{},database,scope)
    stage='isolated_plan_pause'
    require(rpc('suspend_ai',{'code':'usage_limit_exceeded'},database,scope)=={**settings,'aiEnabled':False},'plan_suspend_changed_other_settings')
    rpc('save_settings',{'settings':{'aiProvider':'openrouter','aiEnabled':True,'dailyBudgetUsd':1,'companyBudgetUsd':1}},database,scope)
    api=[{'requestId':'release-api-'+str(i),'projectId':ids[i%4],'provider':'openrouter','kind':'api','costNanos':600000000,'inputTokens':100,'outputTokens':20,'model':'isolated-api-fixture'} for i in range(6)]
    stage='isolated_api_budget_race'
    outcomes=simultaneous('reserve_usage',api)
    require(sum(r['accepted'] for r in outcomes)==1 and all(r['accepted'] or r['code']=='budget_exceeded' for r in outcomes),'api_concurrency_budget_failed')
    for value in ids: rpc('enqueue',{'projectId':value,'kind':'quick','manual':True},database,scope)
    stage='isolated_queue_claim_race'
    jobs=simultaneous('claim',[{'workerId':'release-worker-'+str(i)} for i in range(6)])
    claimed=[r['value'] for r in jobs if r['accepted'] and r['value'] is not None]
    require(len(claimed)==2 and len(set(j['project_id'] for j in claimed))==2,'queue_concurrency_cap_failed')
    first=claimed[0]
    stage='isolated_cancel_fence'
    rpc('control_job',{'jobId':first['id'],'operation':'cancel'},database,scope)
    fenced=json.loads(isolated_sql('BEGIN; SET LOCAL ROLE service_role; SELECT workspace_private.lead_release_probe(\'heartbeat\','+literal(json.dumps({'jobId':first['id'],'workerId':first['worker_id'],'progress':{}}))+'::jsonb); COMMIT;',database))
    require(not fenced['accepted'] and fenced['code']=='stale_lease','cancelled_worker_not_fenced')
    require(rpc('detail',{'projectId':first['project_id']},database,scope)['lead']['status']=='cancelled','cancelled_lead_status_incorrect')
    stage='isolated_fixture_cleanup'
    isolated_sql('DROP FUNCTION workspace_private.lead_release_probe(text,jsonb); DELETE FROM public.projects WHERE id IN ('+','.join(literal(v)+'::uuid' for v in ids)+');',database)
    return {'connectionsPerRace':6,'planAccepted':1,'apiAccepted':1,'maxRunning':2,'cancelFenceVerified':True,'persistentPlanPauseVerified':True}

def without_transaction(text):
    require(len(re.findall(r'(?m)^BEGIN;\s*$',text))==1 and text.rstrip().endswith('COMMIT;'),'unexpected_migration_transaction_wrapper')
    return re.sub(r'(?m)^BEGIN;\s*\n','',text,count=1).rstrip()[:-len('COMMIT;')]
def apply_guard(before):
    checks=['IF ('+query+') IS DISTINCT FROM '+literal(before[name])+" THEN RAISE EXCEPTION 'release_source_changed'; END IF;" for name,query in fingerprints_sql.items()]
    return 'DO $guard$ BEGIN '+''.join(checks)+' END $guard$;'

def main():
    global stage
    require(os.geteuid()==0,'remote_root_required')
    meta,before=preflight(); scope=meta['scope'][0]
    safe={'host':p['host'],'database':SOURCE,'serverVersion':meta['serverVersion'],**scope,'ownerCandidates':meta['ownerCandidates'],'projectRows':meta['projectRows'],'financeRows':meta['financeRows']}
    if p['mode']=='preflight': return {**safe,'status':'PREFLIGHT_VERIFIED','sourceFingerprints':before,'productionWrites':False}
    private_dir(BACKUPS)
    receipt_path=BACKUPS/'rehearsal.json'
    if p['mode']=='apply':
        stage='apply_guard'
        require(receipt_path.exists(),'successful_rehearsal_required')
        require(receipt_path.stat().st_uid==0 and receipt_path.stat().st_mode&0o077==0,'rehearsal_receipt_permissions_unsafe')
        receipt_bytes=receipt_path.read_bytes(); prior=json.loads(receipt_bytes)
        require(digest(receipt_bytes)==p.get('approvedReceiptSha256'),'approved_receipt_changed')
        require(prior.get('status')=='RESTORE_AND_ROLLBACK_VERIFIED' and prior.get('restoreVerified') and prior.get('rollbackVerified') and prior.get('concurrencyVerified'),'successful_rehearsal_required')
        require(prior['bundleSha256']==p['bundleSha256'] and prior['artifactHashes']==p['artifactHashes'],'candidate_changed_after_rehearsal')
        require(prior['sourceFingerprints']==before and prior['host']==p['host'],'source_changed_after_rehearsal')
        require(not list(BACKUPS.glob('applied-'+prior['receiptId']+'.json')),'receipt_already_applied')
        for name,value in prior['backupHashes'].items():
            path=pathlib.Path(prior['backupPath'])/name
            require(path.resolve().is_relative_to(BACKUPS.resolve()) and digest(path.read_bytes())==value,'rehearsal_backup_changed')
        body="BEGIN; SET LOCAL lock_timeout='15s'; LOCK TABLE public.projects,public.workspace_project_finance,workspace_private.scope IN ACCESS EXCLUSIVE MODE; "+apply_guard(before)+without_transaction(p['migration'])+' COMMIT;'
        stage='production_migration'
        sql(body)
        stage='production_postcheck'
        after=fingerprint()
        require(all(after[k]==before[k] for k in ('projects','finance','scope','identities','crmSecurityContract','authHelpers')),'post_migration_invariant_changed_manual_attention_required')
        sql(p['leadTests'])
        require(sql("SELECT count(*) FROM public.workspace_lead_settings WHERE config->>'aiEnabled'='false'")=='1','unexpected_ai_enablement')
        result={**prior,'status':'SERVER_MIGRATED','appliedAt':stamp,'productionWrites':True,'productionRollbackAutomatic':False,'postMigrationFingerprints':after}
        write_private(BACKUPS/('applied-'+prior['receiptId']+'.json'),canonical(result)); return result
    stage='backup'
    receipt_id=stamp.lower()+'_'+uuid.uuid4().hex[:8]
    backup=BACKUPS/receipt_id; private_dir(backup)
    private_dump=run(['docker','exec',CONTAINER,'pg_dump','-U','postgres','-d',SOURCE,'--format=custom','--strict-names','--schema=workspace_private'])
    crm_dump=run(['docker','exec',CONTAINER,'pg_dump','-U','postgres','-d',SOURCE,'--format=custom','--strict-names','--table=public.projects','--table=public.workspace_project_finance'])
    identities=sql('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),\'[]\'::jsonb) FROM ('+identity_rows+') t').encode()
    auth_helpers=sql("SELECT string_agg(pg_get_functiondef(oid)||';',E'\\n' ORDER BY proname) FROM pg_proc WHERE oid IN ('auth.uid()'::regprocedure,'auth.jwt()'::regprocedure)").encode()
    backup_data={'workspace-private.dump':private_dump,'workspace-crm.dump':crm_dump,'auth-minimal-identities.json':identities,'auth-helpers.sql':auth_helpers,'migration.sql':p['migration'].encode(),'rollback.sql':p['rollback'].encode()}
    for name,data in backup_data.items(): write_private(backup/name,data)
    require(fingerprint()==before,'source_changed_during_backup')
    database=PREFIX+receipt_id
    created=False; success=None
    try:
        stage='isolated_restore'
        require(database.startswith(PREFIX) and len(database)<=63,'invalid_isolated_name')
        run(['docker','exec',CONTAINER,'createdb','-U','postgres','--template=template0',database]); created=True
        stage='isolated_auth_schema'
        isolated_sql('REVOKE ALL ON DATABASE '+database+' FROM PUBLIC; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb,deleted_at timestamptz,banned_until timestamptz);',database)
        stage='isolated_auth_helpers'
        isolated_sql(auth_helpers.decode()+' GRANT USAGE ON SCHEMA auth TO authenticated,anon,service_role;',database)
        stage='isolated_auth_identities'
        isolated_sql('INSERT INTO auth.users(id,raw_app_meta_data,deleted_at,banned_until) SELECT id,raw_app_meta_data,deleted_at,banned_until FROM jsonb_to_recordset('+literal(identities.decode())+'::jsonb) AS x(id uuid,raw_app_meta_data jsonb,deleted_at timestamptz,banned_until timestamptz);',database)
        stage='isolated_table_restore'
        for dump in (private_dump,crm_dump): run(['docker','exec','-i',CONTAINER,'pg_restore','-U','postgres','-d',database,'--exit-on-error','--single-transaction'],dump)
        stage='isolated_fingerprints'
        require(fingerprint(database)==before,'restored_snapshot_differs')
        stage='isolated_migration'
        isolated_sql(p['migration'],database)
        migrated=fingerprint(database)
        require(all(migrated[k]==before[k] for k in ('projects','finance','scope','identities','crmSecurityContract','authHelpers')),'migration_changed_crm_or_finance')
        stage='isolated_role_tests'
        isolated_sql(p['leadTests'],database)
        old_guard="current_database() NOT LIKE 'workspace_release_test_%'"
        require(p['financeTests'].count(old_guard)==1,'finance_fixture_guard_changed')
        finance_tests=p['financeTests'].replace(old_guard,'current_database() IS DISTINCT FROM '+literal(database))
        isolated_sql(finance_tests,database)
        stage='isolated_concurrency'
        concurrent=concurrency_tests(database,scope)
        require(all(fingerprint(database)[k]==before[k] for k in ('projects','finance','scope','identities','crmSecurityContract','authHelpers')),'fixtures_changed_original_records')
        stage='isolated_rollback'
        isolated_sql(p['rollback'],database)
        restored=fingerprint(database)
        require(all(restored[k]==before[k] for k in ('projects','finance','scope','identities','crmSecurityContract','authHelpers')),'rollback_changed_crm_or_finance')
        require(isolated_sql("SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'workspace_lead_%'",database)=='0','rollback_left_lead_tables')
        require(fingerprint()==before,'production_changed_during_rehearsal')
        success={**safe,'receiptId':receipt_id,'checkedAt':stamp,'status':'RESTORE_AND_ROLLBACK_VERIFIED','restoreVerified':True,'rollbackVerified':True,'roleMatrixVerified':True,'concurrencyVerified':True,'concurrency':concurrent,'sourceFingerprints':before,'migrationSha256':p['artifactHashes']['migration'],'bundleSha256':p['bundleSha256'],'artifactHashes':p['artifactHashes'],'backupPath':str(backup),'backupHashes':{name:digest(data) for name,data in backup_data.items()},'productionWrites':False,'backupContentsDownloaded':False,'authFields':'id,role,nexus scope/access,deleted_at,banned_until only','rollbackRetainsServiceReadGrants':restored['schema']!=before['schema']}
    finally:
        if created:
            prior_stage=stage
            stage='isolated_cleanup'
            require(database!=SOURCE and database.startswith(PREFIX),'refusing_nonisolated_cleanup')
            run(['docker','exec',CONTAINER,'dropdb','-U','postgres',database])
            stage=prior_stage
    require(success is not None,'rehearsal_incomplete')
    success['isolatedDatabaseRemoved']=True
    serialized=canonical(success)
    write_private(backup/'receipt.json',serialized)
    # Atomically replace only this module's latest root-only rehearsal receipt.
    pending=BACKUPS/('receipt-'+receipt_id+'.tmp'); write_private(pending,serialized); os.replace(pending,receipt_path)
    return success

try: print(json.dumps(main(),sort_keys=True))
except GateError as e: print(json.dumps({'ok':False,'stage':stage,'reason':str(e),'productionRollbackAutomatic':False})); sys.exit(1)
except Exception: print(json.dumps({'ok':False,'stage':stage,'reason':'release_helper_failed','productionRollbackAutomatic':False})); sys.exit(1)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--key', required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--preflight', action='store_true')
    mode.add_argument('--apply', action='store_true')
    parser.add_argument('--receipt', type=pathlib.Path, default=ROOT/'evidence/lead-intelligence/database-rehearsal.json')
    args = parser.parse_args()
    if not args.key or not pathlib.Path(args.key).is_file() or not args.host.replace('.', '').replace('-', '').isalnum():
        raise SystemExit('Invalid host or key path')
    payload = {name: (ROOT/path).read_text(encoding='utf-8') for name, path in FILES.items()}
    hashes = {name: hashlib.sha256(content.encode()).hexdigest() for name, content in payload.items()}
    hashes['releaseScript'] = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    bundle = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    payload.update(host=args.host, mode='apply' if args.apply else 'preflight' if args.preflight else 'rehearsal', artifactHashes=hashes, bundleSha256=bundle)
    if args.apply:
        receipt = json.loads(args.receipt.read_text(encoding='utf-8'))
        if receipt.get('status') != 'RESTORE_AND_ROLLBACK_VERIFIED' or receipt.get('bundleSha256') != bundle or receipt.get('host') != args.host:
            raise SystemExit('Apply requires the exact successful rehearsal receipt and unchanged candidate')
        canonical = json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode()
        payload['approvedReceiptSha256'] = hashlib.sha256(canonical).hexdigest()
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    remote = 'import base64\n'+REMOTE.replace('p=PAYLOAD', "p=json.loads(base64.b64decode('"+encoded+"'))")
    try:
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-i', args.key, 'root@'+args.host, 'python3 -'], input=remote, text=True, capture_output=True, timeout=360)
    except subprocess.TimeoutExpired:
        print(json.dumps({'ok': False, 'reason': 'ssh_timeout_check_remote_state_before_retry'}))
        return 1
    try:
        receipt = json.loads(result.stdout.strip())
    except (ValueError, TypeError):
        # Report a fixed classification, never raw SSH/Python/SQL diagnostics.
        labels = {'Connection timed out': 'connection_timeout', 'Connection reset': 'connection_reset', 'Connection closed': 'connection_closed', 'Host key verification failed': 'host_key_rejected', 'Permission denied': 'ssh_permission_denied', 'SyntaxError': 'remote_syntax_error', 'Traceback': 'remote_helper_exception'}
        reason = next((safe for message, safe in labels.items() if message in result.stderr), 'ssh_or_remote_helper_failed')
        print(json.dumps({'ok': False, 'reason': reason, 'exitCode': result.returncode}))
        return 1
    if result.returncode or receipt.get('ok') is False:
        print(json.dumps(receipt, sort_keys=True))
        return 1
    if not args.preflight:
        target = args.receipt.with_name('database-applied.json') if args.apply else args.receipt
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(receipt, indent=2, sort_keys=True)+'\n', encoding='utf-8')
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
