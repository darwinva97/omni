import { apiFetchAuth } from "@/lib/api";
import { Cabecera } from "@/lib/ui";
import { Navegacion, Tabla } from "@/lib/ui-nav";

interface Entrega {
  id: string; event: string; status: string; attempt: number;
  responseStatus: number | null; error: string | null;
  durationMs: number | null; createdAt: string;
}

/**
 * Intentos de entrega de webhooks.
 *
 * Existe porque un webhook que falla tiene que ser VISIBLE. En el gateway
 * anterior el error iba a `console.error` y nadie lo veía nunca: quien
 * integraba descubría que faltaban eventos cuando ya era tarde.
 */
export default async function Entregas() {
  const entregas = await apiFetchAuth<Entrega[]>("/v1/dispatches?limit=100");

  const tono: Record<string, string> = {
    delivered: "text-green-700 dark:text-green-400",
    failed: "text-amber-700 dark:text-amber-400",
    dead: "text-red-700 dark:text-red-400",
  };
  const etiqueta: Record<string, string> = {
    delivered: "entregado", failed: "falló", dead: "agotado", pending: "pendiente",
  };

  const muertas = entregas.filter((e) => e.status === "dead").length;

  return (
    <>
      <Cabecera titulo="entregas de webhooks" />
      <Navegacion actual="/entregas" />
      <main className="mx-auto max-w-5xl space-y-4 px-5 py-6">
        {muertas > 0 && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <strong>{muertas} entrega{muertas > 1 ? "s" : ""} agotó sus intentos.</strong>{" "}
            Esos eventos no llegaron a su destino y no se reintentarán solos.
          </div>
        )}

        <Tabla
          columnas={["Evento", "Estado", "Intento", "Respuesta", "Duración", "Cuándo"]}
          filas={entregas.map((e) => [
            <code className="text-xs">{e.event}</code>,
            <span className={tono[e.status] ?? ""}>{etiqueta[e.status] ?? e.status}</span>,
            e.attempt,
            <span className="text-xs">
              {e.responseStatus ?? <span className="text-(--color-tenue)">—</span>}
              {e.error && <span className="block text-(--color-tenue)">{e.error.slice(0, 60)}</span>}
            </span>,
            <span className="text-xs text-(--color-tenue)">{e.durationMs != null ? `${e.durationMs} ms` : "—"}</span>,
            <span className="text-xs text-(--color-tenue)">{new Date(e.createdAt).toLocaleString("es")}</span>,
          ])}
        />
      </main>
    </>
  );
}
