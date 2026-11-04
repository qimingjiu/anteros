import { createHash } from "node:crypto";

type QueueFailureCode = "invalid_origin" | "queue_full" | "queue_timeout";

/** Fixed messages only; request locations and credentials never enter queue errors. */
export class ModelRequestQueueError extends Error {
  override name = "ModelRequestQueueError";
  constructor(readonly code: QueueFailureCode) {
    super(code === "queue_full" ? "模型请求等待队列已满" : code === "queue_timeout" ? "模型请求排队超时" : "模型请求地址无效");
  }
}

export interface ModelRequestQueueOptions {
  maxScopes?: number;
  maxWaitingPerScope?: number;
  maxWaitMs?: number;
  /** Minimum cooldown after response completion; zero by default for generic queues. */
  minIntervalMs?: number;
  now?: () => number;
}
interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface ScopeState {
  active: boolean;
  waiting: Waiter[];
  nextStartAt: number;
  wakeTimer?: ReturnType<typeof setTimeout>;
}

const cancelled = (): Error => new DOMException("模型请求排队已取消", "AbortError");
const positive = (value: number | undefined, fallback: number): number =>
  Number.isSafeInteger(value) && value! > 0 ? value! : fallback;

function scopeHash(baseUrl: string, credential: string): string {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new ModelRequestQueueError("invalid_origin"); }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new ModelRequestQueueError("invalid_origin");
  return createHash("sha256").update(endpoint.origin).update("\0").update(credential).digest("hex");
}

/** One active request per origin and credential, with bounded waiting and optional pacing. */
export class ModelRequestQueue {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly maxScopes: number;
  private readonly maxWaitingPerScope: number;
  private readonly maxWaitMs: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  constructor(options: ModelRequestQueueOptions = {}) {
    this.maxScopes = positive(options.maxScopes, 128);
    this.maxWaitingPerScope = positive(options.maxWaitingPerScope, 32);
    this.maxWaitMs = Math.min(positive(options.maxWaitMs, 120_000), 2_147_483_647);
    this.minIntervalMs = Number.isSafeInteger(options.minIntervalMs) && options.minIntervalMs! >= 0
      ? Math.min(options.minIntervalMs!, 2_147_483_647) : 0;
    this.now = options.now ?? (() => Date.now());
  }

  // Hash synchronously before returning a promise, so queued bookkeeping does
  // not retain the caller's plaintext credential or endpoint.
  acquire(baseUrl: string, credential: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    let key: string;
    try { key = scopeHash(baseUrl, credential); }
    catch (error) { return Promise.reject(error); }
    return this.acquireHashed(key, signal);
  }

  /** Counts only; neither scope hashes nor request inputs are exposed. */
  snapshot(): { activeScopes: number; waitingRequests: number; retainedScopes: number } {
    let waitingRequests = 0, activeScopes = 0;
    for (const state of this.scopes.values()) { waitingRequests += state.waiting.length; if (state.active) activeScopes++; }
    return { activeScopes, waitingRequests, retainedScopes: this.scopes.size };
  }

  private acquireHashed(key: string, signal?: AbortSignal): Promise<() => void> {
    for (const [candidate, state] of this.scopes) {
      if (!state.active && !state.waiting.length && state.nextStartAt <= this.now()) {
        clearTimeout(state.wakeTimer);
        this.scopes.delete(candidate);
      }
    }
    let state = this.scopes.get(key);
    if (!state) {
      if (this.scopes.size >= this.maxScopes) return Promise.reject(new ModelRequestQueueError("queue_full"));
      state = { active: false, waiting: [], nextStartAt: 0 };
      this.scopes.set(key, state);
    }
    if (state.waiting.length >= this.maxWaitingPerScope) return Promise.reject(new ModelRequestQueueError("queue_full"));
    const active = state;
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const remove = (error: Error) => {
        const index = active.waiting.indexOf(waiter);
        if (index < 0) return;
        active.waiting.splice(index, 1);
        if (signal && waiter.onAbort) signal.removeEventListener("abort", waiter.onAbort);
        clearTimeout(waiter.timer);
        reject(error);
        this.advance(key, active);
      };
      if (signal) {
        waiter.onAbort = () => remove(cancelled());
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      active.waiting.push(waiter);
      waiter.timer = setTimeout(() => remove(new ModelRequestQueueError("queue_timeout")), this.maxWaitMs);
      // A custom signal can become aborted while its listener is registered.
      if (signal?.aborted) waiter.onAbort?.();
      this.advance(key, active);
    });
  }

  private releaseFor(key: string, state: ScopeState): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.scopes.get(key) !== state) return;
      state.active = false;
      // Releasing after response consumption is a conservative provider-start
      // boundary: image preparation or a slow body cannot compress the pacing.
      state.nextStartAt = this.now() + this.minIntervalMs;
      this.advance(key, state);
    };
  }

  private advance(key: string, state: ScopeState): void {
    if (this.scopes.get(key) !== state || state.active) return;
    const remaining = state.nextStartAt - this.now();
    if (remaining > 0) {
      if (!state.wakeTimer) {
        state.wakeTimer = setTimeout(() => { state.wakeTimer = undefined; this.advance(key, state); }, remaining);
        state.wakeTimer.unref?.();
      }
      return;
    }
    clearTimeout(state.wakeTimer);
    state.wakeTimer = undefined;
    while (state.waiting.length) {
      const next = state.waiting.shift()!;
      clearTimeout(next.timer);
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) { next.reject(cancelled()); continue; }
      state.active = true;
      next.resolve(this.releaseFor(key, state));
      return;
    }
    this.scopes.delete(key);
  }
}

const sharedOfficialRequests = new ModelRequestQueue({ minIntervalMs: 20_100 });

/**
 * The caller gates this to official Moonshot endpoints. Acquire before starting
 * the HTTP timeout, and release in finally after consuming/cancelling the body.
 * A lease is never released merely because response headers have arrived.
 */
export function acquireOfficialRequestSlot(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<() => void> {
  return sharedOfficialRequests.acquire(baseUrl, apiKey, signal);
}
