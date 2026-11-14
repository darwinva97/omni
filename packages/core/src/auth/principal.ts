import type { Role } from "./rbac.js";

/**
 * Los dos ejes de alcance. Los tienen IGUAL una persona y una clave de API: así
 * el guardián aplica una sola regla y ninguna superficie puede olvidarse de
 * una de las dos.
 */
interface Alcance {
  /** Vacío = TODAS las líneas, incluidas las que se creen después. */
  readonly allowedLines: readonly string[];
  /** Vacío = todos los chats de sus líneas. No vacío = solo esos. */
  readonly allowedChats: readonly string[];
}

/** Quién actúa. Una sesión de persona o una clave de API; nunca ambas. */
export type Principal =
  | (Alcance & {
      readonly kind: "user";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: Role;
      /** Rol por línea cuando se comparte una línea suelta con alguien. */
      readonly lineRoles: ReadonlyMap<string, Role>;
    })
  | (Alcance & {
      readonly kind: "api-key";
      readonly apiKeyId: string;
      readonly orgId: string;
      readonly keyRole: "admin" | "operator" | "viewer";
    });

export const isChatScoped = (p: Principal): boolean => p.allowedChats.length > 0;

export const isLineScoped = (p: Principal): boolean => p.allowedLines.length > 0;

/** Los chats a los que se limita, o `null` si alcanza todos los de sus líneas. */
export const chatScopeOf = (p: Principal): readonly string[] | null =>
  isChatScoped(p) ? p.allowedChats : null;

/** Las líneas a las que se limita, o `null` si alcanza todas. */
export const lineScopeOf = (p: Principal): readonly string[] | null =>
  isLineScoped(p) ? p.allowedLines : null;
