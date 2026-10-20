import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { API_URL, SESSION_COOKIE } from "@/lib/config";

/**
 * Aceptar una invitación. Es lo que abre quien recibe el enlace de «Equipo».
 *
 * Con proveedor OIDC, se acepta entrando con él: la cuenta de Omni queda sin
 * contraseña y el rol es el de la invitación. Solo si la instalación admite
 * contraseña se ofrece además crearla aquí.
 */

interface Proveedores { password: boolean; oidc: { name: string; startUrl: string } | null }

async function proveedores(): Promise<Proveedores> {
  try {
    const res = await fetch(`${API_URL}/v1/auth/providers`, { cache: "no-store" });
    if (res.ok) return ((await res.json()) as { data: Proveedores }).data;
  } catch { /* sin API, la opción que queda es la de siempre */ }
  return { password: true, oidc: null };
}

async function aceptarConContrasena(formData: FormData): Promise<void> {
  "use server";
  const codigo = String(formData.get("codigo") ?? "");
  const res = await fetch(`${API_URL}/v1/invitations/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: codigo,
      name: String(formData.get("nombre") ?? ""),
      password: String(formData.get("password") ?? ""),
    }),
  });
  if (!res.ok) redirect(`/unirse?codigo=${encodeURIComponent(codigo)}&error=1`);
  const valor = (res.headers.get("set-cookie") ?? "").split(";")[0]?.split("=")[1];
  if (valor) {
    (await cookies()).set(SESSION_COOKIE, valor, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
  }
  redirect("/");
}

export default async function Unirse({
  searchParams,
}: {
  searchParams: Promise<{ codigo?: string; error?: string }>;
}) {
  const { codigo, error } = await searchParams;
  const { password, oidc } = await proveedores();

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold tracking-tight">omni</h1>

      {!codigo ? (
        <p className="mt-2 text-sm text-(--color-tenue)">
          Falta el código de la invitación. Abre el enlace completo que te enviaron.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-(--color-tenue)">
            Te invitaron a unirte. Entra con la cuenta del correo al que llegó la invitación.
          </p>

          {oidc && (
            <a
              href={`${oidc.startUrl}?invitacion=${encodeURIComponent(codigo)}`}
              className="mt-6 block w-full rounded-lg bg-(--color-acento) px-3 py-2 text-center text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Aceptar con {oidc.name}
            </a>
          )}

          {password && (
            <form action={aceptarConContrasena} className="mt-6 space-y-3">
              <input type="hidden" name="codigo" value={codigo} />
              <label className="block">
                <span className="text-xs text-(--color-tenue)">Tu nombre</span>
                <input name="nombre" required autoComplete="name"
                  className="mt-1 w-full rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-acento)" />
              </label>
              <label className="block">
                <span className="text-xs text-(--color-tenue)">Contraseña (12 caracteres o más)</span>
                <input name="password" type="password" required minLength={12} autoComplete="new-password"
                  className="mt-1 w-full rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-acento)" />
              </label>
              {error && (
                <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                  La invitación no existe, ya se usó o caducó.
                </p>
              )}
              <button type="submit"
                className="w-full rounded-lg border border-(--color-borde) px-3 py-2 text-sm font-medium transition-colors hover:bg-(--color-hundido)">
                Aceptar con contraseña
              </button>
            </form>
          )}
        </>
      )}
    </main>
  );
}
