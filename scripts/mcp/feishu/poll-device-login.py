import os,json,pathlib,time,urllib.request,urllib.parse,urllib.error
base=pathlib.Path('/opt/qq-group-bot-mcp/feishu')
credentials={}
for line in (base/'.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);credentials[k]=v.strip().strip('"').strip("'")
device=json.loads((base/'device-login.private.json').read_text())
public=json.loads((base/'device-login.public.json').read_text())
deadline=public['started_at']+device.get('expires_in',600)
interval=5
def status(value):
 (base/'device-status.public.json').write_text(json.dumps(value));print(json.dumps(value),flush=True)
status({'status':'waiting_for_user','deadline':deadline})
while time.time()<deadline:
 time.sleep(interval)
 req=urllib.request.Request('https://accounts.feishu.cn/oauth/v3/token',data=urllib.parse.urlencode({'grant_type':'urn:ietf:params:oauth:grant-type:device_code','device_code':device['device_code'],'client_id':credentials['FEISHU_APP_ID'],'client_secret':credentials['FEISHU_APP_SECRET']}).encode(),headers={'Content-Type':'application/x-www-form-urlencoded'})
 try:
  with urllib.request.urlopen(req,timeout=25) as response:result=json.load(response)
 except urllib.error.HTTPError as response:
  try:result=json.load(response)
  except:continue
 except:continue
 if result.get('access_token'):
  result['obtained_at']=int(time.time())
  tmp=base/'user-token.private.json.tmp';tmp.write_text(json.dumps(result));os.chmod(tmp,0o600);tmp.replace(base/'user-token.private.json')
  status({'status':'authorized','hasAccessToken':True,'hasRefreshToken':bool(result.get('refresh_token')),'expiresIn':result.get('expires_in'),'tokenType':result.get('token_type'),'scopeCount':len(result.get('scope','').split())});break
 error=result.get('error')
 if error=='authorization_pending':continue
 if error=='slow_down':interval=min(60,interval+5);continue
 status({'status':'failed','reason':error if error in ['expired_token','invalid_grant','access_denied'] else 'upstream_error','code':result.get('code')});break
else:status({'status':'expired'})
