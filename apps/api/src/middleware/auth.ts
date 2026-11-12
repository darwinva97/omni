import { and, eq, isNull } from "drizzle-orm";
import { OmniError } from "@omni/shared";
import type { Principal } from "@omni/core";
import { apiKeyTable, lineTable, type Database } from "@omni/db";
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

/**
 * Autenticación por cookie de sesión.
 *
 * Devuelve el `Principal` de una persona, con su rol en la organización y sus
 * roles por línea ya cargados: el guardián los necesita y consultarlos en cada
 * ruta sería repetir el trabajo.
 */
export async function authenticateSession(
  db: Database,
  token: string | undefined,
): Promise<Principal | null> {
  if (!token) return null;

  const { hashToken } = await import("@omni/core");
  const { sessionTable, orgMemberTable, lineMemberTable, userTable } = await import("@omni/db");
  const hash = await hashToken(token);

  const filas = await db
    .select({
      userId: sessionTable.userId,
      activeOrgId: sessionTable.activeOrgId,
      expiresAt: sessionTable.expiresAt,
      disabledAt: userTable.disabledAt,
    })
    .from(sessionTable)
    .innerJoin(userTable, eq(userTable.id, sessionTable.userId))
    .where(eq(sessionTable.id, hash))
    .limit(1);

  const sesion = filas[0];
  if (!sesion) return null;
  if (sesion.expiresAt.getTime() <= Date.now()) {
    // Caducada: se borra al pasar, para que la tabla no acumule basura.
    await db.delete(sessionTable).where(eq(sessionTable.id, hash));
    return null;
  }
  // Una cuenta deshabilitada pierde el acceso AHORA, no cuando caduque su sesión.
  if (sesion.disabledAt) return null;

  const orgId = sesion.activeOrgId;
  if (!orgId) return null;

  const pertenencia = await db
    .select({ role: orgMemberTable.role })
    .from(orgMemberTable)
    .where(and(eq(orgMemberTable.orgId, orgId), eq(orgMemberTable.userId, sesion.userId)))
    .limit(1);
  if (!pertenencia[0]) return null;

  const porLinea = await db
    .select({ lineId: lineMemberTable.lineId, role: lineMemberTable.role })
    .from(lineMemberTable)
    .where(eq(lineMemberTable.userId, sesion.userId));

  return {
    kind: "user",
    userId: sesion.userId,
    orgId,
    orgRole: pertenencia[0].role,
    lineRoles: new Map(porLinea.map((l) => [l.lineId, l.role])),
  };
}

/**
 * Que la línea sea de la organización de quien pregunta.
 *
 * `authorize` es pura: no sabe de quién es cada línea, y las consultas filtran
 * por `lineId`. Con una sola organización por instalación daba igual; con
 * varias (`/platform`), sin esto una clave de una organización leía y enviaba
 * por las líneas de otra con solo conocer su id. 401 y no 403, como en
 * ADR-0003: un 403 confirmaría que esa línea existe.
 */
export async function exigirLineaDeLaOrganizacion(db: Database, orgId: string, lineId: string): Promise<void> {
  const rows = await db.select({ orgId: lineTable.orgId }).from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
  if (!rows[0] || rows[0].orgId !== orgId) {
    throw new OmniError("unauthenticated", "la clave no alcanza esa línea");
  }
}

/** El id de línea que nombra una ruta de `/v1`, si nombra alguna. */
export function lineaDeLaRuta(path: string): string | null {
  const m = /^\/v1\/(?:sandbox\/)?lines\/([^/]+)/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}
