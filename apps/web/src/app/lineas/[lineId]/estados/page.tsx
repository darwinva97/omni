import { apiFetchAuth, type Mensaje } from "@/lib/api";
import { Avatar } from "@/componentes/piezas";
import { Medio } from "@/componentes/medio";
import { cuando, hora } from "@/lib/formato";
import Link from "next/link";
import { IconoVolver } from "@/componentes/iconos";

interface EstadoDe {
  address: string;
  displayName: string;
  avatarUrl: string | null;
  ultimo: string;
  items: Mensaje[];
}

/**
 * Los estados, agrupados por quién los publicó.
 *
 * No son una conversación: todos llegan a la misma dirección, así que como
 * chat no significan nada —y colados entre los chats ponían «Estados» con el
 * nombre del último que publicó—. Lo que importa es quién publicó y qué, igual
 * que en el teléfono.
 *
 * Se enseñan los de las últimas 24 horas y se dice: WhatsApp los borra a ese
 * plazo, y mostrar los de la semana pasada como si siguieran ahí sería mentir
 * sobre lo que esa persona tiene publicado.
 */
export default async function Estados({
  params,
}: {
  params: Promise<{ lineId: string }>;
}) {
  const { lineId } = await params;
  const autores = await apiFetchAuth<EstadoDe[]>(`/v1/lines/${lineId}/statuses?horas=24`)
    .catch(() => [] as EstadoDe[]);

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
        <h1 className="text-sm font-semibold">Estados</h1>
        <p className="text-xs text-(--color-tenue)">
          De las últimas 24 horas. Pasado ese plazo WhatsApp los borra.
        </p>
        </div>
      </header>

      {autores.length === 0 ? (
        <p className="px-6 py-16 text-center text-sm text-(--color-tenue)">
          Nadie ha publicado nada en las últimas 24 horas.
        </p>
      ) : (
        <ul className="mx-auto max-w-3xl space-y-4 px-6 py-6">
          {autores.map((a) => (
            <li
              key={a.address}
              className="overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel)"
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <Avatar
                  nombre={a.displayName}
                  direccion={a.address}
                  kind="pn"
                  url={a.avatarUrl}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{a.displayName}</p>
                  <p className="text-xs text-(--color-tenue)">
                    {a.items.length === 1 ? "1 estado" : `${a.items.length} estados`}
                    {` · ${cuando(a.ultimo)}`}
                  </p>
                </div>
              </div>

              {/*
                En fila horizontal y no en rejilla: los estados se miran en
                orden, uno detrás de otro, y una rejilla sugiere que da igual
                por cuál empezar.
              */}
              <ul className="scroll-discreto flex gap-3 overflow-x-auto border-t border-(--color-borde-sutil) px-4 py-3">
                {a.items.map((m) => (
                  <li key={m.id} className="w-44 shrink-0">
                    {m.media ? (
                      <Medio kind={m.kind} medio={m.media} error={m.mediaError} />
                    ) : (
                      <p className="flex min-h-28 items-center justify-center rounded-lg bg-(--color-hundido) px-3 py-4 text-center text-sm">
                        {m.body ?? <em className="text-(--color-tenue)">Sin texto</em>}
                      </p>
                    )}
                    {m.media && m.body && (
                      <p className="mt-1 text-xs wrap-anywhere">{m.body}</p>
                    )}
                    <p className="mt-1 text-[11px] text-(--color-apagado)">
                      <time dateTime={m.timestamp}>{hora(m.timestamp)}</time>
                    </p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
