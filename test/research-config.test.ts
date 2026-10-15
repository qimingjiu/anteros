import {test, type TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import YAML from "yaml";
import {loadConfig} from "../src/config.js";

function config(t:TestContext, mutate:(raw:Record<string,any>)=>void) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"research-config-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const raw=YAML.parse(fs.readFileSync(fileURLToPath(new URL("../config.sim.yaml",import.meta.url)),"utf8"));
  raw.tools??={};raw.tools.search??={};raw.tools.reader??={};raw.tools.research??={};
  mutate(raw);
  const filename=path.join(directory,"config.yaml");fs.writeFileSync(filename,YAML.stringify(raw));
  return ()=>loadConfig(filename);
}
test("web research defaults preserve old configs and enforce conservative free allowances",t=>{
  const cfg=config(t,()=>{})();
  assert.equal(cfg.tools.research?.limits.maxQueries,3);
  assert.equal(cfg.tools.research?.limits.maxBrowserRenders,2);
  assert.equal(cfg.tools.research?.quotas.tavily?.monthly,600);
  assert.equal(cfg.tools.research?.quotas.exa?.monthly,4);
});
test("self-hosted endpoints must remain loopback roots with no credentials or query",t=>{
  for(const url of ["https://example.com","http://169.254.169.254","http://user:pass@127.0.0.1:8787","http://127.0.0.1:8787/evil","http://127.0.0.1:8787/?key=private"]){
    assert.throws(config(t,raw=>{raw.tools.reader.crawl4ai_url=url;}),/仅监听本机/);
  }
  assert.equal(config(t,raw=>{raw.tools.search.searxng_url="http://127.0.0.1:8888";raw.tools.search.provider="searxng";})().tools.search.searxngUrl,"http://127.0.0.1:8888");
});
test("configuration cannot enable paid mode or allowances above the free monthly ceiling",t=>{
  assert.throws(config(t,raw=>{raw.tools.research.free_only=false;}),/保持 true/);
  assert.throws(config(t,raw=>{raw.tools.research.quotas={exa:{monthly:11}};}),/0 到 10/);
  assert.throws(config(t,raw=>{raw.tools.research.quotas={firecrawl:{monthly:1001}};}),/0 到 1000/);
  assert.throws(config(t,raw=>{raw.tools.research.budget={max_browser_renders:-1};}),/0 到 4/);
});
test("new provider configuration is allowlisted and zero cloud budget is supported",t=>{
  assert.throws(config(t,raw=>{raw.tools.search.fallback_providers=["arbitrary_http"];}),/不支持/);
  const cfg=config(t,raw=>{raw.tools.search.provider="exa";raw.tools.research.budget={max_cloud_extractions:0,max_browser_renders:0};})();
  assert.equal(cfg.tools.research?.limits.maxCloudExtractions,0);
  assert.equal(cfg.tools.research?.limits.maxBrowserRenders,0);
});
