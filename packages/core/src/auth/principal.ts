import type { Role } from "./rbac.js";

/**
 * Los dos ejes de alcance. Los tienen IGUAL una persona y una clave de API: así
 * el guardián aplica una sola regla y ninguna superficie puede olvidarse de
 * una de las dos.
 */
interface Alcance {
  /**
   * Las líneas a las que llega. Para una clave, vacío = TODAS. Para una
   * persona lo decide `restricted`: limitada, vacío es NINGUNA —salvo las
   * suyas, que ya vienen sumadas aquí—.
   */
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
      /**
       * Rol por línea. Una línea con rol propio es una línea ENTERA para esa
       * persona —típicamente, una que dio de alta ella—: la ve aunque esté
       * limitada, y el límite por chats no se le aplica.
       */
      readonly lineRoles: ReadonlyMap<string, Role>;
      /**
       * Limitada a `allowedLines`/`allowedChats`. Hace falta explícito porque,
       * a diferencia de una clave, una persona puede estar limitada a NINGUNA
       * línea ajena —solo a las que ella dé de alta—, y una lista vacía no
       * distingue eso de «todas».
       */
      readonly restricted: boolean;
      /** Puede dar de alta líneas, que serán suyas, aunque su rol no lo permita. */
      readonly canCreateLines: boolean;
    })
  | (Alcance & {
      readonly kind: "api-key";
      readonly apiKeyId: string;
      readonly orgId: string;
      readonly keyRole: "admin" | "operator" | "viewer";
    });

export const isChatScoped = (p: Principal): boolean => p.allowedChats.length > 0;

export const isLineScoped = (p: Principal): boolean =>
  p.kind === "user" ? p.restricted : p.allowedLines.length > 0;

/** Las líneas que esta credencial tiene ENTERAS aunque esté acotada a chats. */
export const fullLinesOf = (p: Principal): readonly string[] =>
  p.kind === "user" ? [...p.lineRoles.keys()] : [];

/**
 * Los chats a los que se limita EN ESA LÍNEA, o `null` si alcanza todos los de
 * la línea. Sin línea —un listado de toda la organización— devuelve el límite
 * sin más: quien lo use tiene que eximir él las líneas enteras.
 */
export const chatScopeOf = (p: Principal, lineId?: string): readonly string[] | null => {
  if (!isChatScoped(p)) return null;
  if (lineId && fullLinesOf(p).includes(lineId)) return null;
  return p.allowedChats;
};

/** Las líneas a las que se limita, o `null` si alcanza todas. */
export const lineScopeOf = (p: Principal): readonly string[] | null =>
  isLineScoped(p) ? p.allowedLines : null;
