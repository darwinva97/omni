import { revalidatePath } from "next/cache";
import { apiFetch, apiFetchAuth, type Linea } from "@/lib/api";
import { Qr } from "@/componentes/qr";
import { Aviso, Estado } from "@/componentes/piezas";
import { IconoPersona } from "@/componentes/iconos";
import { RefrescarMientras } from "@/componentes/refrescar-mientras";

/**
 * El panel derecho cuando no hay ninguna conversación abierta.
 *
 * No es una pantalla vacía: es donde se resuelve lo único que puede impedir
 * que la línea sirva —que no esté enlazada— y donde se enseña el QR. Con la
 * línea conectada se aparta y deja ver que la columna de al lado es lo que hay
 * que usar.
 */
export default async function Linea({ params }: { params: Promise<{ lineId: string }> }) {
  const { lineId } = await params;

  const [lineas, estado] = await Promise.all([
    apiFetchAuth<Linea[]>("/v1/lines"),
    apiFetchAuth<{ state: string; qr?: string; self?: string }>(`/v1/lines/${lineId}/status`),
  ]);
  const linea = (lineas as Linea[]).find((l) => l.id === lineId);

  async function conectar(): Promise<void> {
    "use server";
    // Autoriza la API, no esta función: una *server function* es alcanzable
    // por cualquiera que conozca su identificador.
    await apiFetch(`/v1/lines/${lineId}/connect`, { method: "POST" });
    revalidatePath(`/lineas/${lineId}`);
  }

  const noOficial = linea?.channelKind === "whatsapp.baileys"
    || linea?.channelKind === "whatsapp.web";

  return (
    <div className="scroll-discreto flex h-full flex-col items-center justify-center overflow-y-auto bg-(--color-lienzo) px-8 py-10">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-(--color-borde) bg-(--color-panel) p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">{linea?.name ?? lineId}</h2>
              <p className="mt-0.5 text-sm text-(--color-tenue)">
                {linea?.channelKind}
                {estado.self && ` · +${estado.self.split("@")[0]}`}
              </p>
            </div>
            <Estado estado={estado.state} />
          </div>

          {/* Enlazando o conectando: se vuelve a preguntar hasta que quede conectada (y el QR,
              que caduca, se renueva). */}
          {(estado.state === "awaiting-link" || estado.state === "connecting") && <RefrescarMientras />}

          {estado.state === "awaiting-link" && estado.qr && (
            <div className="mt-5">
              <p className="text-sm font-medium">Enlaza el dispositivo</p>
              <p className="mt-1 text-sm text-(--color-tenue)">
                En el teléfono: WhatsApp → Dispositivos vinculados → Vincular un
                dispositivo.
              </p>
              <div className="mt-4 flex justify-center">
                <Qr valor={estado.qr} />
              </div>
              <p className="mt-3 text-center text-xs text-(--color-tenue)">
                Caduca en unos segundos y se regenera solo. Si no te da tiempo,
                recarga.
              </p>
            </div>
          )}

          {estado.state !== "connected" && estado.state !== "awaiting-link" && (
            <form action={conectar} className="mt-5">
              <button className="w-full rounded-lg bg-(--color-acento) px-4 py-2.5 text-sm font-medium text-(--color-sobre-acento) transition-opacity duration-150 hover:opacity-90">
                Conectar la línea
              </button>
            </form>
          )}

          {estado.state === "connected" && (
            <div className="mt-6 flex flex-col items-center gap-3 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-(--color-hundido) text-(--color-apagado)">
                <IconoPersona className="size-6" />
              </span>
              <p className="text-sm text-(--color-tenue)">
                Elige una conversación en la columna de la izquierda para leerla
                y responder.
              </p>
            </div>
          )}
        </div>

        {noOficial && (
          <div className="mt-4">
            <Aviso>
              Este transporte conduce un cliente <strong>no oficial</strong> de
              WhatsApp. La cuenta puede ser restringida o baneada, y ninguna
              calidad de código evita ese riesgo: usa un número que puedas
              permitirte perder.
            </Aviso>
          </div>
        )}
      </div>
    </div>
  );
}
