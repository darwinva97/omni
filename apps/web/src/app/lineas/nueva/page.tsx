import { redirect } from "next/navigation";
import { apiFetch, apiFetchAuth, ApiError } from "@/lib/api";
import { aIdentificador } from "@/lib/identificador";
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
export default async function NuevaLinea({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ error }, capacidades] = await Promise.all([
    searchParams,
    apiFetchAuth<Capacidad[]>("/v1/capabilities"),
  ]);

  async function crear(formData: FormData): Promise<void> {
    "use server";
    const nombre = String(formData.get("nombre") ?? "").trim();
    const base = aIdentificador(String(formData.get("slug") ?? "")) || aIdentificador(nombre) || "linea";
    const ritmo = Number(formData.get("ritmo") ?? 12);
    let id: string | null = null;
    let problema: string | null = null;
    /* Un identificador que ya usa otra línea no es un error del usuario: se prueba el
       siguiente («ventas-2», «ventas-3»…). Cualquier otro rechazo vuelve al formulario con
       el motivo, en vez de tumbar la página. */
    for (let i = 1; i <= 9 && !id && !problema; i++) {
      const slug = i === 1 ? base : `${base.slice(0, 56)}-${i}`;
      try {
        id = (await apiFetch<{ id: string }>("/v1/lines", {
          method: "POST",
          body: JSON.stringify({
            name: nombre || slug,
            slug,
            channelKind: String(formData.get("canal") ?? "sandbox"),
            sendRatePerMinute: Number.isFinite(ritmo) && ritmo > 0 ? Math.round(ritmo) : 12,
          }),
        })).id;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) continue;
        problema = err instanceof ApiError
          ? (err.status === 422 ? "Revisa los datos: el nombre es obligatorio y el ritmo, un número." : err.message)
          : "No se pudo crear la línea. Vuelve a intentarlo.";
      }
    }
    if (!id) redirect(`/lineas/nueva?error=${encodeURIComponent(problema ?? "Ya hay muchas líneas con ese identificador: elige otro.")}`);
    redirect(`/lineas/${id}`);
  }

  const noOficiales = capacidades.filter((c) => c.risk === "unofficial");

  return (
    <Pagina actual="/" titulo="Nueva línea" descripcion="Una línea es una cuenta de un canal. El riesgo depende del transporte que elijas, y se dice aquí antes de crearla.">
      <div className="space-y-5">
        {error && <Aviso tono="error">{error}</Aviso>}
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
          <Campo nombre="slug" etiqueta="Identificador (opcional)" ayuda="Si lo dejas vacío sale del nombre. Mayúsculas, tildes y espacios se arreglan solos." />
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
