"""Bounded SSH release helper. Backups stay root-only on the data-plane host.

Default mode tests restore, migration, access rules and rollback in a separate DB.
--apply requires an already successful rehearsal and an unchanged source snapshot.
No credentials or row contents are printed or downloaded.
"""
import argparse
import base64
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--host', required=True)
parser.add_argument('--key', required=True)
parser.add_argument('--organization', required=True)
parser.add_argument('--product', required=True)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
payload = {
    'organization': args.organization, 'product': args.product, 'apply': args.apply,
    'migration': (ROOT/'supabase/migrations/20261008082314_workspace_finance_isolation.sql').read_text(encoding='utf-8'),
    'rollback': (ROOT/'supabase/rollback/finance-isolation.sql').read_text(encoding='utf-8'),
    'tests': (ROOT/'supabase/tests/finance_isolation.sql').read_text(encoding='utf-8'),
}
REMOTE = r'''
import os,sys,json,subprocess,pathlib,hashlib,datetime,uuid
os.umask(0o077)
p=PAYLOAD
for name in ['organization','product']: uuid.UUID(p[name])
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
root=pathlib.Path('/var/backups/vertux-workspace')
root.mkdir(mode=0o700,parents=True,exist_ok=True)
receipt=root/'finance-rehearsal.json'
fingerprint="SELECT md5(coalesce(string_agg(row_to_json(p)::text,E'\\n' ORDER BY id),'')) FROM public.projects p;"
def run(cmd,body=None):
    r=subprocess.run(cmd,input=body,capture_output=True)
    if r.returncode: raise RuntimeError('database command failed: '+r.stderr.decode(errors='replace').splitlines()[0][:180])
    return r.stdout
def sql(text,database='postgres'):
    return run(['docker','exec','-i','supabase-db','psql','-U','postgres','-d',database,'-At','-v','ON_ERROR_STOP=1'],text.encode()).decode().strip()
def apply_sql(database):
    scope="SELECT set_config('workspace.release.organization_id','%s',true); SELECT set_config('workspace.release.product_id','%s',true);"%(p['organization'],p['product'])
    return sql('BEGIN; LOCK TABLE public.projects IN ACCESS EXCLUSIVE MODE;'+scope+p['migration']+'COMMIT;',database)
migration_hash=hashlib.sha256(p['migration'].encode()).hexdigest()
before=sql(fingerprint)
count=int(sql('SELECT count(*) FROM public.projects;'))
if p['apply']:
    prior=json.loads(receipt.read_text())
    if not prior.get('restoreVerified') or not prior.get('rollbackVerified') or prior['sourceFingerprint']!=before or prior['migrationSha256']!=migration_hash:
        raise RuntimeError('Rehearsal missing, candidate changed, or live rows changed; run rehearsal again')
    # Source fingerprint is rechecked while holding the write lock.
    guard="DO $$ BEGIN IF ("+fingerprint.rstrip(';')+") <> '"+before+"' THEN RAISE EXCEPTION 'Source changed since rehearsal'; END IF; END $$;"
    scope="SELECT set_config('workspace.release.organization_id','%s',true); SELECT set_config('workspace.release.product_id','%s',true);"%(p['organization'],p['product'])
    sql('BEGIN; LOCK TABLE public.projects IN ACCESS EXCLUSIVE MODE;'+guard+scope+p['migration']+'COMMIT;')
    after_count=int(sql('SELECT count(*) FROM public.projects;'))
    retained=int(sql('SELECT count(*) FROM public.workspace_project_finance;'))
    legacy=int(sql("SELECT count(*) FROM public.projects WHERE raw ? 'money';"))
    if after_count!=count or retained!=prior['financeRows'] or legacy!=0: raise RuntimeError('Post-migration count verification failed')
    result={**prior,'appliedAt':stamp,'status':'SERVER_MIGRATED','projectRows':after_count,'financeRows':retained,'legacyFinanceRows':legacy,'productionWrites':True}
    (root/('finance-applied-'+stamp+'.json')).write_text(json.dumps(result,indent=2))
    print(json.dumps(result));sys.exit(0)
backup=root/('finance-'+stamp)
backup.mkdir(mode=0o700)
dump=run(['docker','exec','supabase-db','pg_dump','-U','postgres','-d','postgres','--format=custom','--no-owner','--no-privileges','--table=public.projects'])
(backup/'projects.dump').write_bytes(dump)
(backup/'rollback.sql').write_text(p['rollback'])
database='workspace_release_test_'+stamp.lower()
if not database.startswith('workspace_release_test_'): raise RuntimeError('Invalid isolated DB name')
created=False
try:
    run(['docker','exec','supabase-db','createdb','-U','postgres',database]);created=True
    sql("""CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb,deleted_at timestamptz,banned_until timestamptz);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $f$;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb $f$;
      GRANT USAGE ON SCHEMA auth TO authenticated,anon;
      """,database)
    run(['docker','exec','-i','supabase-db','pg_restore','-U','postgres','-d',database,'--exit-on-error','--no-owner','--no-privileges'],dump)
    if sql(fingerprint,database)!=before: raise RuntimeError('Restored backup differs from live snapshot')
    finance_rows=int(sql("SELECT count(*) FROM public.projects WHERE raw ? 'money';",database))
    money_hash=sql("SELECT md5(coalesce(string_agg(id::text||':'||(raw->'money')::text,E'\\n' ORDER BY id),'')) FROM public.projects WHERE raw ? 'money';",database)
    apply_sql(database)
    new_hash=sql("SELECT md5(coalesce(string_agg(project_id::text||':'||money::text,E'\\n' ORDER BY project_id),'')) FROM public.workspace_project_finance;",database)
    if money_hash!=new_hash: raise RuntimeError('Finance contents changed during migration')
    sql(p['tests'],database)
    sql(p['rollback'],database)
    if sql(fingerprint,database)!=before: raise RuntimeError('Rollback differs from original snapshot')
    result={'checkedAt':stamp,'status':'RESTORE_AND_ROLLBACK_VERIFIED','restoreVerified':True,'rollbackVerified':True,'roleMatrixVerified':True,'sourceFingerprint':before,'migrationSha256':migration_hash,'backupPath':str(backup),'backupSha256':hashlib.sha256(dump).hexdigest(),'projectRows':count,'financeRows':finance_rows,'productionWrites':False}
    receipt.write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
finally:
    if created: run(['docker','exec','supabase-db','dropdb','-U','postgres',database])
'''
encoded = base64.b64encode(json.dumps(payload).encode()).decode()
remote = 'import base64\n' + REMOTE.replace('p=PAYLOAD', "p=json.loads(base64.b64decode('"+encoded+"'))")
r = subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-i',args.key,'root@'+args.host,'python3 -'],input=remote,text=True,capture_output=True)
if r.returncode:
    print(json.dumps({'ok':False,'reason':r.stderr.strip().splitlines()[-1][:240] if r.stderr.strip() else 'SSH helper failed'}))
    raise SystemExit(1)
print(r.stdout.strip())
