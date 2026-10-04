import { apiFetchAuth } from "@/lib/api";
import { Tabla } from "@/lib/ui-nav";
import { Pagina } from "@/componentes/armazon";

interface Evento {
  action: string; targetKind: string | null; targetId: string | null;
  actorUserId: string | null; actorApiKeyId: string | null;
  ip: string | null; at: string;
}

/** Quién hizo qué, con qué credencial y desde dónde. Siempre activa. */
export default async function Auditoria() {
  const eventos = await apiFetchAuth<Evento[]>("/v1/audit?limit=100");

  return (
    <Pagina actual="/auditoria" titulo="Bitácora" descripcion="Quién hizo qué, con qué credencial y desde dónde.">
      <div className="space-y-5">
        <p className="text-xs text-(--color-tenue)">
          No se puede desactivar desde la aplicación: quién creó, borró, conectó o
          cambió un rol queda registrado siempre.
        </p>
        <Tabla
          columnas={["Acción", "Sobre qué", "Quién", "IP", "Cuándo"]}
          filas={eventos.map((e) => [
            <code className="text-xs">{e.action}</code>,
            <span className="text-xs text-(--color-tenue)">
              {e.targetKind ?? "—"}
              {e.targetId && <span className="block">{e.targetId.slice(0, 24)}</span>}
            </span>,
            <span className="text-xs text-(--color-tenue)">
              {e.actorUserId ? `persona ${e.actorUserId.slice(0, 12)}` : e.actorApiKeyId ? `clave ${e.actorApiKeyId.slice(0, 12)}` : "—"}
            </span>,
            <span className="text-xs text-(--color-tenue)">{e.ip ?? "—"}</span>,
            <span className="text-xs text-(--color-tenue)">{new Date(e.at).toLocaleString("es")}</span>,
          ])}
        />
      </div>
    </Pagina>
  );
}
