import type { Bus } from "../ports/bus.port.js";

/** Bus en proceso. Suficiente para un despliegue de un solo nodo y para tests. */
export class MemoryBus implements Bus {
  readonly #topics = new Map<string, Set<(p: unknown) => void | Promise<void>>>();

  async publish<T>(topic: string, payload: T): Promise<void> {
    const handlers = this.#topics.get(topic);
    if (!handlers) return;
    await Promise.all(
      [...handlers].map(async (h) => {
        try {
          await h(payload);
        } catch {
          /* un suscriptor roto no puede tumbar la publicación */
        }
      }),
    );
  }

  async subscribe<T>(topic: string, handler: (p: T) => void | Promise<void>): Promise<() => Promise<void>> {
    const set = this.#topics.get(topic) ?? new Set();
    set.add(handler as (p: unknown) => void | Promise<void>);
    this.#topics.set(topic, set);
    return async () => {
      set.delete(handler as (p: unknown) => void | Promise<void>);
    };
  }

  async close(): Promise<void> {
    this.#topics.clear();
  }
}
