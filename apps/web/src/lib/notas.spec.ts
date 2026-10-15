import { describe, it, expect } from "vitest";
import type { Mensaje, Nota } from "./api";
import { intercalar } from "./notas";

const m = (id: string, timestamp: string): Mensaje => ({
  id, providerMessageId: id, fromMe: false, kind: "text", body: id, state: "delivered", timestamp,
});
const n = (id: string, createdAt: string): Nota => ({
  id, chatId: "c", body: id, createdAt, author: { kind: "user", userId: "u", name: "Ana" },
});

describe("las notas en el hilo", () => {
  const mensajes = [m("m1", "2026-10-10T10:00:00.000Z"), m("m2", "2026-10-10T11:00:00.000Z")];

  it("van por fecha entre los mensajes", () => {
    const hilo = intercalar(mensajes, [n("n1", "2026-10-10T10:30:00.000Z")],
      { desdeElPrincipio: true, hastaElFinal: true });
    expect(hilo.map((x) => (x.tipo === "mensaje" ? x.m.id : x.n.id))).toEqual(["m1", "n1", "m2"]);
  });

  it("una nota en medio abre tanda: el mensaje de después no se pega al de antes", () => {
    const hilo = intercalar(mensajes, [n("n1", "2026-10-10T10:30:00.000Z")],
      { desdeElPrincipio: true, hastaElFinal: true });
    const m2 = hilo[2]!;
    expect(m2.tipo === "mensaje" && m2.anterior).toBeUndefined();
  });

  it("no se cuela una nota de antes de lo que se ve si el hilo no empieza en el principio", () => {
    const vieja = n("vieja", "2026-01-01T00:00:00.000Z");
    expect(intercalar(mensajes, [vieja], { desdeElPrincipio: false, hastaElFinal: true })).toHaveLength(2);
    expect(intercalar(mensajes, [vieja], { desdeElPrincipio: true, hastaElFinal: true })).toHaveLength(3);
  });

  it("en una ventana del pasado no aparecen las notas de hoy", () => {
    const hoy = n("hoy", "2026-10-15T00:00:00.000Z");
    expect(intercalar(mensajes, [hoy], { desdeElPrincipio: false, hastaElFinal: false })).toHaveLength(2);
  });

  it("cada día nuevo lleva su separador, sea nota o mensaje", () => {
    const hilo = intercalar(mensajes, [n("n1", "2026-10-11T09:00:00.000Z")],
      { desdeElPrincipio: true, hastaElFinal: true });
    expect(hilo.map((x) => x.nuevoDia)).toEqual([true, false, true]);
  });
});
