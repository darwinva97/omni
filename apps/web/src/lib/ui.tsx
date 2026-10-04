/**
 * Controles de las pantallas administrativas.
 *
 * Un solo vocabulario para toda la administración: mismo radio, mismo peso de
 * trazo, mismo tamaño de control. Que el botón de guardar se vea igual en
 * «Claves» y en «Equipo» no es pulcritud: cuando no se parecen, uno de los dos
 * está mal y el usuario lo nota aunque no sepa decir por qué.
 */

export { Estado, Vacio, Aviso, SecretoUnaVez, Avatar, Acuse } from "@/componentes/piezas";

export function Tabla({
  columnas,
  filas,
  vacio = "Nada que mostrar todavía.",
}: {
  columnas: readonly string[];
  filas: readonly (readonly React.ReactNode[])[];
  vacio?: string;
}) {
  if (filas.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-(--color-borde) px-4 py-10 text-center text-sm text-(--color-tenue)">
        {vacio}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-(--color-borde) bg-(--color-panel)">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--color-borde) text-left">
            {columnas.map((c) => (
              <th
                key={c}
                className="px-4 py-2.5 text-xs font-medium tracking-wide text-(--color-tenue) uppercase"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-(--color-borde-sutil)">
          {filas.map((f, i) => (
            <tr key={i} className="transition-colors duration-150 hover:bg-(--color-hundido)">
              {f.map((celda, j) => (
                <td key={j} className="px-4 py-2.5 align-top">{celda}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CONTROL =
  "mt-1.5 w-full rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none transition-colors duration-150 focus:border-(--color-acento) focus:ring-2 focus:ring-(--color-acento)/25";

export function Campo({
  nombre, etiqueta, tipo = "text", requerido = false, ayuda, valor, opciones, marcador,
}: {
  nombre: string; etiqueta: string; tipo?: string; requerido?: boolean;
  ayuda?: string; valor?: string; marcador?: string;
  opciones?: readonly { valor: string; texto: string }[];
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{etiqueta}</span>
      {opciones ? (
        <select name={nombre} defaultValue={valor} className={CONTROL}>
          {opciones.map((o) => (
            <option key={o.valor} value={o.valor}>{o.texto}</option>
          ))}
        </select>
      ) : (
        <input
          name={nombre} type={tipo} required={requerido} defaultValue={valor}
          placeholder={marcador}
          className={CONTROL}
        />
      )}
      {/* La ayuda va DEBAJO del control: encima, se lee antes de saber a qué
          se refiere y hay que volver a leerla. */}
      {ayuda && <span className="mt-1.5 block text-xs text-(--color-tenue)">{ayuda}</span>}
    </label>
  );
}

export function Boton({
  children, tipo = "primario", peligro = false,
}: {
  children: React.ReactNode;
  tipo?: "primario" | "sobrio";
  peligro?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-all duration-150 disabled:opacity-40";
  const estilo = peligro
    ? "border border-(--color-error) text-(--color-error) hover:bg-(--color-error-tenue)"
    : tipo === "primario"
      ? "bg-(--color-acento) text-(--color-sobre-acento) hover:opacity-90"
      : "border border-(--color-borde) hover:bg-(--color-hundido)";
  return <button type="submit" className={`${base} ${estilo}`}>{children}</button>;
}

/** Caja de contenido para las pantallas administrativas. */
export function Tarjeta({
  titulo, descripcion, children,
}: {
  titulo?: string;
  descripcion?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-(--color-borde) bg-(--color-panel) p-5">
      {titulo && <h2 className="text-sm font-semibold">{titulo}</h2>}
      {descripcion && (
        <p className="mt-1 text-sm text-(--color-tenue)">{descripcion}</p>
      )}
      <div className={titulo ? "mt-4" : ""}>{children}</div>
    </section>
  );
}
