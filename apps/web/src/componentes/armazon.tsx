import Link from "next/link";
import { FranjaDeLineas } from "./franja-lineas";
import {
  IconoBitacora, IconoEntregas, IconoGrupo, IconoLineas, IconoLlave, IconoRayo, IconoRespuestas,
  IconoSalir,
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
  { href: "/respuestas", texto: "Respuestas rápidas", Icono: IconoRespuestas },
  { href: "/automatizaciones", texto: "Automatizaciones", Icono: IconoRayo },
  { href: "/claves", texto: "Claves", Icono: IconoLlave },
  { href: "/entregas", texto: "Entregas", Icono: IconoEntregas },
  { href: "/auditoria", texto: "Bitácora", Icono: IconoBitacora },
] as const;

function esActual(href: string, actual: string): boolean {
  return href === "/" ? actual === "/" || actual.startsWith("/lineas") : actual.startsWith(href);
}

export function Rail({ actual }: { actual: string }) {
  return (
    /*
     * Lateral en escritorio, abajo en móvil.
     *
     * Catorce de ancho no se notan en un portátil; en un teléfono de 390 son
     * el 14% de la pantalla robado a la conversación. Abajo, además, cae donde
     * llega el pulgar.
     */
    <nav
      aria-label="Secciones"
      className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around gap-1 border-t border-(--color-borde) bg-(--color-panel) px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:inset-x-auto md:inset-y-0 md:left-0 md:w-14 md:flex-col md:justify-start md:border-t-0 md:border-r md:px-0 md:py-3"
    >
      {/* El logotipo solo en escritorio: en una barra inferior llena de
          destinos, otro botón más que lleva al primero es ruido. */}
      <Link
        href="/"
        aria-label="Omni, inicio"
        className="mb-2 hidden size-9 items-center justify-center rounded-xl bg-(--color-acento) text-sm font-bold text-(--color-sobre-acento) md:flex"
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
                className="absolute -top-1.5 h-[3px] w-5 rounded-b-full bg-(--color-acento) md:-left-3 md:top-auto md:h-5 md:w-[3px] md:rounded-b-none md:rounded-r-full"
              />
            )}
          </Link>
        );
      })}

      <form action="/entrar" method="get" className="hidden md:mt-auto md:block">
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
      <div className="min-h-dvh pb-16 md:ml-14 md:pb-0">
        <FranjaDeLineas />
        <header className="border-b border-(--color-borde) bg-(--color-panel)">
          <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-4 px-5 py-5 md:px-8 md:py-6">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{titulo}</h1>
              {descripcion && (
                <p className="mt-1 max-w-2xl text-sm text-(--color-tenue)">{descripcion}</p>
              )}
            </div>
            {acciones}
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-5 py-6 md:px-8 md:py-7">{children}</main>
      </div>
    </>
  );
}
