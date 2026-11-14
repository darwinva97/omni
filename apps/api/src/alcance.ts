import { z } from "@hono/zod-openapi";
import { AddressError, OmniError, parseAddress } from "@omni/shared";
import {
  fullLinesOf, isChatScoped, isLineScoped, keyRoleHas, roleHas, type Principal, type Role,
} from "@omni/core";
import { lineTable, type Database } from "@omni/db";
import type { Bus } from "@omni/platform";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { temaDeAcceso, type CambioDeAcceso } from "./realtime/gateway.js";

/**
 * Alcance de una persona del equipo: a qué líneas y a qué chats llega, y si
 * puede dar de alta líneas suyas.
 *
 * Lo aplica el mismo guardián que a una clave de API. Esto solo valida lo que
 * se guarda.
 */

/** Los únicos roles que admiten límite: gestionar algo exige verlo entero. */
export const ROLES_ACOTABLES: readonly Role[] = ["agent", "viewer"];

export const AlcanceSchema = z.object({
  restricted: z.boolean().optional()
    .describe(
      "Limitada a las listas. Con las listas vacías no ve NINGUNA línea ajena —solo las que " +
      "dé de alta, si puede—. Si no se indica, es limitada cuando alguna lista trae algo.",
    ),
  allowedLines: z.array(z.string().min(1)).max(100).default([])
    .describe("Líneas ajenas a las que llega, limitada."),
  allowedChats: z.array(z.string().min(1)).max(1000).default([])
    .describe(
      "Chats a los que llega, dentro de esas líneas. Vacío = todos. Admite un teléfono suelto " +
      "(51999888777) o una dirección completa (…@s.whatsapp.net, …@g.us).",
    ),
  canCreateLines: z.boolean().default(false)
    .describe(
      "Puede dar de alta líneas aunque su rol no lo permita. Las que cree son suyas y enteras: " +
      "las ve, las enlaza, las configura y las borra, aunque esté limitada.",
    ),
});

export interface Alcance {
  restricted: boolean;
  allowedLines: string[];
  allowedChats: string[];
  canCreateLines: boolean;
}

/**
 * Valida y normaliza un alcance para guardarlo.
 *
 * - Limitar solo con `agent` o `viewer`.
 * - Unos chats sin sus líneas no valen: los chats se nombran por su dirección
 *   y sin la línea no hay dónde abrirlos.
 * - Las líneas tienen que ser de la organización y estar vivas.
 * - Los chats se normalizan como en el resto de la API: un teléfono suelto
 *   pasa a ser `…@s.whatsapp.net`, que es lo que compara el guardián.
 * - Sin limitar, las listas no significan nada y se guardan vacías.
 */
export async function normalizarAlcance(
  db: Database, orgId: string, role: Role, entrada: z.input<typeof AlcanceSchema>,
): Promise<Alcance> {
  const lineasPedidas = entrada.allowedLines ?? [];
  const chatsPedidos = entrada.allowedChats ?? [];
  const restricted = entrada.restricted ?? (lineasPedidas.length > 0 || chatsPedidos.length > 0);
  const canCreateLines = entrada.canCreateLines ?? false;
  if (!restricted) return { restricted, allowedLines: [], allowedChats: [], canCreateLines };

  if (!ROLES_ACOTABLES.includes(role)) {
    throw new OmniError(
      "validation_failed",
      `solo se puede limitar a alguien con rol ${ROLES_ACOTABLES.join(" o ")}, no "${role}"`,
      { role },
    );
  }

  const allowedLines = [...new Set(lineasPedidas.map((l) => l.trim()).filter(Boolean))];
  const chats: string[] = [];
  const malas: string[] = [];
  for (const crudo of chatsPedidos) {
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
  const allowedChats = [...new Set(chats)];
  if (allowedChats.length > 0 && allowedLines.length === 0) {
    throw new OmniError("validation_failed", "indica también las líneas de esos chats");
  }

  if (allowedLines.length > 0) {
    const existentes = await db.select({ id: lineTable.id }).from(lineTable)
      .where(and(eq(lineTable.orgId, orgId), isNull(lineTable.deletedAt), inArray(lineTable.id, allowedLines)));
    const validas = new Set(existentes.map((l) => l.id));
    const ajenas = allowedLines.filter((l) => !validas.has(l));
    if (ajenas.length > 0) {
      throw new OmniError("validation_failed", "hay líneas que no son de la organización", { lines: ajenas });
    }
  }
  return { restricted, allowedLines, allowedChats, canCreateLines };
}

/** Un rol que no admite límite no se puede dar a quien lo tiene. */
export function exigirRolCompatible(role: Role, actual: { restricted: boolean }): void {
  if (actual.restricted && !ROLES_ACOTABLES.includes(role)) {
    throw new OmniError(
      "conflict",
      `tiene el acceso limitado; quítale el límite antes de darle el rol "${role}"`,
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
 * acotada a chats nunca puede. En una línea que tiene entera —la dio de alta
 * ella— sí lo ve: enlazarla es justo lo que tiene que hacer. Sin acotar se deja
 * como estaba: es del equipo.
 */
export function ocultaEnlace(p: Principal, lineId?: string): boolean {
  if (!isChatScoped(p) && !isLineScoped(p)) return false;
  if (lineId && fullLinesOf(p).includes(lineId)) return false;
  if (isChatScoped(p)) return true;
  return p.kind === "user" ? !roleHas(p.orgRole, "line.connect") : !keyRoleHas(p.keyRole, "line.connect");
}
