import Link from "next/link";
import { apiFetchAuth, type Chat } from "@/lib/api";
import { Avatar } from "@/componentes/piezas";
import { cuando } from "@/lib/formato";
import { IconoVolver } from "@/componentes/iconos";

/**
 * Los canales que sigue esta línea.
 *
 * Fuera de la lista de conversaciones a propósito: en un canal nadie contesta,
 * es difusión, y entre los chats era una fila que nunca tiene a nadie al otro
 * lado. Aquí se ven juntos y por lo último que publicaron, que es lo que
 * importa de un canal.
 *
 * Cada uno se abre en la vista de conversación de siempre: lo publicado es una
 * sucesión de mensajes, con sus fotos y sus vídeos, y esa vista ya sabe
 * pintarlos todos.
 */
export default async function Canales({
  params,
}: {
  params: Promise<{ lineId: string }>;
}) {
  const { lineId } = await params;
  const chats = await apiFetchAuth<Chat[]>(`/v1/lines/${lineId}/chats?limit=200`)
    .catch(() => [] as Chat[]);
  const canales = chats.filter((c) => c.kind === "newsletter");

  return (
    <div className="scroll-discreto h-full overflow-y-auto bg-(--color-lienzo)">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-(--color-borde) bg-(--color-panel) px-4 py-3.5 md:px-6">
        <Link
          href={`/lineas/${lineId}`}
          aria-label="Volver a las conversaciones"
          className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) md:hidden"
        >
          <IconoVolver className="size-5" />
        </Link>
        <div>
          <h1 className="text-sm font-semibold">Canales</h1>
          <p className="text-xs text-(--color-tenue)">
            Los que sigue esta línea. Solo publica quien los administra.
          </p>
        </div>
      </header>

      {canales.length === 0 ? (
        <p className="px-6 py-16 text-center text-sm text-(--color-tenue)">
          Esta línea no sigue ningún canal, o todavía no ha llegado nada de
          ninguno.
        </p>
      ) : (
        <ul className="mx-auto max-w-3xl divide-y divide-(--color-borde-sutil) py-2">
          {canales.map((c) => (
            <li key={c.address}>
              <Link
                href={`/lineas/${lineId}/chats/${encodeURIComponent(c.address)}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-(--color-panel) md:px-6"
              >
                <Avatar
                  nombre={c.displayName}
                  direccion={c.address}
                  kind={c.kind}
                  url={c.avatarUrl}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.displayName}</span>
                    <span className="shrink-0 text-[11px] text-(--color-apagado)">
                      {cuando(c.lastMessageAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-(--color-tenue)">
                      {c.ultimo ?? "Sin publicaciones todavía"}
                    </span>
                    {c.unreadCount > 0 && (
                      // Apagado y no en el color de aviso: un canal no pide
                      // respuesta, y su contador no debe competir con el de
                      // una persona que está esperando.
                      <span className="flex min-w-5 shrink-0 justify-center rounded-full bg-(--color-hundido) px-1.5 text-[11px] leading-5 font-semibold text-(--color-tenue)">
                        {c.unreadCount > 99 ? "99+" : c.unreadCount}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
