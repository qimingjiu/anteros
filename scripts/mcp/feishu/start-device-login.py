import os,subprocess,json,pathlib,time
base=pathlib.Path('/opt/qq-group-bot-mcp/feishu')
env=dict(os.environ)
for line in (base/'.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);env[k]=v.strip().strip('"').strip("'")
env['LARKSUITE_CLI_CONFIG_DIR']=str(base/'cli-config');env['HOME']=str(base/'cli-config')
accept=json.loads((base/'acceptance.json').read_text())
prefixes=('docx:','docs:','drive:','space:','base:','sheets:','slides:','wiki:','mail:')
scopes=sorted(set(x['name'] for x in accept['scopeStatus']['scopes'] if x.get('type')=='user' and x['name'].startswith(prefixes)))+['offline_access']
p=subprocess.run(['/opt/qq-group-bot-mcp/feishu-cli/node_modules/.bin/lark-cli','auth','login','--scope',' '.join(scopes),'--no-wait','--json'],env=env,text=True,capture_output=True)
path=base/'device-login.private.json'
path.write_text(p.stdout);os.chmod(path,0o600)
(base/'device-login.private.stderr').write_text(p.stderr);os.chmod(base/'device-login.private.stderr',0o600)
print('AUTH_INIT_EXIT',p.returncode,'BYTES',len(p.stdout),len(p.stderr),'REQUESTED_SCOPE_COUNT',len(scopes))
if p.returncode:raise SystemExit(p.returncode)
try:r=json.loads(p.stdout)
except:print('AUTH_INIT_JSON_FAILED');raise SystemExit(1)
print('AUTH_INIT_KEYS',list(r.keys()))
def strip(x):
 if isinstance(x,dict):return {k:strip(v) for k,v in x.items() if k in ['data','verification_uri','verification_uri_complete','verification_url','user_code','expires_in','interval','scope','message','ok']}
 return x
public=strip(r);public['started_at']=int(time.time())
(base/'device-login.public.json').write_text(json.dumps(public,ensure_ascii=False,indent=2))
print('AUTH_INIT_PUBLIC',json.dumps(public,ensure_ascii=False))
verification=public.get('verification_url')
if verification:
 qr='/tmp/qqbot-feishu-login.png'
 p=subprocess.run(['/opt/qq-group-bot-mcp/feishu-cli/node_modules/.bin/lark-cli','auth','qrcode',verification,'--output',qr,'--size','384'],env=env,text=True,capture_output=True)
 print('AUTH_QR',p.returncode,qr if p.returncode==0 else 'unavailable')
