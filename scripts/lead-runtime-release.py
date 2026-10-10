"""Versioned personal Workspace runtime release. Credentials stay on the host.

--prepare only stages source and builds images. --activate requires the applied
database receipt and preserves all preexisting Caddy routes and services.
"""
import argparse, hashlib, io, json, pathlib, shlex, subprocess, tarfile, time

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--host', default='95.181.213.124')
parser.add_argument('--key', required=True)
parser.add_argument('--jump-host')
parser.add_argument('--jump-key')
parser.add_argument('--activate', action='store_true')
args = parser.parse_args()
names = ['package.json','package-lock.json','deploy/Dockerfile.lead-server','deploy/Dockerfile.lead-browser','deploy/lead-browser-broker.py','deploy/lead-docker-proxy.mjs','deploy/lead-browser-seccomp.json']
names += [str(p.relative_to(ROOT)).replace('\\','/') for p in sorted((ROOT/'lead-server').glob('*.mjs'))]
files = {name:(ROOT/name).read_bytes() for name in names}
hashes = {name:hashlib.sha256(data).hexdigest() for name,data in files.items()}
bundle = hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()
archive = io.BytesIO()
with tarfile.open(fileobj=archive,mode='w:gz') as tar:
    for name,data in files.items():
        info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644;tar.addfile(info,io.BytesIO(data))
if not args.host.replace('.','').replace('-','').isalnum() or not pathlib.Path(args.key).is_file():raise SystemExit('Invalid host or key')
ssh=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=20','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=4','-i',args.key,'root@'+args.host]
transport=[]
if args.jump_host:
    import re
    if not re.fullmatch(r'[A-Za-z0-9.-]+',args.jump_host) or not args.jump_key or not re.fullmatch(r'[A-Za-z0-9_./:\\-]+',args.jump_key) or not pathlib.Path(args.jump_key).is_file():raise SystemExit('Invalid existing SSH jump connection')
    jump=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=20','-i',args.jump_key.replace('\\','/'),'-W','%h:%p','root@'+args.jump_host]
    transport=['-o','ProxyCommand='+' '.join(jump)]
    ssh=ssh[:1]+transport+ssh[1:]
def command(argv,body=None):
    result=subprocess.run(ssh+[shlex.join(argv)],input=body.encode() if isinstance(body,str) else body,capture_output=True,timeout=3600)
    if result.returncode:
        import re
        matched=re.findall(rb'RuntimeError: ([a-z_]+(?::[a-z0-9_-]+)?)',result.stderr)
        raise RuntimeError(matched[-1].decode() if matched else 'Remote step failed; protected logs remain on the host')
    return result.stdout

