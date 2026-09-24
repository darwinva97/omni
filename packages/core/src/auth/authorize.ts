import { OmniError } from "@omni/shared";
import type { Address } from "@omni/shared";
import { isChatScoped, type Principal } from "./principal.js";
import { keyRoleHas, roleHas, type Role } from "./rbac.js";
import type { RouteDescriptor } from "./routes.js";

export interface AuthorizeTarget {
  readonly lineId?: string;
  readonly chat?: Address;
}

/**
 * Resuelve si dos direcciones son la misma persona consultando el mapeo LID.
 * Devuelve `null` cuando NO hay mapeo: el llamante debe rechazar, no suponer.
 */
export type IdentityResolver = (lineId: string, address: Address) => Promise<readonly string[] | null>;

export interface AuthorizeOptions {
  readonly resolveIdentity?: IdentityResolver;
}

const roleOf = (p: Principal, lineId?: string): Role | null => {
  if (p.kind !== "user") return null;
  if (lineId) {
    const perLine = p.lineRoles.get(lineId);
    // El rol de línea manda sobre el de organización: un supervisor entra como
    // `viewer` en una línea concreta y no puede escribir por error.
    if (perLine) return perLine;
  }
  return p.orgRole;
};

/**
 * Autorización. El orden de las comprobaciones importa y es deliberado:
 *
 *  1. Ámbito de LÍNEA primero → 401. Nombrar una línea fuera de alcance no debe
 *     revelar siquiera si esa línea existe.
 *  2. Permiso por rol → 403.
 *  3. Ámbito de CHAT al final → 403, con denegación por defecto.
 */
export async function authorize(
  principal: Principal,
  descriptor: RouteDescriptor,
  target: AuthorizeTarget = {},
  opts: AuthorizeOptions = {},
): Promise<void> {
  // 1 ── línea
  if (principal.kind === "api-key" && principal.allowedLines.length > 0) {
    if (target.lineId && !principal.allowedLines.includes(target.lineId)) {
      throw new OmniError("unauthenticated", "la clave no alcanza esa línea");
    }
    // Las rutas que no nombran línea alguna (gestión de claves, panel de colas)
    // quedan fuera del alcance de una clave limitada.
    if (!target.lineId && descriptor.scope === "org") {
      throw new OmniError("forbidden", "una clave limitada a líneas no puede operar sobre la organización");
    }
  }

  // 2 ── permiso
  const allowed =
    principal.kind === "api-key"
      ? keyRoleHas(principal.keyRole, descriptor.permission)
      : roleHas(roleOf(principal, target.lineId) ?? "viewer", descriptor.permission);
  if (!allowed) {
    throw new OmniError("forbidden", `falta el permiso "${descriptor.permission}"`, {
      permission: descriptor.permission,
    });
  }

  // 3 ── chat, con denegación por defecto
  if (!isChatScoped(principal)) return;
  if (principal.kind !== "api-key") return;

  if (descriptor.chatSafe !== true) {
    throw new OmniError(
      "forbidden",
      `la ruta "${descriptor.id}" no está permitida a una clave limitada a chats`,
      { route: descriptor.id },
    );
  }

  if (descriptor.scope !== "chat") return; // p. ej. listar chats: se filtra, no se rechaza
  if (!target.chat) {
    throw new OmniError("forbidden", "la ruta necesita un chat y no se indicó ninguno");
  }

  if (principal.allowedChats.includes(target.chat.value)) return;

  // Una persona en la lista por teléfono también vale por su LID, y al revés,
  // pero SOLO si el mapeo lo confirma. Un `@lid` desconocido se rechaza.
  const aliases = (await opts.resolveIdentity?.(target.lineId ?? "", target.chat)) ?? null;
  if (aliases && aliases.some((a) => principal.allowedChats.includes(a))) return;

  throw new OmniError("forbidden", "el chat está fuera del alcance de la clave", {
    chat: target.chat.value,
  });
}

/** Filtra una lista de chats a los que la clave alcanza. Para rutas de listado. */
export function filterChats<T>(
  principal: Principal,
  items: readonly T[],
  addressOf: (item: T) => string,
): readonly T[] {
  if (!isChatScoped(principal) || principal.kind !== "api-key") return items;
  const allowed = new Set(principal.allowedChats);
  return items.filter((i) => allowed.has(addressOf(i)));
}

/** Filtra líneas al alcance de la clave. Vacío significa todas. */
export function filterLines<T>(
  principal: Principal,
  items: readonly T[],
  idOf: (item: T) => string,
): readonly T[] {
  if (principal.kind !== "api-key" || principal.allowedLines.length === 0) return items;
  const allowed = new Set(principal.allowedLines);
  return items.filter((i) => allowed.has(idOf(i)));
}
