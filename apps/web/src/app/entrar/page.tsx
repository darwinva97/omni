import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { API_URL, SESSION_COOKIE } from "@/lib/config";

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

export default async function Entrar({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold tracking-tight">omni</h1>
      <p className="mt-1 text-sm text-(--color-tenue)">Entra con tu cuenta.</p>

      <form action={entrar} className="mt-6 space-y-3">
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

        {error && (
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
    </main>
  );
}
