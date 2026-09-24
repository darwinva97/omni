import { describe, it, expect } from "vitest";
import { BlobAuthStore } from "./auth-store.js";

describe("almacén de credenciales de Baileys", () => {
  it("crea un estado nuevo cuando no hay blob", () => {
    const store = BlobAuthStore.from(null, () => {});
    expect(store.creds.registered).toBe(false);
    expect(store.creds.noiseKey).toBeDefined();
  });

  it("sobrevive a una vuelta completa por serialización", () => {
    // Es lo único que importa de esta pieza: si la vuelta pierde algo, la
    // sesión no falla al guardarse, falla al reconectar días después.
    const original = BlobAuthStore.from(null, () => {});
    const blob = original.serialize();
    const restaurado = BlobAuthStore.from(blob, () => {});

    expect(Buffer.from(restaurado.creds.noiseKey.private))
      .toEqual(Buffer.from(original.creds.noiseKey.private));
    expect(restaurado.creds.registrationId).toBe(original.creds.registrationId);
  });

  it("conserva los Buffer como Buffer y no como objetos", () => {
    // `JSON.stringify` a secas convierte un Buffer en {type:"Buffer",data:[...]}
    // y la clave deja de servir. De ahí que haga falta BufferJSON.
    const store = BlobAuthStore.from(null, () => {});
    const restaurado = BlobAuthStore.from(store.serialize(), () => {});
    expect(Buffer.isBuffer(restaurado.creds.noiseKey.private)).toBe(true);
  });

  it("guarda y recupera claves de sesión", async () => {
    const store = BlobAuthStore.from(null, () => {});
    await store.state().keys.set({ "pre-key": { "1": { public: Buffer.from([1, 2]) } } } as never);
    const got = await store.state().keys.get("pre-key", ["1"]);
    expect(got["1"]).toBeDefined();
  });

  it("un valor nulo BORRA la clave en vez de guardarse", async () => {
    // Dejar el nulo dentro corrompe el estado en la siguiente reconexión.
    const store = BlobAuthStore.from(null, () => {});
    await store.state().keys.set({ "pre-key": { "1": { public: Buffer.from([1]) } } } as never);
    await store.state().keys.set({ "pre-key": { "1": null } } as never);
    expect(await store.state().keys.get("pre-key", ["1"])).toEqual({});
  });

  it("avisa de cada cambio para que el motor lo persista", async () => {
    let cambios = 0;
    const store = BlobAuthStore.from(null, () => { cambios++; });
    await store.state().keys.set({ "pre-key": { "2": { public: Buffer.from([1]) } } } as never);
    store.markCredsUpdated();
    expect(cambios).toBe(2);
  });

  it("rechaza un formato de versión desconocida en vez de fallar raro", () => {
    const raro = new TextEncoder().encode(JSON.stringify({ version: 99, creds: {}, keys: {} }));
    expect(() => BlobAuthStore.from(raro, () => {})).toThrow(/versión 99/);
  });
});
