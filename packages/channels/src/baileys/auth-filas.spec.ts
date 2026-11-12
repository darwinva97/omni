import { describe, it, expect } from "vitest";
import { BlobAuthStore } from "./auth-store.js";

/* La sesión por filas: las credenciales en el blob y cada clave en la suya. */
describe("sesión de WhatsApp clave a clave", () => {
  it("sólo se guardan las claves que cambiaron, y el blob ya no las lleva", async () => {
    const s = BlobAuthStore.from(null, () => {});
    await s.state().keys.set({ session: { a: { n: 1 } as never, b: { n: 2 } as never } });
    s.tomarCambios();
    await s.state().keys.set({ session: { b: { n: 3 } as never } });
    const { claves, creds } = s.tomarCambios();
    expect(claves.map((c) => `${c.type}/${c.id}`)).toEqual(["session/b"]);
    expect(JSON.parse(new TextDecoder().decode(claves[0]!.value!))).toEqual({ n: 3 });
    expect(creds).toBeNull();
    s.markCredsUpdated();
    const blob = JSON.parse(new TextDecoder().decode(s.tomarCambios().creds!));
    expect(blob.keys).toEqual({});
  });

  it("borrar una clave es un cambio con valor null", async () => {
    const s = BlobAuthStore.from(null, () => {});
    await s.state().keys.set({ session: { a: { n: 1 } as never } });
    s.tomarCambios();
    await s.state().keys.set({ session: { a: null as never } });
    expect(s.tomarCambios().claves).toEqual([{ type: "session", id: "a", value: null }]);
  });

  it("una sesión del formato antiguo (todo en el blob) se recupera entera y se pasa a filas", async () => {
    const vieja = BlobAuthStore.from(null, () => {});
    await vieja.state().keys.set({ session: { a: { n: 1 } as never }, "sender-key": { g: { k: 9 } as never } });
    const blobViejo = vieja.serialize();
    const s = BlobAuthStore.from(blobViejo, () => {});
    expect(s.clavesEnBlob).toBe(true);
    // Una fila más nueva manda sobre lo que traía el blob.
    s.mezclar([{ type: "session", id: "a", value: new TextEncoder().encode(JSON.stringify({ n: 5 })) }]);
    s.marcarTodo();
    const { claves, creds } = s.tomarCambios();
    expect(claves.map((c) => `${c.type}/${c.id}`).sort()).toEqual(["sender-key/g", "session/a"]);
    expect(JSON.parse(new TextDecoder().decode(claves.find((c) => c.id === "a")!.value!))).toEqual({ n: 5 });
    expect(creds).not.toBeNull();
    expect((await s.state().keys.get("session", ["a"]))["a"]).toEqual({ n: 5 });
  });

  it("si guardar falla, lo tomado vuelve a quedar pendiente", async () => {
    const s = BlobAuthStore.from(null, () => {});
    await s.state().keys.set({ session: { a: { n: 1 } as never } });
    const t = s.tomarCambios();
    s.devolver(t.claves, false);
    expect(s.tomarCambios().claves.map((c) => c.id)).toEqual(["a"]);
  });
});
