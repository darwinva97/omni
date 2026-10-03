import Link from "next/link";
import { revalidatePath } from "next/cache";
import { apiFetch, apiFetchAuth, type Chat, type Linea } from "@/lib/api";
import { Cabecera, Estado, Vacio } from "@/lib/ui";
import { Qr } from "@/componentes/qr";

/**
 * Detalle de una línea: su estado, su QR si toca enlazar, y sus conversaciones.
 */
export default async function DetalleLinea({ params }: { params: Promise<{ lineId: string }> }) {
  const { lineId } = await params;

  const [linea, estado, chats] = await Promise.all([
    apiFetchAuth<Linea>(`/v1/lines`).then((ls) => (ls as unknown as Linea[]).find((l) => l.id === lineId)),
    apiFetchAuth<{ state: string; qr?: string; self?: string }>(`/v1/lines/${lineId}/status`),
    apiFetchAuth<Chat[]>(`/v1/lines/${lineId}/chats?limit=100`).catch(() => [] as Chat[]),
  ]);

  async function conectar(): Promise<void> {
    "use server";
    // Autoriza la API, no esta función: una *server function* es alcanzable por
    // POST directo, así que no puede fiarse de que el botón solo salga cuando toca.
    await apiFetch(`/v1/lines/${lineId}/connect`, { method: "POST" });
    revalidatePath(`/lineas/${lineId}`);
  }

  async function desconectar(): Promise<void> {
    "use server";
    await apiFetch(`/v1/lines/${lineId}/disconnect`, { method: "POST" });
    revalidatePath(`/lineas/${lineId}`);
  }

  return (
    <>
      <Cabecera titulo={linea?.name ?? lineId} volver={{ href: "/", texto: "líneas" }} />
      <main className="mx-auto max-w-5xl space-y-5 px-5 py-6">
        <section className="flex flex-wrap items-center gap-3 rounded-lg border border-(--color-borde) bg-(--color-panel) px-4 py-3">
          <Estado estado={estado.state} />
          {estado.self && <span className="text-sm text-(--color-tenue)">{estado.self}</span>}
          <span className="ml-auto flex gap-2">
            {estado.state !== "connected" && (
              <form action={conectar}>
                <button className="rounded-lg bg-(--color-acento) px-3 py-1.5 text-sm text-white hover:opacity-90">
                  Conectar
                </button>
              </form>
            )}
            {estado.state === "connected" && (
              <form action={desconectar}>
                <button className="rounded-lg border border-(--color-borde) px-3 py-1.5 text-sm hover:bg-(--color-ajeno)">
                  Desconectar
                </button>
              </form>
            )}
          </span>
        </section>

        {estado.state === "awaiting-link" && estado.qr && (
          <section className="rounded-lg border border-(--color-borde) bg-(--color-panel) p-4">
            <h2 className="text-sm font-medium">Enlaza el dispositivo</h2>
            <p className="mt-1 text-xs text-(--color-tenue)">
              WhatsApp → Dispositivos vinculados → Vincular un dispositivo.
            </p>
            <Qr valor={estado.qr} />
            <p className="mt-2 text-xs text-(--color-tenue)">
              Caduca en unos segundos y se regenera solo: si no te da tiempo,
              recarga la página.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-(--color-tenue)">
                Ver la cadena en crudo
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-(--color-ajeno) p-3 text-[10px] leading-tight break-all whitespace-pre-wrap">
                {estado.qr}
              </pre>
            </details>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-sm font-medium">Conversaciones</h2>
          {chats.length === 0 ? (
            <Vacio>Sin conversaciones todavía.</Vacio>
          ) : (
            <ul className="divide-y divide-(--color-borde) overflow-hidden rounded-lg border border-(--color-borde) bg-(--color-panel)">
              {chats.map((c) => (
                <li key={c.address}>
                  <Link
                    href={`/lineas/${lineId}/chats/${encodeURIComponent(c.address)}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-(--color-ajeno)"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{c.title ?? c.address}</span>
                      <span className="block text-xs text-(--color-tenue)">
                        {c.kind === "group" ? "grupo" : "contacto"}
                        {c.lastMessageAt && ` · ${new Date(c.lastMessageAt).toLocaleString("es")}`}
                      </span>
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="rounded-full bg-(--color-acento) px-2 py-0.5 text-xs text-white">
                        {c.unreadCount}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
