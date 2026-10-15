import { revalidatePath } from "next/cache";
import { apiFetch, apiFetchAuth, type Yo } from "@/lib/api";
import { Boton, Campo, SecretoUnaVez, Tabla } from "@/lib/ui-nav";
import { Pagina } from "@/componentes/armazon";

interface Miembro { userId: string; email: string; name: string; role: string }

const ROLES = ["viewer", "agent", "manager", "owner"] as const;
const RANGO: Record<string, number> = { viewer: 0, agent: 1, manager: 2, owner: 3 };

export default async function Equipo({
  searchParams,
}: {
  searchParams: Promise<{ invitacion?: string }>;
}) {
  const [{ invitacion }, yo, miembros] = await Promise.all([
    searchParams,
    apiFetchAuth<Yo>("/v1/auth/me"),
    apiFetchAuth<Miembro[]>("/v1/members"),
  ]);

  // Nadie otorga un rol por encima del suyo: la API lo impone, y el panel no
  // ofrece lo que va a ser rechazado.
  const otorgables = ROLES.filter((r) => RANGO[r]! <= (RANGO[yo.role ?? "viewer"] ?? 0));

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
    const { redirect } = await import("next/navigation");
    redirect(`/equipo?invitacion=${encodeURIComponent(res.token)}`);
  }

  return (
    <Pagina actual="/equipo" titulo="Equipo" descripcion="Quién entra al panel y con qué papel. Las invitaciones caducan.">
      <div className="space-y-5">
        {invitacion && <SecretoUnaVez etiqueta="Enlace de invitación" valor={invitacion} />}

        {/* Ver el equipo es de todos; invitar, solo de quien lo administra. Un
            formulario que siempre contesta «no puedes» no se enseña. */}
        {yo.role === "owner" && (
        <section className="rounded-xl border border-(--color-borde) bg-(--color-panel) p-5">
          <h2 className="text-sm font-semibold">Invitar</h2>
          <p className="mt-1 text-sm text-(--color-tenue)">
            La invitación caduca en siete días y solo se puede usar una vez.
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
            columnas={["Nombre", "Correo", "Rol"]}
            filas={miembros.map((m) => [
              m.name + (m.userId === yo.id ? " (tú)" : ""),
              <span className="text-xs text-(--color-tenue)">{m.email}</span>,
              m.role,
            ])}
          />
        </section>
      </div>
    </Pagina>
  );
}
