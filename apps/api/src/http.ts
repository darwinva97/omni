import { OmniError } from "@omni/shared";
import type { Context } from "hono";

/**
 * Sobre uniforme de respuesta.
 *
 * A diferencia de las interfaces que se clonan en `/compat` —donde la
 * inconsistencia es parte del contrato ajeno— aquí la forma es SIEMPRE la
 * misma: `{data}` en el éxito, y un problema RFC 7807 en el fallo.
 */
export const ok = <T>(c: Context, data: T, status = 200) => c.json({ data }, status as 200);

const PROBLEM_CT = { "content-type": "application/problem+json" } as const;

/** Traduce cualquier error a `application/problem+json`. */
export function problem(c: Context, err: unknown) {
  if (err instanceof OmniError) {
    // El content-type va en la respuesta, no con `c.header()`: `c.json` lo pisa.
    return c.json(err.toProblem(c.req.path), err.status as 400, PROBLEM_CT);
  }
  const detail = err instanceof Error ? err.message : "error interno";
  // Un 500 es un fallo NUESTRO: la traza va al log del servidor siempre, para
  // que no haya que reproducirlo a ciegas. Al cliente nunca se le manda.
  if (err instanceof Error) console.error(`[500] ${c.req.method} ${c.req.path}\n${err.stack}`);
  return c.json(
    { type: "https://docs.omni.dev/errors/internal", title: "internal", status: 500, detail },
    500,
    PROBLEM_CT,
  );
}
