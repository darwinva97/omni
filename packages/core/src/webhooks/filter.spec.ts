import { describe, it, expect } from "vitest";
import type { EventEnvelope } from "@omni/shared";
import { passesFilter } from "./filter.js";

const envelope = (data: Record<string, unknown>): EventEnvelope => ({
  id: "e1", event: "message.received", orgId: "o1", lineId: "l1",
  timestamp: Date.now(), data,
});

const entrante = envelope({
  key: { id: "m1", remoteJid: "51999000111@s.whatsapp.net", fromMe: false },
  kind: "text", text: "Quiero hacer un PEDIDO de dos cajas",
});
const enGrupo = envelope({
  key: { id: "m2", remoteJid: "12036-9@g.us", fromMe: false, participant: "51988000222@s.whatsapp.net" },
  kind: "text", text: "hola",
});
const propio = envelope({
  key: { id: "m3", remoteJid: "51999000111@s.whatsapp.net", fromMe: true },
  kind: "text", text: "respuesta",
});

describe("filtro de webhooks", () => {
  it("sin filtro pasa todo", () => {
    expect(passesFilter(null, entrante)).toBe(true);
    expect(passesFilter(undefined, entrante)).toBe(true);
  });

  it("descarta los propios cuando se pide solo entrantes", () => {
    expect(passesFilter({ fromMe: false }, entrante)).toBe(true);
    expect(passesFilter({ fromMe: false }, propio)).toBe(false);
  });

  it("distingue grupo de conversación individual", () => {
    expect(passesFilter({ isGroup: true }, enGrupo)).toBe(true);
    expect(passesFilter({ isGroup: true }, entrante)).toBe(false);
  });

  it("busca en el cuerpo sin distinguir mayúsculas", () => {
    expect(passesFilter({ bodyContains: "pedido" }, entrante)).toBe(true);
    expect(passesFilter({ bodyContains: "factura" }, entrante)).toBe(false);
  });

  it("acepta expresión regular y no deja pasar si es inválida", () => {
    expect(passesFilter({ bodyMatches: "^quiero\\b" }, entrante)).toBe(true);
    // Una regex rota no puede convertirse en "pasa todo" en silencio.
    expect(passesFilter({ bodyMatches: "([" }, entrante)).toBe(false);
  });

  it("combina condiciones con Y lógico", () => {
    expect(passesFilter({ fromMe: false, isGroup: false, bodyContains: "pedido" }, entrante)).toBe(true);
    expect(passesFilter({ fromMe: false, isGroup: true, bodyContains: "pedido" }, entrante)).toBe(false);
  });

  it("filtra por remitente dentro de un grupo", () => {
    expect(passesFilter({ senderIn: ["51988000222@s.whatsapp.net"] }, enGrupo)).toBe(true);
    expect(passesFilter({ senderIn: ["51900000000@s.whatsapp.net"] }, enGrupo)).toBe(false);
  });

  it("permite excluir chats concretos", () => {
    expect(passesFilter({ chatNotIn: ["12036-9@g.us"] }, enGrupo)).toBe(false);
    expect(passesFilter({ chatNotIn: ["12036-9@g.us"] }, entrante)).toBe(true);
  });
});
