import type { Args } from "./commands.js";

/**
 * Lector de argumentos.
 *
 * Acepta `--clave valor` y `--bandera`. No hay abreviaturas de una letra a
 * propósito: en un script, `-f` no dice nada dentro de seis meses.
 */
export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const nombre = arg.slice(2);
    if (nombre.includes("=")) {
      const corte = nombre.indexOf("=");
      flags[nombre.slice(0, corte)] = nombre.slice(corte + 1);
      continue;
    }
    const siguiente = argv[i + 1];
    if (siguiente !== undefined && !siguiente.startsWith("--")) {
      flags[nombre] = siguiente;
      i++;
    } else {
      flags[nombre] = true;
    }
  }
  return { positional, flags };
}
