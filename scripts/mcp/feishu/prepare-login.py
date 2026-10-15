import os,subprocess,json,pathlib
base=pathlib.Path('/opt/qq-group-bot-mcp/feishu')
env=dict(os.environ)
for line in (base/'.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);env[k]=v.strip().strip('"').strip("'")
configdir=base/'cli-config';configdir.mkdir(mode=0o700,exist_ok=True)
env['LARKSUITE_CLI_CONFIG_DIR']=str(configdir)
env['HOME']=str(configdir)
env.pop('OPENCLAW_HOME',None);env.pop('HERMES_HOME',None)
cli='/opt/qq-group-bot-mcp/feishu-cli/node_modules/.bin/lark-cli'
p=subprocess.run([cli,'config','init','--app-id',env['FEISHU_APP_ID'],'--app-secret-stdin','--brand','feishu','--lang','zh','--name','qqbot'],input=env['FEISHU_APP_SECRET']+'\n',env=env,text=True,capture_output=True)
(base/'login-prepare.private.log').write_text(p.stdout+p.stderr)
os.chmod(base/'login-prepare.private.log',0o600)
print('INIT_CONFIG',p.returncode,'CONFIG_FILE',str(configdir/'config.json'),'LOG_BYTES',len(p.stdout+p.stderr))
if p.returncode:raise SystemExit(p.returncode)
p=subprocess.run([cli,'config','set','dpop','disabled'],env=env,text=True,capture_output=True)
print('DPOP_CONFIG',p.returncode)
(base/'login-dpop.private.log').write_text(p.stdout+p.stderr);os.chmod(base/'login-dpop.private.log',0o600)
