"""Update the already registered exact Workspace trainer route, with rollback."""
import argparse,datetime,hashlib,json,pathlib,shlex,time,urllib.request,urllib.error
import paramiko
ROOT=pathlib.Path(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('--host',required=True);ap.add_argument('--key',required=True);a=ap.parse_args()
c=paramiko.SSHClient();c.load_system_host_keys();c.set_missing_host_key_policy(paramiko.RejectPolicy());c.connect(a.host,username='root',key_filename=a.key,look_for_keys=False,allow_agent=False,timeout=15);s=c.open_sftp()
path='/etc/vertux-workspace-trainer/route.conf';candidate=(ROOT/'deploy/trainer-route.conf').read_bytes()
def read(p):
 with s.open(p,'rb') as f:return f.read()
def write(p,b):
 with s.open(p,'w') as f:f.write(b)
 s.chmod(p,0o600)
def command(argv):
 _,o,e=c.exec_command(shlex.join(argv));rc=o.channel.recv_exit_status()
 if rc:raise RuntimeError('gateway command failed: '+argv[0])
old=read(path)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup='/var/backups/vertux-workspace-trainer/gateway-'+stamp+'.conf'
try:
 if b'include /etc/vertux-workspace-trainer/route.conf;' not in read('/etc/nginx/sites-available/vertux-production.conf'):raise RuntimeError('Exact route include is missing')
 write(backup,old)
 if read(path)!=old:raise RuntimeError('Route changed concurrently')
 write(path,candidate);command(['nginx','-t']);command(['systemctl','reload','nginx'])
 for attempt in range(12):
  req=urllib.request.Request('https://nexus.vertux.online/api/workspace-trainer',data=b'{"mode":"health"}',headers={'Origin':'https://weks666.github.io','Content-Type':'application/json'})
  try:urllib.request.urlopen(req,timeout=10);raise RuntimeError('Missing auth accepted')
  except urllib.error.HTTPError as e:
   if e.code==401 and e.headers.get('X-Vertux-Trainer')=='v1':break
   if attempt==11:raise RuntimeError('Gateway verification failed: '+str(e.code))
   time.sleep(.3)
 print(json.dumps({'status':'TRAINER_GATEWAY_VERIFIED','updatedAt':stamp,'endpoint':'https://nexus.vertux.online/api/workspace-trainer','upstream':'https://zxcqweksn8n.duckdns.org/webhook/vertux-ai-trainer','tlsVerification':True,'missingAuthStatus':401,'backupPath':backup,'beforeSha256':hashlib.sha256(old).hexdigest(),'afterSha256':hashlib.sha256(candidate).hexdigest()}))
except Exception as e:
 if read(path)==candidate:write(path,old);command(['nginx','-t']);command(['systemctl','reload','nginx'])
 print(json.dumps({'ok':False,'reason':str(e)}));raise SystemExit(1)
finally:s.close();c.close()
