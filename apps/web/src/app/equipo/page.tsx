import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiFetch, apiFetchAuth, ApiError, type Linea, type Yo } from "@/lib/api";
import { PUBLIC_URL } from "@/lib/config";
import { Boton, Campo, SecretoUnaVez } from "@/lib/ui-nav";
import { Pagina } from "@/componentes/armazon";
import { EditorAlcance, type Alcance } from "./editor-alcance";

interface Miembro extends Alcance {
  userId: string; email: string; name: string; role: string;
  /** Las que dio de alta ella: las conserva enteras sea cual sea su acceso. */
  ownLines: string[];
}

/** Solo estos roles admiten acceso limitado: gestionar algo exige verlo entero. */
const ACOTABLES = new Set(["agent", "viewer"]);

/** El campo `alcance` del editor. Vacío es que faltaba algo por marcar. */
function leerAlcance(formData: FormData): Alcance {
  const crudo = String(formData.get("alcance") ?? "");
  if (!crudo) {
    throw new ApiError(422, "falta por marcar: si limitas a unos chats, su línea y al menos un chat");
  }
  return JSON.parse(crudo) as Alcance;
}

function resumirAlcance(a: Alcance & { ownLines: string[] }, nombreDeLinea: (id: string) => string): string {
  const crea = a.canCreateLines ? " · crea líneas" : "";
  if (!a.restricted) return `Todo${crea}`;
  const suyas = a.ownLines.length > 0
    ? `${a.ownLines.length === 1 ? "su línea" : `sus ${a.ownLines.length} líneas`} (${a.ownLines.map(nombreDeLinea).join(", ")})`
    : "";
  const lineas = a.allowedLines.map(nombreDeLinea).join(", ");
  const tuyas = a.allowedLines.length === 0
    ? ""
    : a.allowedChats.length === 0
      ? lineas
      : `${a.allowedChats.length} chat${a.allowedChats.length === 1 ? "" : "s"} de ${lineas}`;
  const partes = [tuyas, suyas].filter(Boolean);
  if (partes.length === 0) return a.canCreateLines ? "Solo las líneas que cree" : "Nada";
  return `${partes.join(" + ")}${crea}`;
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

        {editando && (
          // Arriba del todo y con ancla: en el móvil, debajo del formulario de
          // invitar quedaba fuera de la vista y parecía que no había pasado nada.
          <section id="acceso" className="scroll-mt-4 rounded-xl border border-(--color-acento) bg-(--color-panel) p-5">
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
                propias={editando.ownLines}
                inicial={{
                  restricted: editando.restricted, allowedLines: editando.allowedLines,
                  allowedChats: editando.allowedChats, canCreateLines: editando.canCreateLines,
                }}
              />
              <Boton>Guardar acceso</Boton>
            </form>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-sm font-medium">Miembros</h2>
          {/*
            Antes que «Invitar»: gestionar a quien ya está es lo de cada día;
            invitar, de vez en cuando. Tarjetas y no tabla: con cinco columnas, en el móvil «Acceso» quedaba
            fuera de la pantalla, detrás de un desplazamiento que nadie descubre.
          */}
          <ul className="divide-y divide-(--color-borde-sutil) overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel)">
            {miembros.map((m) => {
              const resumen = resumirAlcance(m, nombreDeLinea);
              // Solo se gestiona a quien no está por encima de uno mismo.
              const gestionable = gestiona && (RANGO[m.role] ?? 0) <= rangoPropio;
              return (
                <li key={m.userId} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{m.name}{m.userId === yo.id ? " (tú)" : ""}</p>
                    <p className="truncate text-xs text-(--color-tenue)">{m.email}</p>
                    {gestiona && (
                      <p className="mt-1.5 text-xs text-(--color-tenue)">
                        <span className="font-medium text-(--color-texto)">Acceso:</span> {resumen}
                      </p>
                    )}
                  </div>

                  {!gestionable ? (
                    <span className="text-sm text-(--color-tenue)">{m.role}</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={cambiarRol} className="flex items-center gap-2">
                        <input type="hidden" name="usuario" value={m.userId} />
                        <select
                          name="rol" defaultValue={m.role} aria-label={`Rol de ${m.name}`}
                          className="rounded-lg border border-(--color-borde) bg-(--color-panel) px-2 py-1.5 text-sm"
                        >
                          {/* A quien tiene el acceso limitado no se le ofrece un rol
                              que no lo admite: la API lo rechazaría. */}
                          {otorgables.map((r) => (
                            // Solo el nombre: un select mide lo que su opción más larga,
                            // y un motivo largo aquí sacaba los botones de la pantalla.
                            <option
                              key={r} value={r} disabled={m.restricted && !ACOTABLES.has(r)}
                              title={m.restricted && !ACOTABLES.has(r) ? "Quítale antes el límite de acceso" : undefined}
                            >
                              {r}
                            </option>
                          ))}
                        </select>
                        <Boton tipo="sobrio">Cambiar</Boton>
                      </form>
                      {/* Un manager o un owner lo ve todo: limitarle no tendría sentido. */}
                      {ACOTABLES.has(m.role) && (
                        <Link
                          href={`/equipo?acceso=${encodeURIComponent(m.userId)}#acceso`}
                          className="inline-flex items-center justify-center rounded-lg border border-(--color-acento) px-3.5 py-2 text-sm font-medium text-(--color-acento-fuerte) transition-colors duration-150 hover:bg-(--color-acento-tenue)"
                        >
                          Cambiar acceso
                        </Link>
                      )}
                      <form action={quitar}>
                        <input type="hidden" name="usuario" value={m.userId} />
                        <Boton peligro>Quitar</Boton>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
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
            <Campo nombre="correo" etiqueta="Correo" tipo="email" requerido />
            {/* Se fija al invitar y no después: así entra ya acotada, sin un
                rato viéndolo todo hasta que alguien lo ajuste. El rol va dentro
                del editor porque se condicionan el uno al otro. */}
            <EditorAlcance lineas={elegibles} roles={otorgables} />
            <Boton>Invitar</Boton>
          </form>
        </section>
        )}

      </div>
    </Pagina>
  );
}
