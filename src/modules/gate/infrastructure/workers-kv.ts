// Workers KV adapter — the production implementation of the KeyValueStore port
// on Cloudflare (ADR-0006). Structural binding type keeps this file free of a
// platform type-lib dependency (same approach as webcrypto.ts PublicJwk).
import type { KeyValueStore } from '../application/ports.ts';

/**
 * The slice of the Cloudflare KV binding the gate uses. `get`/`put` only —
 * values are JSON strings.
 */
export interface WorkersKvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Workers KV enforces a 60-second floor on expirationTtl. */
const KV_MIN_TTL_SECONDS = 60;

export class WorkersKvStore<T> implements KeyValueStore<T> {
  readonly #kv: WorkersKvBinding;

  constructor(kv: WorkersKvBinding) {
    this.#kv = kv;
  }

  async get(key: string): Promise<T | undefined> {
    const raw = await this.#kv.get(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    // A sub-60s TTL is clamped up to KV's floor — this is exactly the ≤60s
    // revocation-staleness bound ADR-0006 accepts (the ③ cache and denylist
    // both ride this floor; epoch check is the sub-TTL backstop).
    const options =
      ttlMs === undefined
        ? undefined
        : { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.round(ttlMs / 1000)) };
    await this.#kv.put(key, JSON.stringify(value), options);
  }
}
