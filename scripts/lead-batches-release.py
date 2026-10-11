"""Additive archive migration. Rehearse a private server-side backup before apply.
Only receipts leave the server. No auth tokens, private table rows or dumps do.
"""
import argparse,base64,hashlib,json,sys
from pathlib import Path
import paramiko

ROOT=Path(__file__).resolve().parents[1]
REMOTE=r'''
import datetime,fcntl,hashlib,json,os,pathlib,re,subprocess,uuid
os.umask(0o077)
p=PAYLOAD
stage='preflight'
base=pathlib.Path('/var/backups/vertux-workspace/lead-batches')
base.mkdir(mode=0o700,parents=True,exist_ok=True)
def need(ok,code):
 if not ok:raise RuntimeError(code)
def run(argv,body=None):
 r=subprocess.run(argv,input=body,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
 if r.returncode:
  code=re.search(rb'(?:ERROR|FATAL):\s+([A-Z0-9]{5})\b',r.stderr)
  kind=re.search(rb'(?:schema|relation|function|type|extension|role) ["a-zA-Z0-9_.(), -]{1,100} (?:already exists|does not exist|is not a member)',r.stderr)
  diagnostic=re.search(rb'ERROR: ([^\r\n]{1,240})',r.stderr)
  diagnostic=re.sub(r'"[^"]*"|\x27[^\x27]*\x27|[A-Za-z0-9_+/=-]{30,}', '<redacted>', diagnostic.group(1).decode(errors='replace')) if diagnostic else 'no_sql_error'
  raise RuntimeError('database_command_failed'+(':'+code.group(1).decode() if code else ':'+kind.group(0).decode() if kind else ':'+diagnostic))
 return r.stdout
def sql(q,db='postgres'):
 need(db=='postgres' or re.fullmatch(r'workspace_batches_test_[a-f0-9]{12}',db),'database_scope')
 return run(['docker','exec','-i','supabase-db','psql','-U','postgres','-d',db,'-XAtq','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],("SET statement_timeout='90s';SET lock_timeout='15s';"+q).encode()).decode().strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
def digest(v):return hashlib.sha256(v).hexdigest()
def save(file,data):
 need(file.parent.resolve().is_relative_to(base.resolve()),'backup_scope')
 with os.fdopen(os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(data)
tables=['projects','workspace_project_finance','workspace_lead_settings','workspace_lead_records','workspace_lead_jobs','workspace_lead_events','workspace_lead_replies','workspace_lead_usage']
def fingerprint(db='postgres'):
 result={}
 for t in tables:
  # Additive metadata is excluded from the content invariant.
  expr="to_jsonb(t)-'archived_at'-'archive_reason'-'lead_batch_id'-'lead_batch_name'" if t=='projects' else "to_jsonb(t)-'archived_previous_excluded'" if t=='workspace_lead_records' else 'to_jsonb(t)'
  result[t]=sql("SELECT md5(coalesce(string_agg(x::text,E'\\n' ORDER BY x::text),'')) FROM (SELECT "+expr+' x FROM public.'+t+' t) q',db)
 result['scope']=sql("SELECT md5(to_jsonb(s)::text) FROM workspace_private.scope s",db)
 result['rls']=sql("SELECT md5(string_agg(pg_get_expr(polqual,polrelid)||coalesce(pg_get_expr(polwithcheck,polrelid),''),',' ORDER BY polname)) FROM pg_policy WHERE polrelid IN ('public.projects'::regclass,'public.workspace_project_finance'::regclass)",db)
 return result
def main():
 global stage
 need(os.geteuid()==0,'root_required');need(base.stat().st_mode&0o077==0,'private_backup_required')
 lock=open('/run/lock/kovrocity-workspace-deploy.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 need(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='projects' AND column_name='archived_at'")=='0','migration_already_present')
 need(sql("SELECT count(*) FROM public.workspace_lead_jobs WHERE status IN ('running','queued','retry','paused')")=='0','pending_jobs_require_review')
 before=fingerprint();stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
 if p['mode']=='apply':
  receipt=json.loads((base/'rehearsal.json').read_text());need(receipt['migrationSha256']==digest(p['migration'].encode()),'candidate_changed');need(receipt['source']==before,'source_changed');need(receipt['status']=='REHEARSED','rehearsal_required')
  for name,sha in receipt['backups'].items():need(digest((base/receipt['backupId']/name).read_bytes())==sha,'backup_changed')
  need(receipt.get('importSha256')==digest(p['importSql'].encode()),'batch_changed')
  stage='apply';sql(p['migration']);after=fingerprint();need(after==before,'data_invariant_changed')
  sql(p['checks']);result={'status':'APPLIED','checkedAt':stamp,'migrationSha256':receipt['migrationSha256'],'dataPreserved':True,'backupId':receipt['backupId']}
  if p['importSql']:
   stage='import_batch';result['batch']=json.loads(sql(p['importSql']+'COMMIT;'))
  save(base/('applied-'+receipt['backupId']+'.json'),json.dumps(result).encode());return result
 backup_id=uuid.uuid4().hex;folder=base/backup_id;folder.mkdir(mode=0o700)
 stage='backup'
 # This data plane is isolated; backup only public CRM/research and private policy schema.
 dump=run(['docker','exec','supabase-db','pg_dump','-U','postgres','-d','postgres','--format=custom','--schema=public','--schema=workspace_private'])
 auth=sql("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'raw_app_meta_data',raw_app_meta_data,'deleted_at',deleted_at,'banned_until',banned_until)),'[]'::jsonb) FROM auth.users").encode()
 helpers=sql("SELECT string_agg(pg_get_functiondef(oid)||';',E'\\n') FROM pg_proc WHERE oid IN ('auth.uid()'::regprocedure,'auth.jwt()'::regprocedure)").encode()
 files={'workspace.dump':dump,'auth-minimal.json':auth,'auth-helpers.sql':helpers,'migration.sql':p['migration'].encode(),'rollback.sql':p['rollback'].encode(),'import.sql':p['importSql'].encode()}
 for name,data in files.items():save(folder/name,data)
 need(fingerprint()==before,'source_changed_during_backup')
 db='workspace_batches_test_'+uuid.uuid4().hex[:12];created=False
 try:
  stage='restore';run(['docker','exec','supabase-db','createdb','-U','postgres','--template=template0',db]);created=True
  stage='restore_auth';sql('REVOKE ALL ON DATABASE '+db+' FROM PUBLIC;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb,deleted_at timestamptz,banned_until timestamptz);'+helpers.decode()+' GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;',db)
  sql('INSERT INTO auth.users SELECT * FROM jsonb_to_recordset('+lit(auth.decode())+'::jsonb) AS x(id uuid,raw_app_meta_data jsonb,deleted_at timestamptz,banned_until timestamptz);',db)
  stage='restore_empty_public';sql('DROP SCHEMA public;',db)
  stage='restore_dump';need(sql("SELECT rolsuper FROM pg_roles WHERE rolname='supabase_admin'")=='t','isolated_restore_admin_missing')
  run(['docker','exec','-i','supabase-db','pg_restore','-U','supabase_admin','-d',db,'--exit-on-error','--single-transaction'],dump)
  need(fingerprint(db)==before,'restore_differs')
  stage='isolated_migration';sql(p['migration'],db);need(fingerprint(db)==before,'migration_changed_data');sql(p['checks'],db)
  batch_result=None
  if p['importSql']:
   stage='isolated_import';batch_result=json.loads(sql(p['importSql']+'ROLLBACK;',db));need(fingerprint(db)==before,'import_rollback_changed_data')
  stage='archive_roundtrip';sql("BEGIN;UPDATE public.projects SET archived_at=now(),lead_batch_id='rehearsal',lead_batch_name='Rehearsal';DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.workspace_lead_records WHERE NOT excluded) THEN RAISE EXCEPTION 'archive_failed';END IF;END $$;UPDATE public.projects SET archived_at=NULL;ROLLBACK;",db)
  need(fingerprint(db)==before,'archive_transaction_changed_data')
  stage='isolated_rollback';sql(p['rollback'],db);need(fingerprint(db)==before,'rollback_changed_data');need(sql("SELECT count(*) FROM information_schema.columns WHERE table_name='projects' AND column_name='archived_at'",db)=='0','rollback_incomplete')
 finally:
  if created:run(['docker','exec','supabase-db','dropdb','-U','postgres',db])
 stage='receipt';need(fingerprint()==before,'production_changed')
 receipt={'status':'REHEARSED','checkedAt':stamp,'source':before,'backupId':backup_id,'backups':{name:digest(data) for name,data in files.items()},'migrationSha256':digest(p['migration'].encode()),'importSha256':digest(p['importSql'].encode()),'batch':batch_result,'restoreVerified':True,'rollbackVerified':True,'archiveRoundtripVerified':True,'backupDownloaded':False,'isolatedDatabaseRemoved':True}
 save(folder/'receipt.json',json.dumps(receipt).encode());pending=base/(backup_id+'.tmp');save(pending,json.dumps(receipt).encode());os.replace(pending,base/'rehearsal.json');return receipt
try:print(json.dumps(main()))
except Exception as e:print(json.dumps({'status':'FAILED','stage':stage,'reason':str(e) if isinstance(e,RuntimeError) else type(e).__name__}));raise SystemExit(1)
'''
def import_sql(path):
 if not path:return ''
 batch=json.loads(Path(path).read_text(encoding='utf-8'));rows=batch['rows']
 if len(rows)!=100 or len({r['project']['id'] for r in rows})!=100:raise ValueError('batch_count')
 for row in rows:
  if row['project']['lead_batch_id']!=batch['batchId'] or row['research']['kind']!='curated':raise ValueError('batch_metadata')
 literal="'"+json.dumps(batch,ensure_ascii=False).replace("'","''")+"'::jsonb"
 fields='id,company,site,city,address,niche,phone,email,source_url,raw,lead_batch_id,lead_batch_name,stage,processed,type,context,issues,call_script,gen_prompt'
 return """BEGIN;
 LOCK TABLE public.workspace_lead_settings,public.projects,public.workspace_lead_records,public.workspace_lead_jobs,public.workspace_project_finance IN SHARE ROW EXCLUSIVE MODE;
 CREATE TEMP TABLE import_batch ON COMMIT DROP AS SELECT """+literal+""" payload;
 CREATE TEMP TABLE import_legacy ON COMMIT DROP AS SELECT id,to_jsonb(p)-ARRAY['archived_at','archive_reason','lead_batch_id','lead_batch_name','updated_at'] content FROM public.projects p;
 CREATE TEMP TABLE import_legacy_research ON COMMIT DROP AS SELECT project_id,to_jsonb(l)-ARRAY['status','excluded','archived_previous_excluded','updated_at'] content FROM public.workspace_lead_records l;
 CREATE TEMP TABLE import_preserve ON COMMIT DROP AS SELECT 'finance' kind,to_jsonb(t) content FROM public.workspace_project_finance t UNION ALL SELECT 'usage',to_jsonb(t) FROM public.workspace_lead_usage t UNION ALL SELECT 'settings',to_jsonb(t) FROM public.workspace_lead_settings t UNION ALL SELECT 'replies',to_jsonb(t) FROM public.workspace_lead_replies t;
 DO $$ BEGIN
  IF (SELECT count(*) FROM import_legacy)<>(SELECT (payload->>'expectedLegacyCount')::int FROM import_batch) THEN RAISE EXCEPTION 'legacy_count_changed';END IF;
  IF EXISTS(SELECT 1 FROM public.projects WHERE archived_at IS NOT NULL OR lead_batch_id IS NOT NULL) THEN RAISE EXCEPTION 'batch_already_present';END IF;
  IF EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE status IN ('running','queued','retry','paused')) THEN RAISE EXCEPTION 'pending_jobs';END IF;
 END $$;
 UPDATE public.projects SET lead_batch_id='legacy-construction-20261011',lead_batch_name='Старая база · ремонт и строительство',archived_at=clock_timestamp(),archive_reason='Предыдущая база: ремонт и строительство. Исходные прогоны не были сохранены.';
 INSERT INTO public.projects("""+fields+") SELECT "+','.join('p.'+f for f in fields.split(','))+""" FROM import_batch b CROSS JOIN LATERAL jsonb_array_elements(b.payload->'rows') r CROSS JOIN LATERAL jsonb_populate_record(NULL::public.projects,r->'project') p;
 UPDATE public.workspace_lead_records l SET status='completed',quick=r->'research',deep=NULL,score=r->'research'->'score',materials=r->'materials',materials_revision=1,materials_edited=true,checked_at=(r->'research'->>'checkedAt')::timestamptz,expires_at=(r->'research'->>'expiresAt')::timestamptz,updated_at=clock_timestamp()
 FROM import_batch b CROSS JOIN LATERAL jsonb_array_elements(b.payload->'rows') r WHERE l.project_id=(r->'project'->>'id')::uuid;
 UPDATE public.workspace_lead_jobs SET status='cancelled',worker_id=NULL,lease_until=NULL,error_code='curated_import',updated_at=clock_timestamp() WHERE project_id IN (SELECT id FROM public.projects WHERE lead_batch_id=(SELECT payload->>'batchId' FROM import_batch)) AND status IN ('queued','running','retry','paused');
 DO $$ DECLARE row_data record;s workspace_private.scope; BEGIN
  SELECT * INTO STRICT s FROM workspace_private.scope;
  FOR row_data IN SELECT p.id,p.lead_batch_id FROM public.projects p WHERE lead_batch_id=(SELECT payload->>'batchId' FROM import_batch) LOOP
   PERFORM workspace_private.lead_event(s.organization_id,s.product_id,row_data.id,NULL,NULL,'curated_import',jsonb_build_object('batchId',row_data.lead_batch_id,'method','public_sources','outboundSent',false));
  END LOOP;
  IF EXISTS(SELECT 1 FROM import_legacy i JOIN public.projects p USING(id) WHERE i.content IS DISTINCT FROM to_jsonb(p)-ARRAY['archived_at','archive_reason','lead_batch_id','lead_batch_name','updated_at']) THEN RAISE EXCEPTION 'legacy_content_changed';END IF;
  IF EXISTS(SELECT 1 FROM import_legacy_research i JOIN public.workspace_lead_records l USING(project_id) WHERE i.content IS DISTINCT FROM to_jsonb(l)-ARRAY['status','excluded','archived_previous_excluded','updated_at']) THEN RAISE EXCEPTION 'legacy_research_changed';END IF;
  IF EXISTS((SELECT * FROM import_preserve EXCEPT ALL (SELECT 'finance',to_jsonb(t) FROM public.workspace_project_finance t UNION ALL SELECT 'usage',to_jsonb(t) FROM public.workspace_lead_usage t UNION ALL SELECT 'settings',to_jsonb(t) FROM public.workspace_lead_settings t UNION ALL SELECT 'replies',to_jsonb(t) FROM public.workspace_lead_replies t))) THEN RAISE EXCEPTION 'preserved_data_changed';END IF;
  IF (SELECT count(*) FROM public.projects WHERE archived_at IS NULL)<>100 OR (SELECT count(*) FROM public.projects WHERE archived_at IS NOT NULL)<>180 THEN RAISE EXCEPTION 'result_count';END IF;
  IF (SELECT count(*) FROM public.workspace_lead_records l JOIN public.projects p ON p.id=l.project_id WHERE p.archived_at IS NULL AND l.quick->>'kind'='curated' AND l.materials_revision=1 AND NOT l.excluded)<>100 THEN RAISE EXCEPTION 'research_incomplete';END IF;
  IF EXISTS(SELECT 1 FROM public.workspace_lead_records l JOIN public.projects p ON p.id=l.project_id WHERE p.archived_at IS NOT NULL AND NOT l.excluded) THEN RAISE EXCEPTION 'archive_not_excluded';END IF;
  IF EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE status IN ('running','queued','retry','paused')) THEN RAISE EXCEPTION 'unexpected_jobs';END IF;
 END $$;
 SELECT jsonb_build_object('batchId',(SELECT payload->>'batchId' FROM import_batch),'active',100,'archived',180,'materials',100,'legacyCardsPreserved',true,'legacyResearchPreserved',true,'financePreserved',true,'aiUsageUnchanged',true,'pendingJobs',0);
 """

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');parser.add_argument('--batch');args=parser.parse_args()
 payload={k:(ROOT/path).read_text(encoding='utf-8') for k,path in {'migration':'supabase/migrations/20261011185814_workspace_lead_batches_archive.sql','rollback':'supabase/rollback/lead-batches-archive.sql','checks':'supabase/tests/lead_intelligence.sql'}.items()};payload['mode']='apply' if args.apply else 'rehearse'
 payload['importSql']=import_sql(args.batch)
 remote='import base64\n'+REMOTE.replace('p=PAYLOAD','p=json.loads(base64.b64decode('+repr(base64.b64encode(json.dumps(payload).encode()).decode())+'))')
 jump=paramiko.SSHClient();jump.load_system_host_keys();jump.set_missing_host_key_policy(paramiko.RejectPolicy());client=paramiko.SSHClient();client.load_system_host_keys();client.set_missing_host_key_policy(paramiko.RejectPolicy())
 try:
  jump.connect('31.44.4.244',username='root',key_filename=r'C:\Users\figri\.ssh\vertux_codex_deploy',look_for_keys=False,allow_agent=False,timeout=15)
  channel=jump.get_transport().open_channel('direct-tcpip',('95.181.213.124',22),('127.0.0.1',0));client.connect('95.181.213.124',username='root',key_filename=r'C:\Users\figri\.ssh\supabase_prod_ed25519',sock=channel,look_for_keys=False,allow_agent=False,timeout=15)
  stdin,stdout,stderr=client.exec_command('python3 -',timeout=300);stdin.write(remote);stdin.channel.shutdown_write();value=json.loads(stdout.read());code=stdout.channel.recv_exit_status()
  out=ROOT/'evidence/lead-intelligence'/('batches-applied.json' if args.apply else 'batches-rehearsal.json');out.write_text(json.dumps(value,indent=2),encoding='utf-8');print(json.dumps(value));return code
 finally:client.close();jump.close()
if __name__=='__main__':sys.exit(main())
