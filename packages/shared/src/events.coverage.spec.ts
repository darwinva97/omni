import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventNames } from "./events.js";

/**
 * Guard del catálogo de eventos.
 *
 * Todo nombre publicado tiene que tener quien lo emita. Sin esta prueba, un
 * evento se añade "para luego", alguien configura un webhook con él, lo da por
 * bueno y no recibe nada nunca — el mismo fallo silencioso que tenía el filtro
 * del gateway anterior, que se guardaba y no se leía.
 */

const RAIZ = fileURLToPath(new URL("../../..", import.meta.url));

function ficherosFuente(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada === "node_modules" || entrada === "dist" || entrada.startsWith(".")) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) ficherosFuente(ruta, acc);
    else if (entrada.endsWith(".ts") && !entrada.includes(".spec.")) acc.push(ruta);
  }
  return acc;
}

describe("cobertura del catálogo de eventos", () => {
  const fuentes = [join(RAIZ, "packages"), join(RAIZ, "apps")]
    .flatMap((d) => ficherosFuente(d))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  it("cada evento del catálogo tiene quien lo emita", () => {
    const sinEmisor = eventNames.filter((e) => {
      // Se busca el nombre entre comillas: así cuenta tanto `emit("x.y")` como
      // una publicación desde la API o desde una prueba de integración.
      return !new RegExp(`["']${e.replace(".", "\\.")}["']`).test(fuentes);
    });
    expect(
      sinEmisor,
      `estos eventos se pueden suscribir pero no los emite nadie:\n  ${sinEmisor.join("\n  ")}\n` +
        "Emítelos, o quítalos del catálogo hasta que existan.",
    ).toEqual([]);
  });

  it("los nombres siguen la forma dominio.hecho", () => {
    for (const e of eventNames) expect(e, e).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it("no hay nombres repetidos", () => {
    expect(new Set(eventNames).size).toBe(eventNames.length);
  });
});
