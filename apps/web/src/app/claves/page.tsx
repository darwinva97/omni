import { revalidatePath } from "next/cache";
import { apiFetch, apiFetchAuth } from "@/lib/api";
import { Boton, Campo, SecretoUnaVez, Tabla } from "@/lib/ui-nav";
import { Pagina } from "@/componentes/armazon";

interface Clave {
  id: string; name: string; role: string; prefix: string;
  allowedLines: string[]; allowedChats: string[];
  lastUsedAt: string | null; revokedAt: string | null;
}

export default async function Claves({
  searchParams,
}: {
  searchParams: Promise<{ nueva?: string }>;
}) {
  const [{ nueva }, claves] = await Promise.all([
    searchParams,
    apiFetchAuth<Clave[]>("/v1/api-keys"),
  ]);

  async function crear(formData: FormData): Promise<void> {
    "use server";
    const lista = (v: FormDataEntryValue | null): string[] =>
      String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

    const res = await apiFetch<{ apiKey: string }>("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: String(formData.get("nombre") ?? ""),
        role: String(formData.get("rol") ?? "operator"),
        allowedLines: lista(formData.get("lineas")),
        allowedChats: lista(formData.get("chats")),
      }),
    });
    // El secreto viaja por la URL una sola vez y no se guarda en ningún sitio.
    revalidatePath("/claves");
    const { redirect } = await import("next/navigation");
    redirect(`/claves?nueva=${encodeURIComponent(res.apiKey)}`);
  }

  async function revocar(formData: FormData): Promise<void> {
    "use server";
    await apiFetch(`/v1/api-keys/${encodeURIComponent(String(formData.get("id")))}`, {
      method: "DELETE",
    });
    revalidatePath("/claves");
  }

  return (
    <Pagina actual="/claves" titulo="Claves de API" descripcion="Cada clave lleva su propio alcance: a qué líneas llega y, si hace falta, a qué conversaciones. El secreto se enseña una sola vez.">
      <div className="space-y-5">
        {nueva && <SecretoUnaVez etiqueta="Clave creada" valor={nueva} />}

        <section className="rounded-xl border border-(--color-borde) bg-(--color-panel) p-5">
          <h2 className="text-sm font-semibold">Acuñar una clave</h2>
          <p className="mt-1 text-sm text-(--color-tenue)">
            Dejar <strong>líneas</strong> o <strong>chats</strong> en blanco significa
            «todas». Una clave acotada a chats solo alcanza las rutas marcadas como
            seguras para ella, también las que se añadan en el futuro.
          </p>
          <form action={crear} className="mt-3 grid gap-3 sm:grid-cols-2">
            <Campo nombre="nombre" etiqueta="Nombre" requerido ayuda="Para reconocerla luego" />
            <Campo
              nombre="rol" etiqueta="Rol" valor="operator"
              opciones={[
                { valor: "operator", texto: "operator — leer y enviar" },
                { valor: "viewer", texto: "viewer — solo leer" },
                { valor: "admin", texto: "admin — todo" },
              ]}
            />
            <Campo nombre="lineas" etiqueta="Líneas permitidas" ayuda="Separadas por comas; vacío = todas" />
            <Campo nombre="chats" etiqueta="Chats permitidos" ayuda="Separados por comas; vacío = todos" />
            <div className="sm:col-span-2"><Boton>Acuñar</Boton></div>
          </form>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium">Claves</h2>
          <Tabla
            columnas={["Nombre", "Rol", "Prefijo", "Alcance", "Último uso", ""]}
            filas={claves.map((k) => [
              <span className={k.revokedAt ? "text-(--color-tenue) line-through" : ""}>{k.name}</span>,
              k.role,
              <code className="text-xs">{k.prefix}</code>,
              <span className="text-xs text-(--color-tenue)">
                {k.allowedLines.length === 0 ? "todas las líneas" : `${k.allowedLines.length} línea(s)`}
                {k.allowedChats.length > 0 && ` · ${k.allowedChats.length} chat(s)`}
              </span>,
              <span className="text-xs text-(--color-tenue)">
                {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("es") : "nunca"}
              </span>,
              k.revokedAt ? (
                <span className="text-xs text-(--color-tenue)">revocada</span>
              ) : (
                <form action={revocar}>
                  <input type="hidden" name="id" value={k.id} />
                  <Boton tipo="sobrio">Revocar</Boton>
                </form>
              ),
            ])}
          />
        </section>
      </div>
    </Pagina>
  );
}
