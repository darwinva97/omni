import type { Role } from "./rbac.js";

/** Quién actúa. Una sesión de persona o una clave de API; nunca ambas. */
export type Principal =
  | {
      readonly kind: "user";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: Role;
      /** Rol por línea cuando se comparte una línea suelta con alguien. */
      readonly lineRoles: ReadonlyMap<string, Role>;
    }
  | {
      readonly kind: "api-key";
      readonly apiKeyId: string;
      readonly orgId: string;
      readonly keyRole: "admin" | "operator" | "viewer";
      /** Vacío = TODAS las líneas, incluidas las que se creen después. */
      readonly allowedLines: readonly string[];
      /** Vacío = todos los chats de sus líneas. No vacío = solo esos. */
      readonly allowedChats: readonly string[];
    };

export const isChatScoped = (p: Principal): boolean =>
  p.kind === "api-key" && p.allowedChats.length > 0;

export const isLineScoped = (p: Principal): boolean =>
  p.kind === "api-key" && p.allowedLines.length > 0;
