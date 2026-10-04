import { redirect } from "next/navigation";
import { apiFetch, apiFetchAuth } from "@/lib/api";
import { Aviso } from "@/componentes/piezas";
import { Boton, Campo } from "@/lib/ui";
import { Pagina } from "@/componentes/armazon";

interface Capacidad {
  kind: string; risk: string; linkMethod: string;
  approxMemoryMbPerLine: number; capabilities: string[];
}

/**
 * Alta de una línea.
 *
 * El aviso de riesgo va AQUÍ y no en un rincón de la documentación: es el
 * momento exacto en que alguien decide enlazar un número, y las tres
 * referencias del sector coinciden en ponerlo por delante.
 */
export default async function NuevaLinea() {
  const capacidades = await apiFetchAuth<Capacidad[]>("/v1/capabilities");

  async function crear(formData: FormData): Promise<void> {
    "use server";
    const linea = await apiFetch<{ id: string }>("/v1/lines", {
      method: "POST",
      body: JSON.stringify({
        name: String(formData.get("nombre") ?? ""),
        slug: String(formData.get("slug") ?? ""),
        channelKind: String(formData.get("canal") ?? "sandbox"),
        sendRatePerMinute: Number(formData.get("ritmo") ?? 12),
      }),
    });
    redirect(`/lineas/${linea.id}`);
  }

  const noOficiales = capacidades.filter((c) => c.risk === "unofficial");

  return (
    <Pagina actual="/" titulo="Nueva línea" descripcion="Una línea es una cuenta de un canal. El riesgo depende del transporte que elijas, y se dice aquí antes de crearla.">
      <div className="space-y-5">
        {noOficiales.length > 0 && (
          <Aviso>
            <strong>Antes de enlazar un número de WhatsApp.</strong> Los transportes{" "}
            {noOficiales.map((c) => <code key={c.kind}>{c.kind} </code>)} conducen clientes
            <strong> no oficiales</strong>: va contra los términos de WhatsApp y la cuenta
            puede ser restringida o baneada. Usa un número que puedas permitirte perder,
            nunca el personal ni el principal del negocio. Para entornos regulados,{" "}
            <code>whatsapp.cloud</code>, que es la API oficial de Meta.
          </Aviso>
        )}

        <form action={crear} className="space-y-3 rounded-lg border border-(--color-borde) bg-(--color-panel) p-4">
          <Campo nombre="nombre" etiqueta="Nombre" requerido ayuda="Cómo la verás en el listado" />
          <Campo nombre="slug" etiqueta="Identificador" requerido ayuda="Minúsculas, números y guiones" />
          <Campo
            nombre="canal" etiqueta="Transporte" valor="sandbox"
            opciones={capacidades.map((c) => ({
              valor: c.kind,
              texto: `${c.kind} — ${c.risk === "official" ? "oficial" : c.risk === "simulated" ? "simulado" : "NO oficial"} · ${c.approxMemoryMbPerLine} MB/línea · ${c.capabilities.length} capacidades`,
            }))}
          />
          <Campo
            nombre="ritmo" etiqueta="Ritmo de envío" tipo="number" valor="12"
            ayuda="Mensajes por minuto. WhatsApp castiga la ráfaga más que el volumen: subirlo mucho acerca el baneo."
          />
          <Boton>Crear</Boton>
        </form>

        <section className="rounded-lg border border-(--color-borde) bg-(--color-panel) p-4">
          <h2 className="text-sm font-medium">Qué sabe hacer cada transporte</h2>
          <ul className="mt-2 space-y-1 text-xs text-(--color-tenue)">
            {capacidades.map((c) => (
              <li key={c.kind}>
                <code>{c.kind}</code> · enlace por {c.linkMethod} ·{" "}
                {c.capabilities.includes("group.read") ? "ve grupos" : "NO ve grupos"} ·{" "}
                {c.capabilities.includes("history.sync") ? "trae historial" : "sin historial"}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Pagina>
  );
}
