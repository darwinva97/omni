import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiFetch, apiFetchAuth, ApiError, type Linea, type Yo } from "@/lib/api";
import { PUBLIC_URL } from "@/lib/config";
import { Boton, Campo, SecretoUnaVez, Tabla } from "@/lib/ui-nav";
import { Pagina } from "@/componentes/armazon";
import { EditorAlcance, type Alcance } from "./editor-alcance";

interface Miembro extends Alcance { userId: string; email: string; name: string; role: string }

/** Solo estos roles admiten acceso limitado: gestionar algo exige verlo entero. */
const ACOTABLES = new Set(["agent", "viewer"]);

/** El campo `alcance` del editor. Vacío es que faltaba algo por marcar. */
function leerAlcance(formData: FormData): Alcance {
  const crudo = String(formData.get("alcance") ?? "");
  if (!crudo) {
    throw new ApiError(422, "falta por marcar: al menos una línea y, si limitas a chats, al menos un chat");
  }
  return JSON.parse(crudo) as Alcance;
}

function resumirAlcance(a: Alcance, nombreDeLinea: (id: string) => string): string {
  if (a.allowedLines.length === 0 && a.allowedChats.length === 0) return "Todo";
  const lineas = a.allowedLines.map(nombreDeLinea).join(", ");
  if (a.allowedChats.length === 0) return lineas;
  return `${a.allowedChats.length} chat${a.allowedChats.length === 1 ? "" : "s"} de ${lineas}`;
}

const ROLES = ["viewer", "agent", "manager", "owner"] as const;
const RANGO: Record<string, number> = { viewer: 0, agent: 1, manager: 2, owner: 3 };

