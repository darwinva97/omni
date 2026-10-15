import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch, apiFetchAuth, type Yo } from "@/lib/api";
import { Boton, Campo } from "@/lib/ui-nav";
import { Aviso } from "@/componentes/piezas";
import { Pagina } from "@/componentes/armazon";

interface Respuesta { id: string; shortcut: string; text: string; updatedAt: string }

/*
 * Lo que la API rechaza —un atajo repetido, uno con espacios— vuelve a esta
 * misma página con el motivo Y con lo escrito (`vuelta`), en el formulario de
 * donde salió. Una pantalla de error genérica, o un formulario vacío, obligaría
 * a reescribir el texto entero por culpa del atajo.
 *
 * Fuera del componente y SIN «use server»: es un ayudante de las acciones, no
 * una acción. Como acción, cualquiera podría llamarla con la ruta que quisiera.
 */
async function llamar(
  path: string, init: RequestInit, vuelta: Record<string, string> = {},
): Promise<void> {
  let motivo: string | null = null;
  try {
    await apiFetch(path, init);
  } catch (e) {
    motivo = e instanceof ApiError ? e.message : "no se pudo guardar";
  }
  revalidatePath("/respuestas");
  // `redirect` lanza: va fuera del try para que no lo tome por un fallo.
  if (motivo) redirect(`/respuestas?${new URLSearchParams({ error: motivo, ...vuelta })}`);
  redirect("/respuestas");
}

/** Lo mismo que `Campo`, pero de varias líneas: una respuesta puede tener párrafos. */
const AREA =
  "mt-1.5 w-full resize-y rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm leading-5 outline-none transition-colors duration-150 focus:border-(--color-acento) focus:ring-2 focus:ring-(--color-acento)/25";

/**
 * Respuestas rápidas de la organización.
 *
 * Se usan desde la conversación, escribiendo «/atajo» al principio del campo;
 * aquí solo se crean, se corrigen y se borran. Cambiarlas es de quien
 * gestiona —lo que dicen sale a los clientes en nombre de todo el equipo—, así
 * que a los demás se les enseñan sin formularios en vez de dejarles rellenar
 * uno que la API va a rechazar.
 */
export default async function Respuestas({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; editar?: string; atajo?: string; texto?: string }>;
}) {
  const [{ error, editar, atajo, texto }, respuestas, yo] = await Promise.all([
    searchParams,
    apiFetchAuth<Respuesta[]>("/v1/quick-replies"),
    apiFetchAuth<Yo>("/v1/auth/me"),
  ]);
  const gestiona = yo.role === "owner" || yo.role === "manager";

  async function crear(formData: FormData): Promise<void> {
    "use server";
    const atajo = String(formData.get("atajo") ?? "");
    const texto = String(formData.get("texto") ?? "");
    await llamar("/v1/quick-replies", {
      method: "POST",
      body: JSON.stringify({ shortcut: atajo, text: texto }),
    }, { atajo, texto });
  }

  async function guardar(formData: FormData): Promise<void> {
    "use server";
    const id = String(formData.get("id"));
    const atajo = String(formData.get("atajo") ?? "");
    const texto = String(formData.get("texto") ?? "");
    await llamar(`/v1/quick-replies/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ shortcut: atajo, text: texto }),
    }, { editar: id, atajo, texto });
  }

  async function borrar(formData: FormData): Promise<void> {
    "use server";
    await llamar(`/v1/quick-replies/${encodeURIComponent(String(formData.get("id")))}`, {
      method: "DELETE",
    });
  }

  return (
    <Pagina
      actual="/respuestas"
      titulo="Respuestas rápidas"
      descripcion="Textos guardados de toda la organización. En una conversación, escribe «/» al principio del campo y elige uno: se inserta para retocarlo antes de enviar."
    >
      <div className="space-y-5">
        {error && <Aviso tono="error">{error}</Aviso>}

        {gestiona ? (
          <section className="rounded-xl border border-(--color-borde) bg-(--color-panel) p-5">
            <h2 className="text-sm font-semibold">Nueva respuesta</h2>
            <form action={crear} className="mt-3 grid gap-3 sm:grid-cols-[12rem_1fr]">
              <Campo
                nombre="atajo" etiqueta="Atajo" requerido marcador="/precios"
                ayuda="Una palabra, sin espacios"
                {...(!editar && atajo ? { valor: atajo } : {})}
              />
              <label className="block">
                <span className="text-sm font-medium">Texto</span>
                <textarea name="texto" required rows={3} maxLength={4096} className={AREA}
                  defaultValue={!editar ? texto : undefined}
                  placeholder="El plan anual cuesta 120 €, con factura." />
              </label>
              <div className="sm:col-span-2"><Boton>Guardar</Boton></div>
            </form>
          </section>
        ) : (
          <Aviso>Las crea y las cambia quien gestiona la organización. Tú puedes usarlas en cualquier conversación.</Aviso>
        )}

        <section>
          <h2 className="mb-2 text-sm font-medium">
            {respuestas.length === 0 ? "Todavía no hay ninguna" : `${respuestas.length} ${respuestas.length === 1 ? "respuesta" : "respuestas"}`}
          </h2>
          {respuestas.length === 0 ? (
            <p className="rounded-xl border border-dashed border-(--color-borde) px-4 py-10 text-center text-sm text-(--color-tenue)">
              Guarda aquí lo que el equipo escribe una y otra vez: precios, horarios, cómo pagar.
            </p>
          ) : (
            <ul className="divide-y divide-(--color-borde-sutil) overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel)">
              {respuestas.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  {editar === r.id && gestiona ? (
                    <form action={guardar} className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                      <input type="hidden" name="id" value={r.id} />
                      <Campo nombre="atajo" etiqueta="Atajo" requerido valor={atajo ?? `/${r.shortcut}`} />
                      <label className="block">
                        <span className="text-sm font-medium">Texto</span>
                        <textarea name="texto" required rows={3} maxLength={4096} defaultValue={texto ?? r.text} className={AREA} />
                      </label>
                      <div className="flex gap-2 sm:col-span-2">
                        <Boton>Guardar</Boton>
                        <Link href="/respuestas" className="inline-flex items-center rounded-lg px-3.5 py-2 text-sm text-(--color-tenue) hover:bg-(--color-hundido)">
                          Cancelar
                        </Link>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-start gap-4">
                      <code className="w-40 shrink-0 truncate pt-0.5 text-sm font-medium text-(--color-acento-fuerte)">
                        /{r.shortcut}
                      </code>
                      <p className="min-w-0 flex-1 text-sm whitespace-pre-wrap wrap-anywhere">{r.text}</p>
                      {gestiona && (
                        <div className="flex shrink-0 items-center gap-1">
                          <Link
                            href={`/respuestas?editar=${encodeURIComponent(r.id)}`}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-(--color-hundido)"
                          >
                            Editar
                          </Link>
                          <form action={borrar}>
                            <input type="hidden" name="id" value={r.id} />
                            <button
                              type="submit"
                              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-(--color-error) hover:bg-(--color-error-tenue)"
                            >
                              Borrar
                            </button>
                          </form>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Pagina>
  );
}