release='/opt/vertux-lead-intelligence/releases/'+bundle[:16]
archivepath=ROOT/'deploy'/('lead-runtime-'+bundle[:16]+'.tar.gz')
try:
    command(['mkdir','-p',release])
    archivepath.write_bytes(archive.getvalue())
    transfer=subprocess.run(['scp','-q']+transport+['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=20','-i',args.key,str(archivepath),'root@'+args.host+':'+release+'/source.tar.gz'],capture_output=True,timeout=120)
    if transfer.returncode:raise RuntimeError('Source upload failed')
    command(['tar','-xzf',release+'/source.tar.gz','-C',release])
    params={'release':release,'bundle':bundle,'hashes':hashes,'activate':args.activate,'migrationSha256':hashlib.sha256((ROOT/'supabase/migrations/20261010004715_workspace_lead_intelligence.sql').read_text(encoding='utf-8').encode()).hexdigest()}
    remote = r"""
import os,sys,json,pathlib,subprocess,hashlib,datetime,secrets,time,stat,urllib.request,urllib.error
os.umask(0o077)
p=PARAMS
base=pathlib.Path('/opt/vertux-lead-intelligence');release=pathlib.Path(p['release'])
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=pathlib.Path('/var/backups/vertux-lead-intelligence')/stamp
backup.mkdir(parents=True,mode=0o700)
log=open(backup/'build.log','wb')
def run(argv,body=None,quiet=False):
    result=subprocess.run(argv,input=body,capture_output=True,timeout=1800)
    if quiet:log.write(result.stdout+result.stderr);log.flush()
    if result.returncode:
        if not quiet:log.write(result.stdout+result.stderr);log.flush()
        raise RuntimeError('step_failed:'+pathlib.Path(argv[0]).name)
    return result.stdout
def sql(query):return run(['docker','exec','-i','supabase-db','psql','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1'],query.encode()).decode().strip()
def write(path,data,mode=0o600):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data if isinstance(data,bytes) else data.encode());path.chmod(mode)
for name,digest in p['hashes'].items():
    if hashlib.sha256((release/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('source_hash_mismatch')
image='vertux-lead-intelligence:'+p['bundle'][:16];browser='vertux-lead-browser:'+p['bundle'][:16]
for tag,dockerfile in [(image,'deploy/Dockerfile.lead-server'),(browser,'deploy/Dockerfile.lead-browser')]:
    if subprocess.run(['docker','image','inspect',tag],capture_output=True).returncode:
        run(['docker','build','-f',str(release/dockerfile),'-t',tag,str(release)],quiet=True)
imageid=run(['docker','inspect','--format','{{.Id}}',image]).decode().strip()
browserid=run(['docker','inspect','--format','{{.Id}}',browser]).decode().strip()
prepared={'status':'RUNTIME_IMAGES_PREPARED','at':stamp,'bundleSha256':p['bundle'],'release':str(release),'image':imageid,'browserImage':browserid,'backupPath':str(backup),'fileHashes':p['hashes']}
write(release/'prepared.json',json.dumps(prepared,indent=2))
if not p['activate']:
    print(json.dumps(prepared));sys.exit(0)
if sql("SELECT to_regclass('public.workspace_lead_settings') IS NOT NULL;")!='t':raise RuntimeError('database_migration_required')
applied=[]
for path in pathlib.Path('/var/backups/vertux-workspace/lead-intelligence').glob('applied-*.json'):
    record=json.loads(path.read_text())
    if record.get('status')=='SERVER_MIGRATED' and record.get('migrationSha256')==p['migrationSha256'] and record.get('restoreVerified') and record.get('rollbackVerified'):applied.append(record)
if len(applied)!=1:raise RuntimeError('exact_applied_database_receipt_required')
scope=json.loads(sql("SELECT row_to_json(s) FROM workspace_private.scope s;"))
org=scope['organization_id'];product=scope['product_id']
owners=json.loads(sql("SELECT coalesce(json_agg(id),'[]') FROM auth.users WHERE deleted_at IS NULL AND (banned_until IS NULL OR banned_until<now()) AND raw_app_meta_data->>'role'='owner' AND raw_app_meta_data->>'nexus_access'='active' AND raw_app_meta_data->>'nexus_organization_id'='"+org+"' AND raw_app_meta_data->>'nexus_product_id'='"+product+"';"))
if len(owners)!=1:raise RuntimeError('exact_personal_owner_required')
if subprocess.run(['docker','inspect','vertux-lead-intelligence'],capture_output=True).returncode==0:raise RuntimeError('existing_runtime_requires_reviewed_replacement')
config=pathlib.Path('/etc/vertux-lead-intelligence');config.mkdir(mode=0o700,exist_ok=True)
state=pathlib.Path('/var/lib/vertux-lead-intelligence');state.mkdir(mode=0o700,exist_ok=True);os.chown(state,1000,1000)
seccomp=str(config/'browser-seccomp.json');write(seccomp,(release/'deploy/lead-browser-seccomp.json').read_bytes(),0o644)
# Read only the required existing data-plane keys, in memory on this host.
kong=json.loads(run(['docker','inspect','supabase-kong']))[0]
existing=dict(item.split('=',1) for item in kong['Config']['Env'] if '=' in item)
for key in ['SUPABASE_ANON_KEY','SUPABASE_SERVICE_KEY']:
    if not existing.get(key) or '\n' in existing[key]:raise RuntimeError('data_plane_credentials_unavailable')
environment={
 'LEAD_ENABLED':'true','LEAD_SUPABASE_URL':'https://vertuxdb.duckdns.org','LEAD_SUPABASE_ANON_KEY':existing['SUPABASE_ANON_KEY'],'LEAD_SUPABASE_SERVICE_KEY':existing['SUPABASE_SERVICE_KEY'],
 'LEAD_ORGANIZATION_ID':org,'LEAD_PRODUCT_ID':product,'LEAD_USAGE_SALT':secrets.token_hex(32),
 'LEAD_ORIGINS':'https://weks666.github.io,https://workspace.vertux.online','LEAD_PORT':'47921','LEAD_POLL_MS':'5000','LEAD_REQUESTS_PER_MINUTE':'60',
 'LEAD_MAX_DAILY_USD':'0','LEAD_MAX_COMPANY_USD':'0','LEAD_MAX_KEY_USD':'0',
 'LEAD_CHATGPT_OWNER_ID':owners[0],'LEAD_CHATGPT_DIRECTORY':'/state/chatgpt','LEAD_CHATGPT_PORT':'47922','LEAD_MAX_DAILY_PLAN_REQUESTS':'10',
 'LEAD_BROWSER_IMAGE':browserid,'LEAD_BROWSER_SECCOMP_PROFILE':seccomp,'LEAD_BROWSER_BROKER_SOCKET':'/run/vertux-lead-browser/broker.sock','LEAD_PSI_ENABLED':'0'
}
write(config/'service.env',''.join(k+'='+v+'\n' for k,v in environment.items()))
write(config/'browser.env','LEAD_BROWSER_IMAGE='+browserid+'\nLEAD_BROWSER_SECCOMP_PROFILE='+seccomp+'\nLEAD_BROWSER_BROKER_SOCKET=/run/vertux-lead-browser/broker.sock\nLEAD_BROWSER_BROKER_GID=1000\nLEAD_BROWSER_MAX_ACTIVE=1\n')
brokerunit='''[Unit]
Description=Bounded browser runner for personal Workspace
After=docker.service
Requires=docker.service
[Service]
Type=simple
EnvironmentFile=/etc/vertux-lead-intelligence/browser.env
ExecStart=/usr/bin/python3 RELEASE/deploy/lead-browser-broker.py
Restart=on-failure
RestartSec=3
TimeoutStopSec=90
RuntimeDirectory=vertux-lead-browser
RuntimeDirectoryMode=0750
UMask=0077
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/run/vertux-lead-browser
PrivateTmp=true
MemoryMax=128M
TasksMax=32
[Install]
WantedBy=multi-user.target
'''.replace('RELEASE',str(release))
unitpath='/etc/systemd/system/vertux-lead-browser.service'
if pathlib.Path(unitpath).exists():raise RuntimeError('existing_browser_service_requires_review')
write(unitpath,brokerunit,0o644)
caddy=pathlib.Path('/etc/caddy/Caddyfile');original=caddy.read_bytes();caddymode=stat.S_IMODE(caddy.stat().st_mode);write(backup/'Caddyfile',original)
supervised_edge=run(['systemctl','show','kovrocity-runtime-supervisor-0.1.6.service','--property=LoadState','--value']).decode().strip()=='loaded'
anchor='vertuxdb.duckdns.org {'
route='''
    handle /webhook/vertux-lead-intelligence {
        request_body {
            max_size 64KB
        }
        header X-Vertux-Lead v1
        header Cache-Control no-store
        reverse_proxy 127.0.0.1:47921
    }
'''
if original.decode().count(anchor)!=1 or (not supervised_edge and '/webhook/vertux-lead-intelligence' in original.decode()):raise RuntimeError('unexpected_existing_route')
candidate=original.decode().replace(anchor,anchor+route,1).encode()
started=False;routed=False
try:
    # Personal-plan defaults; no paid/API activation. This service has one worker.
    sql("UPDATE public.workspace_lead_settings SET config=jsonb_set(jsonb_set(jsonb_set(jsonb_set(config,'{aiProvider}','\"chatgpt_plan\"'),'{aiEnabled}','false'),'{concurrency}','1'),'{paused}','true'),updated_at=now();")
    run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','vertux-lead-browser.service'])
    for attempt in range(20):
        if pathlib.Path('/run/vertux-lead-browser/broker.sock').exists():break
        time.sleep(.2)
    else:raise RuntimeError('browser_broker_unavailable')
    run(['docker','run','-d','--name','vertux-lead-intelligence','--label','online.vertux.lead.bundle='+p['bundle'],'--restart','unless-stopped','--network','host','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','96','--memory','384m','--cpus','0.75','--log-opt','max-size=5m','--log-opt','max-file=2','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--env-file',str(config/'service.env'),'--mount','type=bind,src='+str(state)+',dst=/state','--mount','type=bind,src=/run/vertux-lead-browser,dst=/run/vertux-lead-browser,readonly',imageid]);started=True
    probe="fetch('http://127.0.0.1:47921/webhook/vertux-lead-intelligence',{method:'POST',headers:{Origin:'https://weks666.github.io','Content-Type':'application/json'},body:'{\"action\":\"health\"}'}).then(r=>{if(r.status!==401)process.exit(1)}).catch(()=>process.exit(1))"
    for attempt in range(20):
        try:run(['docker','exec','vertux-lead-intelligence','node','-e',probe]);break
        except RuntimeError:
            if attempt==19:raise
            time.sleep(.3)
    browserprobe=r'''import {createBrowserRenderer} from '/app/lead-server/browser-renderer.mjs';
const html='<html><body><script>document.body.innerHTML="<main>VERTUX_RENDERER_VERIFIED</main>"</script></body></html>';
const render=createBrowserRenderer();const result=await render('https://example.com/',{timeoutMs:30000,checkUrl:async()=>true,fetcher:async url=>({url:String(url),status:200,headers:{'content-type':'text/html'},body:Buffer.from(html),text:html})});
if(!result.html.includes('<main>VERTUX_RENDERER_VERIFIED</main>')||result.isolation!=='docker_network_none')throw Error('renderer_fixture_failed');
console.log(JSON.stringify({rendered:true,isolation:result.isolation,requests:result.requests}));'''
    browserresult=json.loads(run(['docker','exec','vertux-lead-intelligence','node','--input-type=module','-e',browserprobe]).decode())
    egressprobe="const net=require('node:net');const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>process.exit(1));s.on('error',e=>{if(!['ENETUNREACH','EHOSTUNREACH'].includes(e.code))process.exit(1);console.log('network_none_verified')});s.setTimeout(3000,()=>process.exit(1));"
    run(['docker','run','--rm','--network=none','--read-only','--user','pwuser','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','node',browserid,'-e',egressprobe])
    if not supervised_edge:
        if caddy.read_bytes()!=original:raise RuntimeError('route_changed_during_release')
        write(caddy,candidate,caddymode);routed=True
        run(['caddy','validate','--config',str(caddy)],quiet=True);run(['systemctl','reload','caddy'])
        time.sleep(6)
        if caddy.read_bytes()!=candidate:raise RuntimeError('edge_requires_managed_route_release')
        for origin,wanted in [('https://weks666.github.io',401),('https://foreign.invalid',403)]:
            req=urllib.request.Request('https://vertuxdb.duckdns.org/webhook/vertux-lead-intelligence',data=b'{"action":"overview"}',headers={'Origin':origin,'Content-Type':'application/json'})
            try:urllib.request.urlopen(req,timeout=15);raise RuntimeError('public_route_unprotected')
            except urllib.error.HTTPError as error:
                if error.code!=wanted or error.headers.get('X-Vertux-Lead')!='v1':raise RuntimeError('public_route_verification_failed')
    sql("UPDATE public.workspace_lead_settings SET config=jsonb_set(config,'{paused}','false'),updated_at=now();")
    # Service connection uses its own authorized operator RPC, no owner session.
    status=run(['docker','exec','vertux-lead-intelligence','node','--input-type=module','-e',"import {readLeadConfig} from '/app/lead-server/run.mjs';import{createLeadStore}from'/app/lead-server/store.mjs';const s=createLeadStore(readLeadConfig());const a=await s.getSettings();console.log(JSON.stringify({aiProvider:a.aiProvider,aiEnabled:a.aiEnabled,concurrency:a.concurrency}));"]).decode().strip()
    receipt={**prepared,'status':'DEPLOYED_AWAITING_EDGE_ROUTE' if supervised_edge else 'DEPLOYED_AUTH_LOCKED_AI_OFF','managedEdgeRequired':supervised_edge,'settings':json.loads(status),'endpoint':'https://vertuxdb.duckdns.org/webhook/vertux-lead-intelligence','missingAuthStatus':None if supervised_edge else 401,'foreignOriginStatus':None if supervised_edge else 403,'browser':{**browserresult,'directEgressBlocked':True,'sandbox':True,'dockerSocketShared':False},'caddyBeforeSha256':hashlib.sha256(original).hexdigest(),'caddyAfterSha256':hashlib.sha256(original if supervised_edge else candidate).hexdigest(),'chatgptConnected':False,'paidCalls':0}
    write(backup/'receipt.json',json.dumps(receipt,indent=2));write(base/'current-receipt.json',json.dumps(receipt,indent=2));print(json.dumps(receipt))
except Exception:
    if routed and caddy.read_bytes()==candidate:
        write(caddy,original,caddymode);run(['caddy','validate','--config',str(caddy)],quiet=True);run(['systemctl','reload','caddy'])
    if started:
        run(['docker','stop','vertux-lead-intelligence']);run(['docker','rm','vertux-lead-intelligence'])
    subprocess.run(['systemctl','disable','--now','vertux-lead-browser.service'],capture_output=True)
    if pathlib.Path(unitpath).read_text()==brokerunit:pathlib.Path(unitpath).unlink()
    subprocess.run(['systemctl','daemon-reload'],capture_output=True)
    raise
"""
    remote='import json\n'+remote.replace('p=PARAMS','p=json.loads('+repr(json.dumps(params))+')')
    result=json.loads(command(['python3','-'],remote).decode())
    destination=ROOT/'evidence/lead-intelligence';destination.mkdir(parents=True,exist_ok=True)
    (destination/('runtime-deployed.json' if args.activate else 'runtime-prepared.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='fileHashes'}))
finally:
    archivepath.unlink(missing_ok=True)
