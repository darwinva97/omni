import { describe, it, expect } from "vitest";
import { matchesPattern, matchesAny, eventNames, eventDomain } from "./events.js";

describe("suscripción a eventos", () => {
  it("empareja nombre exacto, comodín de dominio y total", () => {
    expect(matchesPattern("message.received", "message.received")).toBe(true);
    expect(matchesPattern("message.received", "message.*")).toBe(true);
    expect(matchesPattern("message.received", "*")).toBe(true);
    expect(matchesPattern("message.received", "session.*")).toBe(false);
    expect(matchesPattern("message.received", "message.sent")).toBe(false);
  });

  it("una lista vacía significa TODO, no nada", () => {
    // La distinción de crafter: ausencia de filtro no puede silenciar el webhook.
    expect(matchesAny("message.received", [])).toBe(true);
    expect(matchesAny("message.received", ["session.*"])).toBe(false);
  });

  it("el comodín no empareja de más", () => {
    expect(matchesPattern("message.received", "mess.*")).toBe(false);
  });

  it("todos los eventos del catálogo tienen dominio y hecho", () => {
    for (const e of eventNames) {
      expect(e).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(eventDomain(e).length).toBeGreaterThan(0);
    }
  });
});
