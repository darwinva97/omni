import { describe, it, expect } from "vitest";
import { caidaDe, estadoTrasEvento, textoDeCaida } from "./lineas-caidas";

const linea = (status: string, address: string | null = "51999888777@s.whatsapp.net") => ({
  id: "l", name: "Ventas", status, address, enabled: true,
});

describe("qué línea está caída", () => {
  it("una que funcionaba y se desconectó, sí", () => {
    expect(caidaDe(linea("disconnected"))).toBe("desconectada");
    expect(caidaDe(linea("logged-out"))).toBe("sin-sesion");
    expect(caidaDe(linea("awaiting-link"))).toBe("sin-sesion");
  });

  it("una conectada, o una nueva que nunca se enlazó, no", () => {
    expect(caidaDe(linea("connected"))).toBeNull();
    expect(caidaDe(linea("disconnected", null))).toBeNull();
    expect(caidaDe({ ...linea("disconnected"), enabled: false })).toBeNull();
  });
});

describe("el estado en vivo", () => {
  it("cada evento de sesión dice cómo queda la línea", () => {
    expect(estadoTrasEvento("session.disconnected", {})).toBe("disconnected");
    expect(estadoTrasEvento("session.logged_out", { code: 401 })).toBe("logged-out");
    expect(estadoTrasEvento("session.status", { state: "connected" })).toBe("connected");
    expect(estadoTrasEvento("session.qr", { qr: "x" })).toBeNull();
  });

  it("y se dice en llano", () => {
    expect(textoDeCaida("Ventas", "desconectada").titulo).toBe("La línea Ventas se ha desconectado");
  });
});
