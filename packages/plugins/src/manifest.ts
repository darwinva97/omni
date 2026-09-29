import { z } from "zod";

/**
 * Manifiesto de un plugin.
 *
 * Sigue el modelo de OpenWA —un `manifest.json` y un fichero de entrada— porque
 * es un diseño probado, pero corrigiendo los tres huecos que su propia
 * documentación reconoce: el aislamiento era parcial, la versión del anfitrión
 * estaba declarada pero «sin gestionar», y la configuración se cacheaba al
 * habilitar en vez de releerse.
 */

/** Identificadores reservados: son piezas del núcleo, no extensiones. */
export const RESERVADOS = [
  "sandbox", "baileys", "whatsapp-web", "whatsapp-cloud",
  "core", "omni", "api", "engine", "worker",
] as const;

/**
 * Capacidades que un plugin puede pedir.
 *
 * Se declaran en el manifiesto y se comprueban EN CADA LLAMADA, no al
 * instalar: una capacidad no declarada falla en el momento de usarla, que es
 * cuando se nota.
 */
export const capacidades = [
  "messages:read",
  "messages:send",
  "chats:read",
  "labels:manage",
  "contacts:read",
  "lines:read",
  "net:fetch",
  "storage:use",
  "kv:use",
] as const;
export const Capacidad = z.enum(capacidades);
export type Capacidad = z.infer<typeof Capacidad>;

/** Eventos a los que un plugin puede engancharse. */
export const ganchos = [
  "message.received",
  "message.sent",
  "message.receipt",
  "session.connected",
  "session.disconnected",
  "chat.updated",
  "label.updated",
] as const;
export const Gancho = z.enum(ganchos);
export type Gancho = z.infer<typeof Gancho>;

export const Manifest = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, "minúsculas, dígitos, punto, guion y guion bajo"),
    name: z.string().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+/, "versión semántica"),
    description: z.string().max(500).optional(),
    /** Punto de entrada, relativo al directorio del plugin. */
    main: z.string().min(1).max(200),
    /**
     * Versión mínima del anfitrión. A diferencia de OpenWA, aquí SÍ se
     * comprueba: declararla y no mirarla deja que un plugin escrito para una
     * API que ya no existe falle en mitad de un mensaje en vez de al instalar.
     */
    minHostVersion: z.string().regex(/^\d+\.\d+\.\d+/).optional(),
    permissions: z.array(Capacidad).default([]),
    hooks: z.array(Gancho).default([]),
    /** Dominios a los que `net:fetch` puede llamar. Vacío = ninguno. */
    netAllow: z.array(z.string()).default([]),
    /** Esquema de la configuración, para que el panel pinte su formulario. */
    configSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type Manifest = z.infer<typeof Manifest>;

export class ManifestError extends Error {}

export function parseManifest(crudo: unknown, hostVersion: string): Manifest {
  const leido = Manifest.safeParse(crudo);
  if (!leido.success) {
    const problemas = leido.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ManifestError(`manifiesto inválido: ${problemas}`);
  }
  const m = leido.data;

  if ((RESERVADOS as readonly string[]).includes(m.id)) {
    throw new ManifestError(`"${m.id}" es un identificador reservado del núcleo`);
  }

  if (m.minHostVersion && compararVersiones(hostVersion, m.minHostVersion) < 0) {
    throw new ManifestError(
      `este plugin necesita el anfitrión ${m.minHostVersion} o superior; aquí corre ${hostVersion}`,
    );
  }

  // Pedir `net:fetch` sin decir a dónde es pedir permiso para nada, y casi
  // siempre significa que a alguien se le olvidó la lista.
  if (m.permissions.includes("net:fetch") && m.netAllow.length === 0) {
    throw new ManifestError("`net:fetch` requiere declarar `netAllow` con los dominios permitidos");
  }
  if (m.netAllow.length > 0 && !m.permissions.includes("net:fetch")) {
    throw new ManifestError("`netAllow` sin el permiso `net:fetch` no sirve de nada");
  }

  return m;
}

/** Compara dos versiones semánticas. Devuelve -1, 0 o 1. */
export function compararVersiones(a: string, b: string): number {
  const na = a.split(/[.-]/).slice(0, 3).map(Number);
  const nb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
