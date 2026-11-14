import { z } from "@hono/zod-openapi";
import { AddressError, OmniError, parseAddress } from "@omni/shared";
import {
  isChatScoped, isLineScoped, keyRoleHas, roleHas, type Principal, type Role,
} from "@omni/core";
import { lineTable, type Database } from "@omni/db";
import type { Bus } from "@omni/platform";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { temaDeAcceso, type CambioDeAcceso } from "./realtime/gateway.js";

/**
 * Alcance de una persona del equipo: a qué líneas y a qué chats llega.
 *
 * Significa lo mismo que en una clave de API —vacío es TODO— y lo aplica el
 * mismo guardián. Esto solo valida lo que se guarda.
 */

/** Los únicos roles que admiten alcance: gestionar algo exige verlo entero. */
export const ROLES_ACOTABLES: readonly Role[] = ["agent", "viewer"];

export const AlcanceSchema = z.object({
  allowedLines: z.array(z.string().min(1)).max(100).default([])
    .describe("Líneas a las que llega. Vacío = todas, también las que se creen después."),
  allowedChats: z.array(z.string().min(1)).max(1000).default([])
    .describe(
      "Chats a los que llega, dentro de esas líneas. Vacío = todos. Admite un teléfono suelto " +
      "(51999888777) o una dirección completa (…@s.whatsapp.net, …@g.us).",
    ),
});
export type Alcance = { allowedLines: string[]; allowedChats: string[] };

const acotado = (a: Alcance): boolean => a.allowedLines.length > 0 || a.allowedChats.length > 0;

/**
 * Valida y normaliza un alcance para guardarlo.
 *
 * - Solo con `agent` o `viewer`.
 * - Unos chats sin líneas no valen: los chats se nombran por su dirección, y
 *   sin líneas la persona vería la lista de TODAS las líneas de la
 *   organización aunque no pudiera abrir nada en ellas.
 * - Las líneas tienen que ser de la organización y estar vivas.
 * - Los chats se normalizan como en el resto de la API: un teléfono suelto
 *   pasa a ser `…@s.whatsapp.net`, que es lo que compara el guardián.
 */
export async function normalizarAlcance(
  db: Database, orgId: string, role: Role, entrada: Alcance,
): Promise<Alcance> {
  const allowedLines = [...new Set(entrada.allowedLines.map((l) => l.trim()).filter(Boolean))];
  const chats: string[] = [];
  const malas: string[] = [];
  for (const crudo of entrada.allowedChats) {
    try {
      chats.push(parseAddress(crudo).value);
    } catch (err) {
      if (!(err instanceof AddressError)) throw err;
      malas.push(crudo);
    }
  }
  if (malas.length > 0) {
    throw new OmniError("validation_failed", "hay chats que no son una dirección válida", { chats: malas });
  }
  const alcance: Alcance = { allowedLines, allowedChats: [...new Set(chats)] };
  if (!acotado(alcance)) return alcance;

  if (!ROLES_ACOTABLES.includes(role)) {
    throw new OmniError(
      "validation_failed",
      `solo se puede acotar a alguien con rol ${ROLES_ACOTABLES.join(" o ")}, no "${role}"`,
      { role },
    );
  }
  if (alcance.allowedChats.length > 0 && alcance.allowedLines.length === 0) {
    throw new OmniError("validation_failed", "indica también las líneas de esos chats");
  }

  const existentes = await db.select({ id: lineTable.id }).from(lineTable)
    .where(and(
      eq(lineTable.orgId, orgId),
      isNull(lineTable.deletedAt),
      inArray(lineTable.id, alcance.allowedLines),
    ));
  const validas = new Set(existentes.map((l) => l.id));
  const ajenas = alcance.allowedLines.filter((l) => !validas.has(l));
  if (ajenas.length > 0) {
    throw new OmniError("validation_failed", "hay líneas que no son de la organización", { lines: ajenas });
  }
  return alcance;
}

/** Un rol que no admite alcance no se puede dar a quien lo tiene. */
export function exigirRolCompatible(role: Role, actual: Alcance): void {
  if (acotado(actual) && !ROLES_ACOTABLES.includes(role)) {
    throw new OmniError(
      "conflict",
      `tiene el acceso limitado a unas líneas o chats; quítale el límite antes de darle el rol "${role}"`,
      { role },
    );
  }
}

/**
 * Avisa de que el acceso de alguien cambió, para que se cierren sus sockets
 * abiertos: llevan el alcance de cuando se abrieron.
 */
export async function avisarCambioDeAcceso(bus: Bus, orgId: string, userId: string): Promise<void> {
  const aviso: CambioDeAcceso = { userId };
  await bus.publish(temaDeAcceso(orgId), aviso);
}

/**
 * Si a esta credencial hay que ESCONDERLE el código de enlace de una línea (el
 * QR o el código de emparejamiento).
 *
 * Quien escanea ese QR con SU teléfono se queda con la línea: el número pasa
 * a ser el suyo. Así que una credencial acotada —a la que se le compartió una
 * conversación, no la cuenta— no lo ve a menos que pueda enlazar la línea, y
 * acotada a chats nunca puede. Sin acotar se deja como estaba: es del equipo.
 */
export function ocultaEnlace(p: Principal): boolean {
  if (!isChatScoped(p) && !isLineScoped(p)) return false;
  if (isChatScoped(p)) return true;
  return p.kind === "user" ? !roleHas(p.orgRole, "line.connect") : !keyRoleHas(p.keyRole, "line.connect");
}