/** El motivo que da la API («es el único owner…») le sirve más a quien gestiona que un error genérico. */
async function intentar(accion: () => Promise<unknown>): Promise<void> {
  try {
    await accion();
  } catch (err) {
    if (err instanceof ApiError) redirect(`/equipo?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  revalidatePath("/equipo");
  redirect("/equipo");
}

export default async function Equipo({
  searchParams,
}: {
  searchParams: Promise<{ invitacion?: string; error?: string; acceso?: string }>;
}) {
  const [{ invitacion, error, acceso }, yo, miembros, lineas] = await Promise.all([
    searchParams,
    apiFetchAuth<Yo>("/v1/auth/me"),
    apiFetchAuth<Miembro[]>("/v1/members"),
    apiFetchAuth<Linea[]>("/v1/lines"),
  ]);
  const nombreDeLinea = (id: string): string => lineas.find((l) => l.id === id)?.name ?? id;
  const elegibles = lineas.map((l) => ({ id: l.id, name: l.name }));

  // Nadie otorga un rol por encima del suyo: la API lo impone, y el panel no
  // ofrece lo que va a ser rechazado.
  const rangoPropio = RANGO[yo.role ?? "viewer"] ?? 0;
  const otorgables = ROLES.filter((r) => RANGO[r]! <= rangoPropio);
  const gestiona = yo.role === "owner";

  async function invitar(formData: FormData): Promise<void> {
    "use server";
    let token: string;
    try {
      const res = await apiFetch<{ token: string }>("/v1/invitations", {
        method: "POST",
        body: JSON.stringify({
          email: String(formData.get("correo") ?? ""),
          role: String(formData.get("rol") ?? "agent"),
          ...leerAlcance(formData),
        }),
      });
      token = res.token;
    } catch (err) {
      // «Solo se puede acotar a alguien con rol agent o viewer» le dice qué
      // cambiar; un error genérico no.
      if (err instanceof ApiError) redirect(`/equipo?error=${encodeURIComponent(err.message)}`);
      throw err;
    }
    revalidatePath("/equipo");
    redirect(`/equipo?invitacion=${encodeURIComponent(token)}`);
  }

  async function guardarAcceso(formData: FormData): Promise<void> {
    "use server";
    const userId = String(formData.get("usuario") ?? "");
    await intentar(async () => apiFetch(`/v1/members/${encodeURIComponent(userId)}/scope`, {
      method: "PUT",
      body: JSON.stringify(leerAlcance(formData)),
    }));
  }

  async function cambiarRol(formData: FormData): Promise<void> {
    "use server";
    const userId = String(formData.get("usuario") ?? "");
    await intentar(() => apiFetch(`/v1/members/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role: String(formData.get("rol") ?? "") }),
    }));
  }

  async function quitar(formData: FormData): Promise<void> {
    "use server";
    const userId = String(formData.get("usuario") ?? "");
    await intentar(() => apiFetch(`/v1/members/${encodeURIComponent(userId)}`, { method: "DELETE" }));
  }

  // El enlace entero, no el código suelto: es lo que se manda a la persona.
  const enlace = invitacion ? `${PUBLIC_URL}/unirse?codigo=${encodeURIComponent(invitacion)}` : null;

  // A quién se le está editando el acceso, si a alguien. Solo a quien se puede
  // gestionar y con un rol que lo admite: lo demás la API lo rechazaría.
  const editando = gestiona
    ? miembros.find((m) => m.userId === acceso && ACOTABLES.has(m.role) && (RANGO[m.role] ?? 0) <= rangoPropio)
    : undefined;

  return (
    <Pagina actual="/equipo" titulo="Equipo" descripcion="Quién entra al panel y con qué papel. Las invitaciones caducan.">
      <div className="space-y-5">
        {enlace && <SecretoUnaVez etiqueta="Enlace de invitación" valor={enlace} />}
        {error && (
          <p role="alert" className="rounded-xl border border-(--color-error) px-4 py-3 text-sm text-(--color-error)">
            {error}
          </p>
        )}

        {/* Ver el equipo es de todos; invitar y gestionar, solo de quien lo
            administra. Un formulario que siempre contesta «no puedes» no se enseña. */}
        {gestiona && (
        <section className="rounded-xl border border-(--color-borde) bg-(--color-panel) p-5">
          <h2 className="text-sm font-semibold">Invitar</h2>
          <p className="mt-1 text-sm text-(--color-tenue)">
            Manda el enlace a la persona: lo abre, entra con su cuenta y queda con este rol y
            este acceso. Caduca en siete días y solo se puede usar una vez.
          </p>
          <form action={invitar} className="mt-3 space-y-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Campo nombre="correo" etiqueta="Correo" tipo="email" requerido />
              <Campo
                nombre="rol" etiqueta="Rol" valor="agent"
                opciones={otorgables.map((r) => ({ valor: r, texto: r }))}
              />
            </div>
            {/* Se fija al invitar y no después: así entra ya acotada, sin un
                rato viéndolo todo hasta que alguien lo ajuste. */}
            <EditorAlcance lineas={elegibles} />
            <Boton>Invitar</Boton>
          </form>
        </section>
        )}

        {editando && (
          <section className="rounded-xl border border-(--color-acento) bg-(--color-panel) p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">Acceso de {editando.name}</h2>
                <p className="mt-1 text-sm text-(--color-tenue)">
                  Vale desde su siguiente clic; si tiene el panel abierto, deja de recibir al momento
                  lo que le quites.
                </p>
              </div>
              <Link href="/equipo" className="text-sm text-(--color-tenue) hover:text-(--color-texto)">Cerrar</Link>
            </div>
            <form action={guardarAcceso} className="mt-4 space-y-4">
              <input type="hidden" name="usuario" value={editando.userId} />
              <EditorAlcance
                lineas={elegibles}
                inicial={{ allowedLines: editando.allowedLines, allowedChats: editando.allowedChats }}
              />
              <Boton>Guardar acceso</Boton>
            </form>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-sm font-medium">Miembros</h2>
          <Tabla
            columnas={gestiona ? ["Nombre", "Correo", "Rol", "Acceso", ""] : ["Nombre", "Correo", "Rol"]}
            filas={miembros.map((m) => {
              const fila: React.ReactNode[] = [
                m.name + (m.userId === yo.id ? " (tú)" : ""),
                <span key="correo" className="text-xs text-(--color-tenue)">{m.email}</span>,
              ];
              const resumen = resumirAlcance(m, nombreDeLinea);
              // Solo se gestiona a quien no está por encima de uno mismo.
              if (!gestiona || (RANGO[m.role] ?? 0) > rangoPropio) {
                return [...fila, m.role, ...(gestiona ? [resumen, ""] : [])];
              }
              return [
                ...fila,
                <form key="rol" action={cambiarRol} className="flex items-end gap-2">
                  <input type="hidden" name="usuario" value={m.userId} />
                  <select
                    name="rol" defaultValue={m.role} aria-label={`Rol de ${m.name}`}
                    className="rounded-lg border border-(--color-borde) bg-(--color-panel) px-2 py-1.5 text-sm"
                  >
                    {otorgables.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <Boton tipo="sobrio">Cambiar</Boton>
                </form>,
                ACOTABLES.has(m.role) ? (
                  <Link
                    key="acceso"
                    href={`/equipo?acceso=${encodeURIComponent(m.userId)}`}
                    className="text-sm underline decoration-(--color-borde) underline-offset-4 hover:decoration-(--color-acento)"
                    title="Cambiar a qué líneas y chats llega"
                  >
                    {resumen}
                  </Link>
                ) : (
                  // Un manager o un owner lo ve todo: limitarle no tendría sentido.
                  <span key="acceso" className="text-sm text-(--color-tenue)">{resumen}</span>
                ),
                <form key="quitar" action={quitar}>
                  <input type="hidden" name="usuario" value={m.userId} />
                  <Boton peligro>Quitar</Boton>
                </form>,
              ];
            })}
          />
        </section>
      </div>
    </Pagina>
  );
}
