import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { API_URL, SESSION_COOKIE } from "@/lib/config";
import { SinSesionEmbebido } from "@/componentes/sin-sesion-embebido";

/**
 * Entrada.
 *
 * La contraseña se manda desde una *server function*, así que nunca pasa por
 * JavaScript del navegador ni queda en el historial de red del cliente.
 */
async function entrar(formData: FormData): Promise<void> {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const res = await fetch(`${API_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    // El mismo mensaje para correo inexistente y contraseña incorrecta: la API
    // no los distingue a propósito, y el panel tampoco debe hacerlo.
    redirect("/entrar?error=1");
  }

  const cookieCruda = res.headers.get("set-cookie") ?? "";
  const valor = cookieCruda.split(";")[0]?.split("=")[1];
  if (valor) {
    (await cookies()).set(SESSION_COOKIE, valor, {
      httpOnly: true, sameSite: "lax", path: "/",
      maxAge: 30 * 24 * 3600,
    });
  }
  redirect("/");
}

/** Qué formas de entrar ofrece la API. Si no responde, queda la de siempre. */
async function proveedores(): Promise<{ password: boolean; oidc: { name: string; startUrl: string } | null }> {
  try {
    const res = await fetch(`${API_URL}/v1/auth/providers`, { cache: "no-store" });
    if (!res.ok) return { password: true, oidc: null };
    return ((await res.json()) as { data: { password: boolean; oidc: { name: string; startUrl: string } | null } }).data;
  } catch {
    return { password: true, oidc: null };
  }
}

/** Los motivos son de la API (`OidcRechazo`); el detalle se queda en su registro. */
const MENSAJES_SSO: Record<string, string> = {
  sso: "No se pudo completar la entrada con el proveedor. Inténtalo de nuevo.",
  "sso-correo": "Tu correo no está verificado en el proveedor de identidad.",
  "sso-grupo": "Tu cuenta del proveedor no pertenece a un grupo con acceso a Omni.",
  "sso-sin-cuenta": "No hay una cuenta de Omni con ese correo. Pide una invitación.",
  "sso-invitacion": "La invitación no existe, ya se usó o caducó. Pide una nueva.",
  "sso-invitacion-correo": "Esa invitación es para otro correo. Entra con la cuenta a la que se envió.",
};

export default async function Entrar({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { password, oidc } = await proveedores();
  const errorSso = error ? MENSAJES_SSO[error] : undefined;

  return (
    <SinSesionEmbebido>
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold tracking-tight">omni</h1>
      <p className="mt-1 text-sm text-(--color-tenue)">Entra con tu cuenta.</p>

      {oidc && (
        <>
          {/* Un enlace y no un botón con JavaScript: la entrada es una redirección del navegador. */}
          <a
            href={oidc.startUrl}
            className="mt-6 block w-full rounded-lg bg-(--color-acento) px-3 py-2 text-center text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Entrar con {oidc.name}
          </a>
          {errorSso && (
            <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{errorSso}</p>
          )}
          {password && <p className="mt-6 text-center text-xs text-(--color-tenue)">o con correo y contraseña</p>}
        </>
      )}

      {/* La instalación decide qué puertas abre (PASSWORD_LOGIN_ENABLED en la API). */}
      {password && (
      <form action={entrar} className={oidc ? "mt-3 space-y-3" : "mt-6 space-y-3"}>
        <label className="block">
          <span className="text-xs text-(--color-tenue)">Correo</span>
          <input
            name="email" type="email" required autoComplete="email" autoFocus
            className="mt-1 w-full rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-acento)"
          />
        </label>
        <label className="block">
          <span className="text-xs text-(--color-tenue)">Contraseña</span>
          <input
            name="password" type="password" required autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-acento)"
          />
        </label>

        {error && !errorSso && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            Correo o contraseña incorrectos.
          </p>
        )}

        <button
          type="submit"
          className="w-full rounded-lg bg-(--color-acento) px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Entrar
        </button>
      </form>
      )}

      {!password && !oidc && (
        <p role="alert" className="mt-6 text-sm text-red-700 dark:text-red-300">
          No se pudo consultar cómo entrar. Recarga la página en unos segundos.
        </p>
      )}
    </main>
    </SinSesionEmbebido>
  );
}
