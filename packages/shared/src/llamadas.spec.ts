import { describe, it, expect } from "vitest";
import { siguienteEstadoDeLlamada as sig } from "./llamadas.js";

describe("estado de una llamada", () => {
  it("suena, se atiende y se cuelga: atendida y terminada", () => {
    expect(sig(undefined, "offer")).toBe("ringing");
    expect(sig("ringing", "ringing")).toBe("ringing");
    expect(sig("ringing", "accept")).toBe("answered");
    expect(sig("answered", "terminate")).toBe("ended");
  });

  it("suena y se cuelga sin atender: perdida", () => {
    expect(sig("ringing", "terminate")).toBe("missed");
    expect(sig("ringing", "timeout")).toBe("missed");
  });

  it("un final no se mueve aunque lleguen más avisos", () => {
    expect(sig("rejected", "terminate")).toBe("rejected");
    expect(sig("missed", "accept")).toBe("missed");
  });

  it("una oferta que llega al reconectar nació perdida", () => {
    expect(sig(undefined, "offer", true)).toBe("missed");
  });

  it("sin estado, como la manda el sandbox, es una oferta", () => {
    expect(sig(undefined, undefined)).toBe("ringing");
  });
});
