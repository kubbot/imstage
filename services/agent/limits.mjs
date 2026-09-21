/**
 * IMStage Agent — bounded concurrency + rate limits.
 *
 * Three independent guards protect the paid model endpoints:
 *   - a global cap on concurrently running agent runs,
 *   - a per-user cap so one account cannot occupy every slot,
 *   - a bounded fixed-window request rate per user.
 *
 * Counters are process-local (same as the rest of this self-hosted server) and
 * bounded so a hostile client cannot grow memory without limit.
 */

class ActiveCounter {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.active = 0;
  }

  tryAcquire() {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
  }
}

class FixedWindowLimiter {
  constructor({ windowMs, max, maxKeys }) {
    this.windowMs = Math.max(1, Number(windowMs) || 1);
    this.max = Math.max(1, Number(max) || 1);
    this.maxKeys = Math.max(1, Number(maxKeys) || 1);
    this.buckets = new Map();
  }

  consume(key, nowMs) {
    let bucket = this.buckets.get(key);
    if (!bucket || nowMs >= bucket.resetAt) {
      bucket = { count: 0, resetAt: nowMs + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    this.#prune(nowMs);
    if (bucket.count > this.max) {
      return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - nowMs) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  #prune(nowMs) {
    if (this.buckets.size <= this.maxKeys) return;
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.resetAt) this.buckets.delete(key);
      if (this.buckets.size <= this.maxKeys) return;
    }
    const excess = this.buckets.size - this.maxKeys;
    let removed = 0;
    for (const key of this.buckets.keys()) {
      if (removed >= excess) break;
      this.buckets.delete(key);
      removed += 1;
    }
  }
}

export const AGENT_BUSY_RETRY_AFTER_MS = 5_000;

/**
 * @param {{activeGlobal:number, activePerUser:number, rate:{windowMs:number,max:number,maxKeys:number}}} limits
 */
export function createAgentLimiter(limits) {
  const global = new ActiveCounter(limits.activeGlobal);
  const perUser = new Map();
  const rate = new FixedWindowLimiter(limits.rate);

  const counterFor = (userId) => {
    let counter = perUser.get(userId);
    if (!counter) {
      counter = new ActiveCounter(limits.activePerUser);
      perUser.set(userId, counter);
    }
    return counter;
  };

  return {
    /**
     * Reserve a run slot. On success the caller owns the returned lease and
     * must call `release()` exactly once.
     *
     * @returns {{ok:true, release:() => void} | {ok:false, reason:string, retryAfterMs:number}}
     */
    tryStart(userId, nowMs = Date.now()) {
      const key = String(userId ?? 'anonymous');
      if (!global.tryAcquire()) {
        return { ok: false, reason: 'global_busy', retryAfterMs: AGENT_BUSY_RETRY_AFTER_MS };
      }
      const counter = counterFor(key);
      if (!counter.tryAcquire()) {
        global.release();
        return { ok: false, reason: 'user_busy', retryAfterMs: AGENT_BUSY_RETRY_AFTER_MS };
      }
      const rateResult = rate.consume(`user:${key}`, nowMs);
      if (!rateResult.allowed) {
        counter.release();
        global.release();
        return { ok: false, reason: 'rate_limited', retryAfterMs: rateResult.retryAfterMs };
      }
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          counter.release();
          global.release();
          if (counter.active === 0) perUser.delete(key);
        },
      };
    },

    /** Bounded observability used by tests and health-style checks. */
    snapshot() {
      return { globalActive: global.active, trackedUsers: perUser.size };
    },

    activeForUser(userId) {
      return perUser.get(String(userId ?? 'anonymous'))?.active ?? 0;
    },
  };
}
