import Link from "next/link";
import {
  IconoBitacora, IconoEntregas, IconoGrupo, IconoLineas, IconoLlave, IconoSalir,
} from "./iconos";

/**
 * El armazón del panel.
 *
 * Un raíl estrecho de iconos a la izquierda y el contenido a la derecha. Es la
 * disposición de un cliente de mensajería de escritorio y no una elección
 * estética: el 95% del uso es leer y responder, así que el espacio horizontal
 * pertenece a la conversación, y lo administrativo —que se visita de vez en
 * cuando— cabe en cuarenta y ocho píxeles.
 *
 * El raíl es `fixed` y el contenido lleva su margen: así la conversación puede
 * desplazarse sola, sin arrastrar la navegación con ella.
 */

const DESTINOS = [
  { href: "/", texto: "Líneas", Icono: IconoLineas },
  { href: "/equipo", texto: "Equipo", Icono: IconoGrupo },
  { href: "/claves", texto: "Claves", Icono: IconoLlave },
  { href: "/entregas", texto: "Entregas", Icono: IconoEntregas },
  { href: "/auditoria", texto: "Bitácora", Icono: IconoBitacora },
] as const;

function esActual(href: string, actual: string): boolean {
  return href === "/" ? actual === "/" || actual.startsWith("/lineas") : actual.startsWith(href);
}

export function Rail({ actual }: { actual: string }) {
  return (
    <nav
      aria-label="Secciones"
      className="fixed inset-y-0 left-0 z-30 flex w-14 flex-col items-center gap-1 border-r border-(--color-borde) bg-(--color-panel) py-3"
    >
      <Link
        href="/"
        aria-label="Omni, inicio"
        className="mb-2 flex size-9 items-center justify-center rounded-xl bg-(--color-acento) text-sm font-bold text-(--color-sobre-acento)"
      >
        o
      </Link>

      {DESTINOS.map(({ href, texto, Icono }) => {
        const activo = esActual(href, actual);
        return (
          <Link
            key={href}
            href={href}
            aria-label={texto}
            aria-current={activo ? "page" : undefined}
            // El `title` no sobra junto al `aria-label`: uno es para quien
            // navega con lector y el otro para quien se queda con el ratón
            // encima sin saber qué icono es cuál.
            title={texto}
            className={`relative flex size-10 items-center justify-center rounded-xl transition-colors duration-150 ${
              activo
                ? "bg-(--color-acento-tenue) text-(--color-acento-fuerte)"
                : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
            }`}
          >
            <Icono className="size-5" />
            {activo && (
              <span
                aria-hidden
                className="absolute -left-3 h-5 w-[3px] rounded-r-full bg-(--color-acento)"
              />
            )}
          </Link>
        );
      })}

      <form action="/entrar" method="get" className="mt-auto">
        <button
          type="submit"
          title="Salir"
          aria-label="Salir"
          className="flex size-10 items-center justify-center rounded-xl text-(--color-tenue) transition-colors duration-150 hover:bg-(--color-hundido) hover:text-(--color-error)"
        >
          <IconoSalir className="size-5" />
        </button>
      </form>
    </nav>
  );
}

/**
 * Página administrativa: raíl, título y contenido a medida de lectura.
 *
 * Estas pantallas son tablas y formularios, no conversaciones, así que llevan
 * un ancho máximo: una tabla de seis columnas estirada a 2500 píxeles obliga a
 * recorrer la pantalla con la cabeza para emparejar una fila con su valor.
 */
export function Pagina({
  actual, titulo, descripcion, acciones, children,
}: {
  actual: string;
  titulo: string;
  descripcion?: string;
  acciones?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <Rail actual={actual} />
      <div className="ml-14 min-h-dvh">
        <header className="border-b border-(--color-borde) bg-(--color-panel)">
          <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-4 px-8 py-6">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{titulo}</h1>
              {descripcion && (
                <p className="mt-1 max-w-2xl text-sm text-(--color-tenue)">{descripcion}</p>
              )}
            </div>
            {acciones}
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-8 py-7">{children}</main>
      </div>
    </>
  );
}
