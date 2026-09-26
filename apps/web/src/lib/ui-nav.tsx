import Link from "next/link";

/**
 * Navegación del panel.
 *
 * Cinco destinos y no más: un panel de mensajería se usa para leer y responder,
 * y todo lo administrativo es visita ocasional. Enterrarlo en un menú de
 * veinte entradas lo haría más difícil de encontrar, no más ordenado.
 */
const DESTINOS = [
  { href: "/", texto: "Líneas" },
  { href: "/equipo", texto: "Equipo" },
  { href: "/claves", texto: "Claves" },
  { href: "/entregas", texto: "Entregas" },
  { href: "/auditoria", texto: "Bitácora" },
] as const;

export function Navegacion({ actual }: { actual: string }) {
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-(--color-borde) bg-(--color-panel) px-5">
      {DESTINOS.map((d) => {
        const activo = d.href === "/" ? actual === "/" : actual.startsWith(d.href);
        return (
          <Link
            key={d.href}
            href={d.href}
            aria-current={activo ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm whitespace-nowrap ${
              activo
                ? "border-(--color-acento) text-(--color-texto)"
                : "border-transparent text-(--color-tenue) hover:text-(--color-texto)"
            }`}
          >
            {d.texto}
          </Link>
        );
      })}
    </nav>
  );
}

export function Tabla({
  columnas,
  filas,
}: {
  columnas: readonly string[];
  filas: readonly (readonly React.ReactNode[])[];
}) {
  if (filas.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-(--color-borde) px-4 py-8 text-center text-sm text-(--color-tenue)">
        Nada que mostrar todavía.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-(--color-borde) bg-(--color-panel)">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--color-borde) text-left text-xs text-(--color-tenue)">
            {columnas.map((c) => (
              <th key={c} className="px-4 py-2 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-(--color-borde)">
          {filas.map((f, i) => (
            <tr key={i}>
              {f.map((celda, j) => (
                <td key={j} className="px-4 py-2 align-top">{celda}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Campo({
  nombre, etiqueta, tipo = "text", requerido = false, ayuda, valor, opciones,
}: {
  nombre: string; etiqueta: string; tipo?: string; requerido?: boolean;
  ayuda?: string; valor?: string; opciones?: readonly { valor: string; texto: string }[];
}) {
  const clases =
    "mt-1 w-full rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-acento)";
  return (
    <label className="block">
      <span className="text-xs text-(--color-tenue)">{etiqueta}</span>
      {opciones ? (
        <select name={nombre} defaultValue={valor} className={clases}>
          {opciones.map((o) => (
            <option key={o.valor} value={o.valor}>{o.texto}</option>
          ))}
        </select>
      ) : (
        <input
          name={nombre} type={tipo} required={requerido} defaultValue={valor}
          className={clases}
        />
      )}
      {ayuda && <span className="mt-1 block text-xs text-(--color-tenue)">{ayuda}</span>}
    </label>
  );
}

export function Boton({ children, tipo = "primario" }: { children: React.ReactNode; tipo?: "primario" | "sobrio" }) {
  return (
    <button
      type="submit"
      className={
        tipo === "primario"
          ? "rounded-lg bg-(--color-acento) px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          : "rounded-lg border border-(--color-borde) px-3 py-2 text-sm hover:bg-(--color-ajeno)"
      }
    >
      {children}
    </button>
  );
}

/**
 * Secreto que se muestra UNA vez.
 *
 * Se enseña entero y con un aviso claro, porque no hay segunda oportunidad:
 * enseñarlo truncado o sin decirlo haría que alguien lo cerrara y perdiera la
 * clave que acaba de crear.
 */
export function SecretoUnaVez({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        {etiqueta} — cópialo ahora
      </p>
      <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
        No se puede volver a mostrar: en la base solo queda su hash.
      </p>
      <code className="mt-2 block overflow-x-auto rounded bg-(--color-panel) px-3 py-2 text-xs break-all">
        {valor}
      </code>
    </div>
  );
}
