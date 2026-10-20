import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiFetch, apiFetchAuth, ApiError, type Yo } from "@/lib/api";
import { PUBLIC_URL } from "@/lib/config";
import { Boton, Campo, SecretoUnaVez, Tabla } from "@/lib/ui-nav";
import { Pagina } from "@/componentes/armazon";

interface Miembro { userId: string; email: string; name: string; role: string }

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
  searchParams: Promise<{ invitacion?: string; error?: string }>;
}) {
  const [{ invitacion, error }, yo, miembros] = await Promise.all([
    searchParams,
    apiFetchAuth<Yo>("/v1/auth/me"),
    apiFetchAuth<Miembro[]>("/v1/members"),
  ]);

  // Nadie otorga un rol por encima del suyo: la API lo impone, y el panel no
  // ofrece lo que va a ser rechazado.
  const rangoPropio = RANGO[yo.role ?? "viewer"] ?? 0;
  const otorgables = ROLES.filter((r) => RANGO[r]! <= rangoPropio);
  const gestiona = yo.role === "owner";

  async function invitar(formData: FormData): Promise<void> {
    "use server";
    const res = await apiFetch<{ token: string }>("/v1/invitations", {
      method: "POST",
      body: JSON.stringify({
        email: String(formData.get("correo") ?? ""),
        role: String(formData.get("rol") ?? "agent"),
      }),
    });
    revalidatePath("/equipo");
    redirect(`/equipo?invitacion=${encodeURIComponent(res.token)}`);
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
            Manda el enlace a la persona: lo abre, entra con su cuenta y queda con este rol.
            Caduca en siete días y solo se puede usar una vez.
          </p>
          <form action={invitar} className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <Campo nombre="correo" etiqueta="Correo" tipo="email" requerido />
            <Campo
              nombre="rol" etiqueta="Rol" valor="agent"
              opciones={otorgables.map((r) => ({ valor: r, texto: r }))}
            />
            <div className="self-end"><Boton>Invitar</Boton></div>
          </form>
        </section>
        )}

        <section>
          <h2 className="mb-2 text-sm font-medium">Miembros</h2>
          <Tabla
            columnas={gestiona ? ["Nombre", "Correo", "Rol", ""] : ["Nombre", "Correo", "Rol"]}
            filas={miembros.map((m) => {
              const fila: React.ReactNode[] = [
                m.name + (m.userId === yo.id ? " (tú)" : ""),
                <span className="text-xs text-(--color-tenue)">{m.email}</span>,
              ];
              // Solo se gestiona a quien no está por encima de uno mismo.
              if (!gestiona || (RANGO[m.role] ?? 0) > rangoPropio) return [...fila, m.role, ...(gestiona ? [""] : [])];
              return [
                ...fila,
                <form action={cambiarRol} className="flex items-end gap-2">
                  <input type="hidden" name="usuario" value={m.userId} />
                  <select
                    name="rol" defaultValue={m.role} aria-label={`Rol de ${m.name}`}
                    className="rounded-lg border border-(--color-borde) bg-(--color-panel) px-2 py-1.5 text-sm"
                  >
                    {otorgables.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <Boton tipo="sobrio">Cambiar</Boton>
                </form>,
                <form action={quitar}>
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
