"""Bounded deployment to the existing AI host using its installed Node 24 image.
Private environment and persistent budget must already exist; neither is printed.
"""
import argparse,hashlib,json,pathlib,posixpath,shlex,time,datetime,urllib.request,urllib.error
import paramiko
ROOT=pathlib.Path(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('--host',required=True);ap.add_argument('--key',required=True);a=ap.parse_args()
files={p.name:p.read_text(encoding='utf-8').encode() for p in sorted((ROOT/'trainer-server').glob('*.mjs'))}
hashes={k:hashlib.sha256(v).hexdigest() for k,v in files.items()};bundle=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');name='vertux-workspace-trainer'
c=paramiko.SSHClient();c.load_system_host_keys();c.set_missing_host_key_policy(paramiko.RejectPolicy());c.connect(a.host,username='root',key_filename=a.key,look_for_keys=False,allow_agent=False,timeout=15);s=c.open_sftp()
def command(argv,body=None):
 i,o,e=c.exec_command(shlex.join(argv))
 if body is not None:i.write(body);i.channel.shutdown_write()
 out=o.read();err=e.read();code=o.channel.recv_exit_status()
 if code:raise RuntimeError('command failed: '+argv[0]+' '+err.decode(errors='replace').splitlines()[0][:120] if err else 'command failed')
 return out
def mkdir(path,mode):
 try:s.mkdir(path,mode=mode)
 except IOError:pass
 s.chmod(path,mode)
def write(path,value,mode=0o600):
 with s.open(path,'w') as f:f.write(value)
 s.chmod(path,mode)
def read(path):
 with s.open(path,'rb') as f:return f.read()
root='/opt/vertux-workspace-trainer';release=root+'/releases/'+stamp+'-'+bundle[:12]
backup='/var/backups/vertux-workspace-trainer/'+stamp;nginx='/etc/nginx/sites-available/n8n'
old=None;candidate=None;started=False
try:
 env=s.stat('/etc/vertux-workspace-trainer/runtime.env')
 if env.st_size==0 or env.st_mode&0o077:raise RuntimeError('Unsafe or empty runtime environment')
 command(['docker','exec','n8n','node','-e',"if(!process.versions.node.startsWith('24.'))process.exit(1)"])
 image=command(['docker','inspect','--format','{{.Image}}','n8n']).decode().strip()
 existing=json.loads(command(['docker','ps','-a','--filter','name=^/'+name+'$','--format','json']).decode() or '{}')
 if existing:raise RuntimeError('Existing trainer container requires an explicit versioned replacement')
 for path,mode in [(root,0o755),(root+'/releases',0o755),(release,0o755),('/var/backups/vertux-workspace-trainer',0o700),(backup,0o700)]:mkdir(path,mode)
 for f,content in files.items():
  write(release+'/'+f,content,0o644)
  if hashlib.sha256(read(release+'/'+f)).hexdigest()!=hashes[f]:raise RuntimeError('Runtime checksum mismatch')
 old=read(nginx);write(backup+'/nginx.conf',old)
 route='/etc/vertux-workspace-trainer/route.conf';write(route,(ROOT/'deploy/trainer-node-route.conf').read_bytes(),0o644)
 anchor='    server_name zxcqweksn8n.duckdns.org;';text=old.decode();include='    include '+route+';'
 if text.count(anchor)!=2 or include in text:raise RuntimeError('Unexpected n8n host routing')
 candidate=text.replace(anchor,anchor+'\n'+include,1).encode()
 command(['docker','run','-d','--name',name,'--restart','unless-stopped','--network','host','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','64','--memory','256m','--cpus','1','--log-opt','max-size=5m','--log-opt','max-file=2','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--env-file','/etc/vertux-workspace-trainer/runtime.env','--mount','type=bind,src='+release+',dst=/app,readonly','--mount','type=bind,src=/var/lib/vertux-workspace-trainer,dst=/state','--entrypoint','node',image,'/app/run.mjs']);started=True
 probe="fetch('http://127.0.0.1:4196/webhook/vertux-ai-trainer',{method:'POST',headers:{Origin:'https://weks666.github.io','Content-Type':'application/json'},body:'{\"mode\":\"health\"}'}).then(r=>{if(r.status!==401)process.exit(1)}).catch(()=>process.exit(1));"
 for attempt in range(10):
  try:command(['docker','exec',name,'node','-e',probe]);break
  except RuntimeError:
   if attempt==9:raise
   time.sleep(.2)
 if read(nginx)!=old:raise RuntimeError('nginx changed during preparation')
 write(nginx,candidate,0o644);command(['nginx','-t']);command(['systemctl','reload','nginx'])
 for attempt in range(12):
  req=urllib.request.Request('https://zxcqweksn8n.duckdns.org/webhook/vertux-ai-trainer',data=b'{"mode":"health"}',headers={'Origin':'https://weks666.github.io','Content-Type':'application/json'})
  try:urllib.request.urlopen(req,timeout=10);raise RuntimeError('Public route accepted missing authorization')
  except urllib.error.HTTPError as e:
   if e.code==401 and e.headers.get('X-Vertux-Trainer')=='v1':break
   if e.headers.get('X-Vertux-Trainer')=='v1' or attempt==11:raise RuntimeError('Public route HTTP '+str(e.code))
   time.sleep(.3)
 receipt={'status':'AI_HOST_DEPLOYED_AUTH_LOCKED','deployedAt':stamp,'image':image,'runtimePath':release,'bundleSha256':bundle,'fileHashes':hashes,'backupPath':backup,'nginxBeforeSha256':hashlib.sha256(old).hexdigest(),'nginxAfterSha256':hashlib.sha256(candidate).hexdigest(),'sourceServiceDisabled':True,'budgetPreserved':True,'publicEndpoint':'https://zxcqweksn8n.duckdns.org/webhook/vertux-ai-trainer','missingAuthStatus':401,'paidCalls':0}
 write(backup+'/receipt.json',json.dumps(receipt,indent=2).encode());print(json.dumps(receipt))
except Exception as e:
 if old is not None and candidate is not None and read(nginx)==candidate:
  write(nginx,old,0o644);command(['nginx','-t']);command(['systemctl','reload','nginx'])
 if started:command(['docker','stop',name])
 print(json.dumps({'ok':False,'reason':str(e)[:220]}));raise SystemExit(1)
finally:s.close();c.close()
