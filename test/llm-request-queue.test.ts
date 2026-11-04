import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { ModelRequestQueue, ModelRequestQueueError } from "../src/llm/request-queue.js";

const endpoint = "https://fixture.invalid/v1";
const key = "fixture-credential";
const empty = { activeScopes: 0, waitingRequests: 0, retainedScopes: 0 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("request queue: same origin and credential serialize FIFO across endpoint paths", async () => {
  const queue = new ModelRequestQueue();
  const entered: number[] = [];
  const first = await queue.acquire(endpoint, key);
  const second = queue.acquire("https://FIXTURE.invalid/other", key).then(release => { entered.push(2); return release; });
  const third = queue.acquire(endpoint, key).then(release => { entered.push(3); return release; });
  await tick();
  assert.deepEqual(entered, []);
  assert.equal(queue.snapshot().waitingRequests, 2);
  first();
  const releaseSecond = await second;
  assert.deepEqual(entered, [2]);
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(entered, [2, 3]);
  releaseThird();
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: different origins or credentials can run independently", async () => {
  const queue = new ModelRequestQueue();
  const releases = await Promise.all([queue.acquire(endpoint, key), queue.acquire(endpoint, "another-fixture-credential"),
    queue.acquire("https://other.fixture.invalid/v1", key)]);
  assert.equal(queue.snapshot().activeScopes, 3);
  for (const release of releases) release();
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: cancelling a waiter removes it and its listener without blocking the next request", async () => {
  const queue = new ModelRequestQueue();
  const first = await queue.acquire(endpoint, key);
  const controller = new AbortController();
  const pending = queue.acquire(endpoint, key, controller.signal);
  const third = queue.acquire(endpoint, key);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(new Error("PRIVATE-CANCELLATION-DETAIL"));
  await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError"
    && !error.message.includes("PRIVATE-CANCELLATION-DETAIL"));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(queue.snapshot().waitingRequests, 1);
  first();
  (await third)();
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: pre-aborted acquisition retains no scope", async () => {
  const queue = new ModelRequestQueue();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(queue.acquire(endpoint, key, controller.signal), { name: "AbortError" });
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: response headers do not release a slot before body consumption or body failure", async () => {
  for (const fail of [false, true]) {
    const queue = new ModelRequestQueue();
    const body = deferred<string>();
    let headersArrived = false, secondStarted = false;
    const first = (async () => {
      const release = await queue.acquire(endpoint, key);
      try { headersArrived = true; return await body.promise; }
      finally { release(); }
    })();
    const handledFirst = fail ? assert.rejects(first, /fixture-body-error/) : first;
    await tick();
    const second = queue.acquire(endpoint, key).then(release => { secondStarted = true; release(); });
    await tick();
    assert.equal(headersArrived, true);
    assert.equal(secondStarted, false);
    if (fail) body.reject(new Error("fixture-body-error")); else body.resolve("consumed");
    await handledFirst;
    await second;
    assert.equal(secondStarted, true);
    assert.deepEqual(queue.snapshot(), empty);
  }
});

