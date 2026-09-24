import type { Kv } from "../ports/kv.port.js";

interface Entry { value: string; expiresAt: number | null }

/** KV en memoria con expiración perezosa. Mismo contrato que el de Postgres. */
export class MemoryKv implements Kv {
  readonly #map = new Map<string, Entry>();

  #live(key: string): Entry | null {
    const e = this.#map.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.#map.delete(key);
      return null;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.#live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.#map.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (this.#live(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async increment(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    const current = Number(this.#live(key)?.value ?? "0");
    const next = current + by;
    const existing = this.#live(key);
    this.#map.set(key, {
      value: String(next),
      // Renovar el TTL en cada incremento convertiría una ventana de cuota en eterna.
      expiresAt: existing?.expiresAt ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : null),
    });
    return next;
  }

  async close(): Promise<void> {
    this.#map.clear();
  }
}
