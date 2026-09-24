import { describe, it, expect } from "vitest";
import { SendMessageInput, resolveContent, advanceState } from "./messages.js";

describe("envío polimórfico", () => {
  it("acepta exactamente un campo de contenido", () => {
    const r = resolveContent(SendMessageInput.parse({ to: "51999888777", text: "hola" }));
    expect(r).toEqual({ ok: true, field: "text" });
  });

  it("rechaza cero campos de contenido explicando cuáles valen", () => {
    const r = resolveContent(SendMessageInput.parse({ to: "51999888777" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("text");
  });

  it("rechaza dos campos de contenido a la vez", () => {
    const r = resolveContent(
      SendMessageInput.parse({ to: "x", text: "hola", image: { url: "https://e.com/a.png" } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("solo uno");
  });

  it("rechaza campos desconocidos en vez de ignorarlos en silencio", () => {
    expect(() => SendMessageInput.parse({ to: "x", text: "h", inventado: 1 })).toThrow();
  });

  it("valida los límites de una encuesta", () => {
    expect(() => SendMessageInput.parse({ to: "x", poll: { question: "q", options: ["a"] } })).toThrow();
    expect(
      SendMessageInput.parse({ to: "x", poll: { question: "q", options: ["a", "b"] } }).poll
        ?.allowMultipleAnswers,
    ).toBe(false);
  });
});

describe("avance de estado de entrega", () => {
  it("nunca retrocede aunque los recibos lleguen desordenados", () => {
    expect(advanceState("read", "delivered")).toBe("read");
    expect(advanceState("delivered", "read")).toBe("read");
    expect(advanceState("queued", "sent")).toBe("sent");
  });

  it("fallido es absorbente", () => {
    expect(advanceState("failed", "read")).toBe("failed");
  });
});
