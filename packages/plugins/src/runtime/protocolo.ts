import { z } from "zod";

/**
 * Protocolo entre el anfitrión y el proceso de un plugin.
 *
 * Va por la entrada y salida estándar, una línea de JSON por mensaje. Es
 * deliberadamente pobre: el plugin no puede pedir nada que no esté aquí, y
 * añadir una capacidad nueva exige tocar este fichero, que es justo la fricción
 * que se quiere.
 */

export const MensajeDelAnfitrion = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("cargar"), config: z.record(z.string(), z.unknown()) }),
  z.object({
    tipo: z.literal("gancho"),
    id: z.number(),
    payload: z.object({
      event: z.string(), lineId: z.string(), orgId: z.string(),
      timestamp: z.number(), data: z.unknown(),
    }),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({ tipo: z.literal("configuracion"), config: z.record(z.string(), z.unknown()) }),
  z.object({ tipo: z.literal("salud"), id: z.number() }),
  z.object({
    tipo: z.literal("respuesta-api"),
    id: z.number(),
    ok: z.boolean(),
    valor: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ tipo: z.literal("terminar") }),
]);
export type MensajeDelAnfitrion = z.infer<typeof MensajeDelAnfitrion>;

export const MensajeDelPlugin = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("listo") }),
  z.object({ tipo: z.literal("gancho-hecho"), id: z.number(), continuar: z.boolean() }),
  z.object({ tipo: z.literal("gancho-falló"), id: z.number(), error: z.string() }),
  z.object({ tipo: z.literal("salud-hecha"), id: z.number(), ok: z.boolean(), detalle: z.string().optional() }),
  z.object({
    tipo: z.literal("llamada-api"),
    id: z.number(),
    metodo: z.string(),
    args: z.array(z.unknown()),
  }),
  z.object({
    tipo: z.literal("registro"),
    nivel: z.enum(["debug", "info", "warn", "error"]),
    mensaje: z.string(),
    datos: z.unknown().optional(),
  }),
  z.object({ tipo: z.literal("error-fatal"), error: z.string() }),
]);
export type MensajeDelPlugin = z.infer<typeof MensajeDelPlugin>;

/** Una línea de JSON por mensaje: sencillo de enmarcar y de depurar. */
export function serializar(m: unknown): string {
  return JSON.stringify(m) + "\n";
}

/**
 * Trocea un flujo en líneas completas.
 *
 * Sin esto, un mensaje partido entre dos lecturas del socket se parsea a medias
 * y el plugin parece haberse colgado.
 */
export class LectorDeLineas {
  #resto = "";

  empujar(trozo: string): string[] {
    this.#resto += trozo;
    const lineas = this.#resto.split("\n");
    this.#resto = lineas.pop() ?? "";
    return lineas.filter((l) => l.trim().length > 0);
  }
}
