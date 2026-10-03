import { cookies } from "next/headers";
import { API_URL, SESSION_COOKIE } from "@/lib/config";

/**
 * Intermediario hacia la API.
 *
 * Existe para que el navegador hable siempre con el mismo origen: así la
 * cookie de sesión es de primera parte y no hace falta ni CORS ni cookies de
 * terceros, que los navegadores están retirando.
 *
 * Reenvía la cookie y NADA más: el navegador nunca ve una clave de API.
 */
async function reenviar(req: Request, ruta: string[]): Promise<Response> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const url = new URL(req.url);
  const destino = `${API_URL}/${ruta.map(encodeURIComponent).join("/")}${url.search}`;

  const res = await fetch(destino, {
    method: req.method,
    headers: {
      ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
      ...(req.headers.get("content-type") ? { "content-type": req.headers.get("content-type")! } : {}),
    },
    /*
     * El cuerpo se reenvía en BINARIO.
     *
     * Con `req.text()` cualquier subida de fichero se decodificaba como UTF-8
     * y llegaba corrompida al otro lado: una foto subida por el panel no era
     * la foto. `arrayBuffer` sirve igual para JSON y para multipart.
     */
    ...(req.method === "GET" || req.method === "HEAD"
      ? {}
      : { body: await req.arrayBuffer() }),
    redirect: "manual",
  });

  const cabeceras = new Headers();
  for (const [k, v] of res.headers) {
    // `set-cookie` sí pasa: es como se establece la sesión al entrar.
    if (["content-type", "set-cookie", "cache-control"].includes(k.toLowerCase())) {
      cabeceras.append(k, v);
    }
  }
  // La respuesta también en binario, por el mismo motivo: por aquí pasa JSON
  // hoy, y en cuanto pase un fichero el `text()` lo rompería sin avisar.
  return new Response(await res.arrayBuffer(), { status: res.status, headers: cabeceras });
}

const manejador = async (req: Request, ctx: { params: Promise<{ ruta: string[] }> }) =>
  reenviar(req, (await ctx.params).ruta);

export { manejador as GET, manejador as POST, manejador as PATCH, manejador as DELETE };
