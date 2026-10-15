import {test} from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {Agent} from "undici";

// Node's built-in fetch and the installed dispatcher's protocol can differ.
// Exercise a real local socket so an incompatible major version cannot be
// hidden by the web policy tests' mocked fetch implementation.
test("installed Undici Agent is compatible with this Node built-in fetch", async t=>{
  const server=http.createServer((_request,response)=>{response.writeHead(200,{"Content-Type":"text/plain"});response.end("fixture");});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const dispatcher=new Agent();
  t.after(async()=>{await dispatcher.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address && typeof address==="object");
  const response=await fetch(`http://127.0.0.1:${address.port}/`,{dispatcher,signal:AbortSignal.timeout(3000)} as RequestInit);
  assert.equal(response.status,200);assert.equal(await response.text(),"fixture");
});
