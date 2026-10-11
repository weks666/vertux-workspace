"""Install the isolated personal ChatGPT host on the existing AI machine.

Default is source staging plus isolated fixtures. --apply creates only the new
service and exact nginx route; keeps rollback, existing services and their keys.
Requires owner sign-in afterwards. No credentials or model responses are logged.
"""
import argparse,hashlib,io,json,pathlib,tarfile
import paramiko

ROOT=pathlib.Path(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('--key',required=True);ap.add_argument('--apply',action='store_true');args=ap.parse_args()
files={str(p.relative_to(ROOT)).replace('\\','/'):p.read_bytes() for p in sorted((ROOT/'lead-server').glob('*.mjs'))}
files['tests/lead-chatgpt-host.test.mjs']=(ROOT/'tests/lead-chatgpt-host.test.mjs').read_bytes()
files['deploy/lead-chatgpt-route.conf']=(ROOT/'deploy/lead-chatgpt-route.conf').read_bytes()
dependency=ROOT/'node_modules/jose'
if json.loads((dependency/'package.json').read_text())['version']!='6.2.12':raise SystemExit('Pinned jose dependency required')
for p in sorted(dependency.rglob('*')):
 if p.is_file():files[str(p.relative_to(ROOT)).replace('\\','/')]=p.read_bytes()
hashes={name:hashlib.sha256(data).hexdigest() for name,data in files.items()}
bundle=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()
release='/opt/vertux-lead-chatgpt/releases/'+bundle[:16]
client=paramiko.SSHClient();client.load_system_host_keys();client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect('31.44.4.244',username='root',key_filename=args.key,look_for_keys=False,allow_agent=False,timeout=15)
sftp=client.open_sftp()
def mkdir(path):
 try:sftp.stat(path)
 except IOError:
  parent=path.rsplit('/',1)[0]
  if parent:mkdir(parent)
  sftp.mkdir(path,0o755)
try:
 archive=io.BytesIO()
 with tarfile.open(fileobj=archive,mode='w:gz') as tar:
  for name,data in files.items():
   item=tarfile.TarInfo(name);item.size=len(data);item.mode=0o644;tar.addfile(item,io.BytesIO(data))
 mkdir(release);archive.seek(0);sftp.putfo(archive,release+'/source.tar.gz');sftp.chmod(release+'/source.tar.gz',0o600)
 params={'release':release,'hashes':hashes,'bundle':bundle,'apply':args.apply}
 remote=r'''
import os,json,pathlib,subprocess,hashlib,datetime,time,stat,fcntl,socket,secrets,tarfile,urllib.request,urllib.error
os.umask(0o077)
p=PARAMS
NAME='vertux-lead-chatgpt';ROOT=pathlib.Path('/opt/vertux-lead-chatgpt');RELEASE=pathlib.Path(p['release'])
IMAGE='sha256:668007852cc04f9120189e4a1f52afc27d6ee834e3b9f04f2d1d8acaf169e4dd'
NGINX=pathlib.Path('/etc/nginx/sites-available/n8n');EXPECTED='59ece7c706c63a873c5d23e8ebf6adad36f85e3218a81f5c3f8c04b0f62b8bc8'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def run(argv,timeout=60):
 out=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 need(out.returncode==0,'command_failed_'+pathlib.Path(argv[0]).name);return out.stdout
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def write(path,data,mode=0o600):
 path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data if isinstance(data,bytes) else data.encode());path.chmod(mode)
def get(url,data=None,headers=None):
 req=urllib.request.Request(url,data=data,headers=headers or {})
 try:
  with urllib.request.urlopen(req,timeout=10) as r:return r.status,r.read(65536)
 except urllib.error.HTTPError as r:return r.code,r.read(65536)
def main():
 lock=os.open('/run/lock/vertux-lead-chatgpt-deploy.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 with tarfile.open(str(RELEASE/'source.tar.gz'),'r:gz') as tar:
  members=tar.getmembers();need(set(m.name for m in members)==set(p['hashes']) and len(members)==len(p['hashes']),'archive_inventory_mismatch')
  for item in members:
   need(item.isfile() and not item.name.startswith('/') and '..' not in pathlib.PurePosixPath(item.name).parts,'unsafe_source_path')
   target=RELEASE/item.name;target.parent.mkdir(parents=True,exist_ok=True);target.parent.chmod(0o755);target.write_bytes(tar.extractfile(item).read());target.chmod(0o644)
 for name,digest in p['hashes'].items():need(hashlib.sha256((RELEASE/name).read_bytes()).hexdigest()==digest,'source_hash_mismatch')
 need(inspect('vertux-workspace-trainer')['Image']==IMAGE,'existing_node_image_changed')
 previous=ROOT/'current-receipt.json'
 if previous.exists():
  receipt=json.loads(previous.read_text());need(receipt['bundleSha256']==p['bundle'] and inspect(NAME)['State']['Running'],'existing_service_requires_review');print(json.dumps(receipt));return
 need(hashlib.sha256(NGINX.read_bytes()).hexdigest()==EXPECTED,'shared_nginx_changed')
 need(subprocess.run(['docker','inspect',NAME],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode!=0,'service_already_exists')
 common=['--network','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--memory-swap','128m','--cpus','0.35','--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--mount','type=bind,src='+str(RELEASE)+',dst=/app,readonly','--entrypoint','node']
 run(['docker','run','--rm']+common+[IMAGE,'--test','/app/tests/lead-chatgpt-host.test.mjs'],timeout=90)
 if not p['apply']:
  print(json.dumps({'status':'PERSONAL_CHATGPT_HOST_PREPARED','bundleSha256':p['bundle'],'isolatedTests':10}));return
 for port in (47922,47923):
  s=socket.socket();need(s.connect_ex(('127.0.0.1',port))!=0,'loopback_port_in_use');s.close()
 others={n:inspect(n)['Id'] for n in ('n8n','vertux-workspace-trainer','vertux-invest-ai','amnezia-awg2')}
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 backup=pathlib.Path('/var/backups/vertux-lead-chatgpt')/stamp;backup.mkdir(parents=True,mode=0o700)
 old=NGINX.read_bytes();write(backup/'nginx.conf',old)
 config=pathlib.Path('/etc/vertux-lead-chatgpt');config.mkdir(mode=0o700,exist_ok=True);config.chmod(0o700)
 keyfile=config/'caller.key'
 if keyfile.exists():need(stat.S_IMODE(keyfile.stat().st_mode)==0o600 and keyfile.stat().st_uid==0,'unsafe_existing_caller_key');key=keyfile.read_text().strip()
 else:key=secrets.token_hex(32);write(keyfile,key)
 need(len(key)==64 and all(ch in '0123456789abcdef' for ch in key),'invalid_caller_key')
 state=pathlib.Path('/var/lib/vertux-lead-chatgpt');state.mkdir(mode=0o700,exist_ok=True);state.chmod(0o700);os.chown(str(state),1000,1000)
 write(config/'runtime.env','LEAD_CHATGPT_REMOTE_KEY='+key+'\nLEAD_CHATGPT_DIRECTORY=/state/chatgpt\nLEAD_MAX_DAILY_PLAN_REQUESTS=10\n')
 route=config/'route.conf';write(route,(RELEASE/'deploy/lead-chatgpt-route.conf').read_bytes(),0o644)
 anchor='    server_name zxcqweksn8n.duckdns.org;';text=old.decode();need(text.count(anchor)==2,'unexpected_nginx_layout')
 candidate=text.replace(anchor,anchor+'\n    include '+str(route)+';',1).encode();started=False
 try:
  cmd=['docker','run','-d','--name',NAME,'--restart','unless-stopped','--label','online.vertux.lead.chatgpt.bundle='+p['bundle'],'--network','host','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--memory-swap','128m','--cpus','0.35','--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--log-opt','max-size=2m','--log-opt','max-file=2','--env-file',str(config/'runtime.env'),'--mount','type=bind,src='+str(RELEASE)+',dst=/app,readonly','--mount','type=bind,src='+str(state)+',dst=/state','--entrypoint','node',IMAGE,'/app/lead-server/chatgpt-host.mjs']
  run(cmd);started=True
  for attempt in range(25):
   try:
    if get('http://127.0.0.1:47923/health')[0]==200:break
   except:pass
   time.sleep(.4)
  else:raise RuntimeError('host_not_healthy')
  need(get('http://127.0.0.1:47923/webhook/vertux-lead-chatgpt',b'{"action":"status"}',{'Content-Type':'application/json'})[0]==401,'missing_caller_accepted')
  code,raw=get('http://127.0.0.1:47923/webhook/vertux-lead-chatgpt',b'{"action":"status"}',{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
  need(code==200 and json.loads(raw)['result']['connected'] is False,'owner_sign_in_state_unexpected')
  need(get('http://127.0.0.1:47922/')[0]==200,'oauth_helper_unavailable')
  # Restart verifies protected host state and ledger initialization with no login.
  run(['docker','restart','--time','20',NAME])
  for attempt in range(25):
   try:
    if get('http://127.0.0.1:47923/health')[0]==200:break
   except:pass
   time.sleep(.4)
  else:raise RuntimeError('host_restart_failed')
  need(NGINX.read_bytes()==old,'nginx_changed_during_staging');write(NGINX,candidate,0o644);run(['nginx','-t']);run(['systemctl','reload','nginx'])
  need(get('https://zxcqweksn8n.duckdns.org/webhook/vertux-lead-chatgpt',b'{"action":"status"}',{'Content-Type':'application/json'})[0]==403,'network_caller_gate_failed')
  for name,cid in others.items():need(inspect(name)['Id']==cid and inspect(name)['State']['Running'],'existing_service_changed')
  receipt={'status':'PERSONAL_CHATGPT_HOST_DEPLOYED_LOGIN_PENDING','at':stamp,'image':IMAGE,'containerId':inspect(NAME)['Id'],'bundleSha256':p['bundle'],'fileHashes':p['hashes'],'release':str(RELEASE),'backupPath':str(backup),'nginxBeforeSha256':EXPECTED,'nginxAfterSha256':hashlib.sha256(candidate).hexdigest(),'isolatedTests':10,'memoryLimitMb':128,'dailyRequestCap':10,'modelRequests':0,'ownerSignInVerified':False,'existingContainersUnchanged':True}
  write(previous,json.dumps(receipt,indent=2));print(json.dumps(receipt))
 except:
  if NGINX.read_bytes()==candidate:write(NGINX,old,0o644);run(['nginx','-t']);run(['systemctl','reload','nginx'])
  if started:run(['docker','stop','--time','20',NAME]);run(['docker','rename',NAME,NAME+'-failed-'+stamp])
  raise
try:main()
except Exception as error:
 import traceback
 print(json.dumps({'status':'FAILED','code':str(error) if isinstance(error,RuntimeError) else type(error).__name__,'line':traceback.extract_tb(error.__traceback__)[-1].lineno}));raise SystemExit(1)
'''.replace('PARAMS',repr(params))
 stdin,stdout,stderr=client.exec_command('python3 -',timeout=180)
 stdin.write(remote);stdin.channel.shutdown_write();output=stdout.read();errors=stderr.read();rc=stdout.channel.recv_exit_status()
 if rc:raise RuntimeError('Host preparation failed: '+output.decode(errors='replace')[:500])
 result=json.loads(output);out=ROOT/'evidence/lead-intelligence/chatgpt-host-deployed.json' if args.apply else ROOT/'evidence/lead-intelligence/chatgpt-host-prepared.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,indent=2),encoding='utf-8')
 print(json.dumps({k:v for k,v in result.items() if k!='fileHashes'}))
finally:sftp.close();client.close()
