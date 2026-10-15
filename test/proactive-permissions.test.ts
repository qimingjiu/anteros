import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Database} from '../src/db/index.js';
import {loadConfig} from '../src/config.js';
import {Gateway} from '../src/gateway/index.js';
import {Agent} from '../src/agent/index.js';
import {MockLLMClient} from '../src/llm/index.js';
import type {Provider, MessageRecord} from '../src/types.js';
import type {McpManager} from '../src/tools/mcp.js';
import type {OpenMeteoWeather} from '../src/tools/weather.js';
import type {ProactiveEngine} from '../src/proactive/index.js';

test('天气和主动控制：群聊私聊均只给所有者，执行时按真实发送者再次检查', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const cfg = loadConfig(fileURLToPath(new URL('../config.sim.yaml', import.meta.url)));
  cfg.tools.enabled = true; cfg.tools.ownerIds = ['10001']; cfg.groups.allowlist = ['100'];
  let forecasts = 0, controls = 0;
  const agent = new Agent({db, cfg, gateway: {getProvider: () => ({health: () => ({selfId: 'bot'})})} as unknown as Gateway,
    llm: new MockLLMClient(), memory: null, search: null, reader: null, mcp: {getTools: () => []} as unknown as McpManager,
    weather: {getForecast: async () => {forecasts++; return {location: {name: '长沙市'}, hourly: []};}} as unknown as OpenMeteoWeather,
    proactiveEngine: {control: () => {controls++; return 'paused';}} as unknown as ProactiveEngine, timezone: cfg.timezone});
  const inspect = agent as unknown as {availableTools(m: MessageRecord): {name: string}[]; executeTool(name: string, json: string, m: MessageRecord): Promise<string>};
  const message = (owner: boolean, group: boolean): MessageRecord => ({eventKey: 'e', accountId: 'a', providerId: 'onebot',
    conversationId: group ? 'group_100' : 'private_10001', groupId: group ? '100' : undefined, messageId: '1',
    senderId: owner ? '10001' : 'other', displayNameAtTime: 'user', sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    segments: [], textContent: '查天气', status: 'active', origin: 'live'});
  for (const group of [false, true]) {
    assert.deepEqual(inspect.availableTools(message(true, group)).map(tool => tool.name), ['proactive_control', 'weather_forecast']);
    assert.equal(inspect.availableTools(message(false, group)).length, 0);
    await inspect.executeTool('weather_forecast', '{}', message(true, group));
    await inspect.executeTool('proactive_control', '{"action":"pause"}', message(true, group));
    await inspect.executeTool('weather_forecast', '{"requesterId":"10001"}', message(false, group));
    await inspect.executeTool('proactive_control', '{"action":"pause","requesterId":"10001"}', message(false, group));
  }
  assert.equal(forecasts, 2); assert.equal(controls, 2);
});

test('发送队列：过期主动消息不发送，普通消息仍可发送并回写上下文', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  let sends = 0;
  const provider = {providerId: 'fixture', health: () => ({connection: 'connected', login: 'online', selfId: 'bot'}),
    sendPrivateMsg: async () => {sends++; return {status: 'confirmed', messageId: `out${sends}`};}} as unknown as Provider;
  const gateway = new Gateway(db, provider, {accountId: 'acct', backfillMaxPages: 0, backfillPageLimit: 0});
  const execute = gateway as unknown as {executeSendTask(id: number): Promise<void>};
  const expired = gateway.enqueueSend({kind: 'proactive_random', conversationType: 'private', targetId: '10001',
    payload: {kind: 'segments', segments: [{type: 'text', data: {text: 'old'}}], expiresAt: new Date(Date.now() - 1).toISOString()}});
  await execute.executeSendTask(expired.id);
  assert.equal(sends, 0); assert.equal(db.sendTaskById(expired.id)?.status, 'failed');
  const ordinary = gateway.enqueueSend({kind: 'reply', conversationType: 'private', targetId: '10001',
    payload: {kind: 'segments', segments: [{type: 'text', data: {text: 'fresh'}}]}});
  await execute.executeSendTask(ordinary.id);
  assert.equal(sends, 1); assert.equal(db.recentMessages('private_10001', 5)[0]?.text_content, 'fresh');
});

test('崩溃恢复：发送中断的主动消息标unknown防止重复，普通回复继续恢复排队', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const proactive = db.enqueueSendTask({kind: 'proactive_morning', conversationType: 'private', targetId: 'owner', payload: {}});
  const reply = db.enqueueSendTask({kind: 'reply', conversationType: 'private', targetId: 'owner', payload: {}});
  db.claimSendTask(proactive.id); db.claimSendTask(reply.id);
  assert.deepEqual(db.resetInFlightTasks(), {requeued: 1, unknowned: 1});
  assert.equal(db.sendTaskById(proactive.id)?.status, 'unknown'); assert.equal(db.sendTaskById(reply.id)?.status, 'queued');
});