test("request queue: release is idempotent after handing a slot to the next owner", async () => {
  const queue = new ModelRequestQueue();
  const first = await queue.acquire(endpoint, key);
  const second = queue.acquire(endpoint, key);
  let thirdStarted = false;
  const third = queue.acquire(endpoint, key).then(release => { thirdStarted = true; return release; });
  first();
  const releaseSecond = await second;
  first();
  await tick();
  assert.equal(thirdStarted, false);
  releaseSecond();
  (await third)();
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: finite waiting timeout releases listeners and later admission remains possible", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const queue = new ModelRequestQueue({ maxWaitMs: 15 });
  const first = await queue.acquire(endpoint, key);
  const controller = new AbortController();
  const rejected = assert.rejects(queue.acquire(endpoint, key, controller.signal), error =>
    error instanceof ModelRequestQueueError && error.code === "queue_timeout");
  t.mock.timers.tick(15);
  await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(queue.snapshot().waitingRequests, 0);
  first();
  (await queue.acquire(endpoint, key))();
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: pending and scope bookkeeping are bounded with fixed safe errors", async () => {
  const queue = new ModelRequestQueue({ maxScopes: 1, maxWaitingPerScope: 1 });
  const first = await queue.acquire(endpoint, key);
  const waiting = queue.acquire(endpoint, key);
  const full = (error: unknown) => error instanceof ModelRequestQueueError && error.code === "queue_full"
    && !error.message.includes(key) && !error.message.includes("fixture.invalid");
  await assert.rejects(queue.acquire(endpoint, key), full);
  await assert.rejects(queue.acquire(endpoint, "other-fixture-credential"), full);
  first();
  (await waiting)();
  (await queue.acquire(endpoint, "other-fixture-credential"))();
  await assert.rejects(queue.acquire("PRIVATE-ENDPOINT", "PRIVATE-CREDENTIAL"), error =>
    error instanceof ModelRequestQueueError && error.code === "invalid_origin" && !error.message.includes("PRIVATE"));
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: default capacity permits only thirty-two waiting requests", async () => {
  const queue = new ModelRequestQueue();
  const first = await queue.acquire(endpoint, key);
  const waiting = Array.from({ length: 32 }, () => queue.acquire(endpoint, key).then(release => release()));
  await assert.rejects(queue.acquire(endpoint, key), error => error instanceof ModelRequestQueueError && error.code === "queue_full");
  first();
  await Promise.all(waiting);
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: waiting precedes the HTTP timeout budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const queue = new ModelRequestQueue();
  const first = await queue.acquire(endpoint, key);
  let httpStarted = false, timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const second = queue.acquire(endpoint, key).then(release => {
    httpStarted = true;
    timer = setTimeout(() => { timedOut = true; }, 60_000);
    return release;
  });
  t.mock.timers.tick(60_001);
  await flush();
  assert.equal(httpStarted, false);
  assert.equal(timedOut, false);
  first();
  const releaseSecond = await second;
  t.mock.timers.tick(59_999);
  assert.equal(timedOut, false, "HTTP gets its full budget after queue admission");
  clearTimeout(timer);
  releaseSecond();
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: conservative completion cooldown permits at most three starts per rolling minute", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const queue = new ModelRequestQueue({ minIntervalMs: 20_100 });
  const starts: number[] = [];
  const first = await queue.acquire(endpoint, key);
  starts.push(Date.now());
  // Real work and image preparation can delay a provider POST after admission.
  t.mock.timers.tick(5_000);
  first();
  const later = [1, 2, 3].map(() => queue.acquire(endpoint, key).then(release => { starts.push(Date.now()); release(); }));
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(20_100); await flush(); }
  await Promise.all(later);
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 20_100);
  for (const end of starts) assert.ok(starts.filter(start => start > end - 60_000 && start <= end).length <= 3);
  t.mock.timers.tick(20_100);
  await flush();
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: cancelling cooldown wait preserves pacing and idle cooldown is cleaned", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const queue = new ModelRequestQueue({ minIntervalMs: 20 });
  (await queue.acquire(endpoint, key))();
  const controller = new AbortController();
  const cancelled = assert.rejects(queue.acquire(endpoint, key, controller.signal), { name: "AbortError" });
  controller.abort();
  await cancelled;
  assert.deepEqual(queue.snapshot(), { activeScopes: 0, waitingRequests: 0, retainedScopes: 1 });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  let started = false;
  const next = queue.acquire(endpoint, key).then(release => { started = true; release(); });
  t.mock.timers.tick(19);
  await flush();
  assert.equal(started, false);
  t.mock.timers.tick(1);
  await next;
  t.mock.timers.tick(20);
  await flush();
  assert.deepEqual(queue.snapshot(), empty);
});

test("request queue: timed-out cooldown wait does not leave a timer or scope indefinitely", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const queue = new ModelRequestQueue({ minIntervalMs: 50, maxWaitMs: 10 });
  (await queue.acquire(endpoint, key))();
  const rejected = assert.rejects(queue.acquire(endpoint, key), error =>
    error instanceof ModelRequestQueueError && error.code === "queue_timeout");
  t.mock.timers.tick(10);
  await rejected;
  assert.equal(queue.snapshot().waitingRequests, 0);
  t.mock.timers.tick(40);
  await flush();
  assert.deepEqual(queue.snapshot(), empty);
});
