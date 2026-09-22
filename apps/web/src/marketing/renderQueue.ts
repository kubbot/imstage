/**
 * Single-flight render queue with revision tracking.
 *
 * Used by the landing export preview. Long renders must never publish a stale
 * frame: each request bumps a revision, only the newest revision may commit,
 * and a request that arrives while a render is running marks the queue dirty so
 * the latest state is rendered again afterwards. Pure and timer-free so the
 * ordering rules are unit-testable.
 */
export interface RevisionQueue<T> {
  /** Request a render; returns the revision the caller should treat as current. */
  request(): number;
  /** Invalidate in-flight work and skip the follow-up render. */
  cancel(): void;
  readonly revision: number;
}

export interface RevisionQueueOptions<T> {
  render: () => Promise<T>;
  commit: (value: T) => void;
  fail?: (error: unknown) => void;
}

export function createRevisionQueue<T>({ render, commit, fail }: RevisionQueueOptions<T>): RevisionQueue<T> {
  let revision = 0;
  let running = false;
  let dirty = false;

  async function run(version: number): Promise<void> {
    running = true;
    dirty = false;
    try {
      const value = await render();
      if (version === revision) commit(value);
    } catch (error) {
      if (version === revision) fail?.(error);
    } finally {
      running = false;
      if (dirty) {
        // A newer request arrived while rendering; render the latest state.
        void run(revision);
      }
    }
  }

  return {
    request() {
      revision += 1;
      if (running) {
        dirty = true;
      } else {
        void run(revision);
      }
      return revision;
    },
    cancel() {
      revision += 1;
      dirty = false;
    },
    get revision() {
      return revision;
    },
  };
}
