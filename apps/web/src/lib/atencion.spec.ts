import { describe, it, expect } from "vitest";
import type { Chat, Conversacion } from "./api";
import { conConversacion, enFiltro, nombreDeResponsable } from "./atencion";

const conv = (over: Partial<Conversacion> = {}): Conversacion => ({
  id: "c1", lineId: "l", chatId: "51911@s.whatsapp.net", status: "open",
  priority: "normal", assigneeId: null, openedAt: "2026-10-01T10:00:00.000Z",
  resolvedAt: null, ...over,
});

const chat = (c: Conversacion | null): Chat => ({
  address: "51911@s.whatsapp.net", kind: "pn", displayName: "Ana", title: null,
  savedName: null, pushName: null, avatarUrl: null, phone: null,
  lastMessageAt: null, unreadCount: 0, ultimo: null, ultimoPropio: false,
  conversation: c,
});

describe("filtros de atención", () => {
  it("«Míos» es lo vivo que llevo yo, no lo que ya resolví", () => {
    expect(enFiltro(chat(conv({ assigneeId: "yo" })), "mios", "yo")).toBe(true);
    expect(enFiltro(chat(conv({ assigneeId: "otra" })), "mios", "yo")).toBe(false);
    expect(enFiltro(chat(conv({ assigneeId: "yo", status: "resolved" })), "mios", "yo")).toBe(false);
  });

  it("«Sin asignar» no incluye un chat que nunca pidió nada", () => {
    expect(enFiltro(chat(conv()), "sin-asignar", "yo")).toBe(true);
    expect(enFiltro(chat(null), "sin-asignar", "yo")).toBe(false);
    expect(enFiltro(chat(conv({ status: "pending" })), "sin-asignar", "yo")).toBe(true);
  });

  it("«Resueltos» es lo resuelto, lo lleve quien lo lleve", () => {
    expect(enFiltro(chat(conv({ status: "resolved", assigneeId: "otra" })), "resueltos", "yo")).toBe(true);
    expect(enFiltro(chat(conv()), "resueltos", "yo")).toBe(false);
  });
});

describe("el responsable", () => {
  const equipo = [{ userId: "u1", email: "a@x", name: "Ana", role: "agent" }];
  it("se dice «Tú» si eres tú, y el nombre si es otro", () => {
    expect(nombreDeResponsable("yo", equipo, "yo")).toBe("Tú");
    expect(nombreDeResponsable("u1", equipo, "yo")).toBe("Ana");
    expect(nombreDeResponsable(null, equipo, "yo")).toBeNull();
  });
});

describe("el cambio que llega en vivo", () => {
  it("se aplica a su chat", () => {
    const [x] = conConversacion([chat(conv())], conv({ assigneeId: "u1" }));
    expect(x!.conversation?.assigneeId).toBe("u1");
  });

  it("la resuelta de ayer no tapa la que el cliente acaba de abrir", () => {
    const hoy = conv({ id: "c2", openedAt: "2026-10-02T10:00:00.000Z" });
    const ayer = conv({ id: "c1", status: "resolved" });
    const [x] = conConversacion([chat(hoy)], ayer);
    expect(x!.conversation?.id).toBe("c2");
  });

  it("la nueva sí sustituye a la resuelta", () => {
    const ayer = conv({ id: "c1", status: "resolved" });
    const hoy = conv({ id: "c2", openedAt: "2026-10-02T10:00:00.000Z" });
    const [x] = conConversacion([chat(ayer)], hoy);
    expect(x!.conversation?.id).toBe("c2");
  });
});
