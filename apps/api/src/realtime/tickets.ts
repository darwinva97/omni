import { OmniError } from "@omni/shared";
import type { Principal } from "@omni/core";
import type { Kv } from "@omni/platform";

/**
 * Billetes de conexión para el WebSocket.
 *
 * Un navegador no puede poner cabeceras en el apretón de manos de un
 * WebSocket, así que la credencial tendría que ir en la URL — y las URL acaban
 * en registros de acceso, en el historial y en cabeceras `Referer`. Poner ahí
 * una clave de API permanente es regalarla.
 *
 * En su lugar se pide un billete por una ruta normal y autenticada, y el
 * billete viaja en la URL: dura segundos y sirve UNA vez.
 */

const TTL_SEGUNDOS = 60;
const PREFIJO = "wsticket:";

export interface TicketPayload {
  readonly orgId: string;
  readonly kind: Principal["kind"];
  readonly userId?: string;
  readonly apiKeyId?: string;
  readonly allowedLines: readonly string[];
  readonly allowedChats: readonly string[];
}

export async function issueTicket(kv: Kv, principal: Principal): Promise<{ ticket: string; expiresIn: number }> {
  const ticket = crypto.randomUUID().replaceAll("-", "");
  const payload: TicketPayload = {
    orgId: principal.orgId,
    kind: principal.kind,
    ...(principal.kind === "user" ? { userId: principal.userId } : { apiKeyId: principal.apiKeyId }),
    allowedLines: principal.kind === "api-key" ? principal.allowedLines : [],
    allowedChats: principal.kind === "api-key" ? principal.allowedChats : [],
  };
  await kv.set(PREFIJO + ticket, JSON.stringify(payload), TTL_SEGUNDOS);
  return { ticket, expiresIn: TTL_SEGUNDOS };
}

/**
 * Canjea el billete. Es de un solo uso: se borra al leerlo, así que capturarlo
 * de un registro de acceso después ya no sirve de nada.
 */
export async function redeemTicket(kv: Kv, ticket: string): Promise<TicketPayload> {
  const crudo = await kv.get(PREFIJO + ticket);
  if (!crudo) throw new OmniError("unauthenticated", "billete inválido o caducado");
  await kv.delete(PREFIJO + ticket);
  return JSON.parse(crudo) as TicketPayload;
}
