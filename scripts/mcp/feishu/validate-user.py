import json,pathlib,urllib.request,urllib.error,hmac,os,time
base=pathlib.Path('/opt/qq-group-bot-mcp/feishu')
if not (base/'user-token.private.json').exists():print('USER_IDENTITY',json.dumps({'authorized':False,'reason':'pending'}));raise SystemExit(2)
env={}
for line in (base/'.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);env[k]=v.strip().strip('"').strip("'")
token=json.loads((base/'user-token.private.json').read_text())
req=urllib.request.Request('https://open.feishu.cn/open-apis/authen/v1/user_info',headers={'Authorization':'Bearer '+token['access_token']})
try:
 with urllib.request.urlopen(req,timeout=25) as response:identity=json.load(response)
except:print('USER_IDENTITY',json.dumps({'authorized':True,'identityMatched':False,'reason':'identity_check_failed'}));raise SystemExit(3)
expected=env.get('FEISHU_EXPECTED_USER_OPEN_ID','')
actual=identity.get('data',{}).get('open_id','')
matched=bool(expected and actual and hmac.compare_digest(expected,actual))
result={'authorized':True,'identityMatched':matched,'code':identity.get('code'),'tokenType':token.get('token_type'),'hasRefreshToken':bool(token.get('refresh_token')),'scopeCount':len(token.get('scope','').split())}
print('USER_IDENTITY',json.dumps(result))
if matched:
 p=base/'user-token.enabled.json';p.write_text(json.dumps({'identityMatched':True,'verifiedAt':int(time.time())}));os.chmod(p,0o600)
 p=base/'user-acceptance.public.json';p.write_text(json.dumps(result))
else:raise SystemExit(4)
