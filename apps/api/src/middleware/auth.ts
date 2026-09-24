import { and, eq, isNull, or } from "drizzle-orm";
import { OmniError } from "@omni/shared";
import type { Principal } from "@omni/core";
import { apiKeyTable, type Database } from "@omni/db";
import { parseApiKey, verifySecret } from "../keys.js";

/**
 * Autenticación por clave de API.
 *
 * Devuelve el `Principal` con sus dos ejes de alcance ya cargados, que es lo
 * que el guardián de autorización necesita. Toda superficie —REST, WebSocket,
 * MCP— pasa por aquí, para que ninguna se quede con reglas propias.
 */
export async function authenticateApiKey(db: Database, header: string | undefined): Promise<Principal> {
  if (!header) throw new OmniError("unauthenticated", "falta la cabecera Authorization");

  const parsed = parseApiKey(header);
  if (!parsed) {
    throw new OmniError("unauthenticated", "formato de clave inválido; se espera omni_<prefijo>_<secreto>");
  }

  const rows = await db
    .select()
    .from(apiKeyTable)
    .where(and(eq(apiKeyTable.prefix, parsed.prefix), isNull(apiKeyTable.revokedAt)))
    .limit(1);

  const row = rows[0];
  // Se verifica igualmente contra un hash falso cuando no hay fila, para que el
  // tiempo de respuesta no revele si el prefijo existe.
  const hash = row?.secretHash ?? "0".repeat(44);
  const ok = await verifySecret(parsed.secret, parsed.prefix, hash);
  if (!row || !ok) throw new OmniError("unauthenticated", "clave inválida o revocada");

  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw new OmniError("unauthenticated", "la clave ha caducado");
  }

  return {
    kind: "api-key",
    apiKeyId: row.id,
    orgId: row.orgId,
    keyRole: row.role,
    allowedLines: row.allowedLines,
    allowedChats: row.allowedChats,
  };
}

/** Comprueba la lista CIDR de la clave, cuando la tiene. */
export function checkCidr(allowed: readonly string[], ip: string | undefined): void {
  if (allowed.length === 0) return;
  if (!ip) throw new OmniError("forbidden", "no se pudo determinar la IP de origen");
  if (!allowed.some((cidr) => ipInCidr(ip, cidr))) {
    throw new OmniError("forbidden", "IP de origen fuera de la lista permitida");
  }
}

/** Sólo IPv4. Una notación que no se entienda NO concede acceso. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  if (!range) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const toInt = (v: string): number | null => {
    const parts = v.split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const b = Number(p);
      if (!Number.isInteger(b) || b < 0 || b > 255) return null;
      n = (n << 8) | b;
    }
    return n >>> 0;
  };

  const a = toInt(ip);
  const b = toInt(range);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
