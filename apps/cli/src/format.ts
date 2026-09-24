/**
 * Presentación en tabla.
 *
 * `--json` está en todos los comandos para poder encadenarlos con `jq`; esto
 * es lo que se enseña cuando no se pide.
 */
export function formatTable(value: unknown): string {
  if (value === null || value === undefined) return "(sin datos)";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(vacío)";
    if (typeof value[0] !== "object" || value[0] === null) return value.map(String).join("\n");

    const filas = value as Record<string, unknown>[];
    const columnas = [...new Set(filas.flatMap((f) => Object.keys(f)))];
    const anchos = columnas.map((c) =>
      Math.max(c.length, ...filas.map((f) => celda(f[c]).length)),
    );
    const linea = (celdas: string[]): string =>
      celdas.map((v, i) => v.padEnd(anchos[i]!)).join("  ").trimEnd();
    return [
      linea(columnas),
      linea(anchos.map((a) => "─".repeat(a))),
      ...filas.map((f) => linea(columnas.map((c) => celda(f[c])))),
    ].join("\n");
  }
  if (typeof value === "object") {
    const entradas = Object.entries(value as Record<string, unknown>);
    const ancho = Math.max(...entradas.map(([k]) => k.length));
    return entradas.map(([k, v]) => `${k.padEnd(ancho)}  ${celda(v)}`).join("\n");
  }
  return String(value);
}

/**
 * Ancho máximo de una celda.
 *
 * Una lista de cuarenta capacidades en una sola celda hace ilegible la tabla
 * entera. Se recorta AQUÍ y no en el cliente: `--json` sigue devolviendo el
 * dato completo, que es lo que se encadena con jq.
 */
const MAX_CELDA = 48;

function celda(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) {
    const texto = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
    return recortar(texto, v.length);
  }
  if (typeof v === "object") return recortar(JSON.stringify(v));
  return recortar(String(v));
}

function recortar(texto: string, total?: number): string {
  if (texto.length <= MAX_CELDA) return texto;
  const resto = total !== undefined ? ` (+${total} en total, usa --json)` : "…";
  return texto.slice(0, MAX_CELDA - 1).trimEnd() + resto;
}
