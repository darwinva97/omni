import { describe, it, expect } from "vitest";
import { comprobarOpcionales, PARES_OPCIONALES } from "./opcionales.js";

describe("pares opcionales de Baileys", () => {
  it("están todos instalados", async () => {
    /*
     * Esta prueba existe por un fallo real: faltaba `audio-decode` y las notas
     * de voz se enviaban —subida correcta, cifrado correcto, enviadas a cinco
     * dispositivos— sin aparecer en NINGÚN cliente. El único rastro era una
     * línea en nivel `debug`. Si alguien quita el paquete, esto falla aquí y
     * no en el teléfono de un cliente.
     */
    const faltan = await comprobarOpcionales();
    expect(
      faltan,
      `faltan paquetes que Baileys necesita: ${faltan.map((f) => `${f.paquete} (${f.para})`).join(", ")}`,
    ).toEqual([]);
  });

  it("informa del motivo cuando uno no se puede cargar", async () => {
    const faltan = await comprobarOpcionales(async () => {
      throw new Error("Cannot find package 'x'");
    });
    expect(faltan).toHaveLength(PARES_OPCIONALES.length);
    expect(faltan[0]!.motivo).toContain("Cannot find package");
    // El para-qué viaja con el aviso: saber que falta no sirve si no se sabe
    // qué se rompe.
    expect(faltan[0]!.para).toBeTruthy();
  });
});
