import { OmniError } from "@omni/shared";
import type { Capacidad, Manifest } from "../manifest.js";

/**
 * Comprobación de capacidades.
 *
 * Se aplica EN CADA LLAMADA y no al instalar. OpenWA documenta ese mismo
 * criterio y tiene razón: una capacidad no declarada tiene que fallar cuando se
 * usa, porque es el único momento en que alguien lo va a notar.
 */
export class CapabilityDenied extends OmniError {
  constructor(pluginId: string, capacidad: Capacidad) {
    super(
      "forbidden",
      `el plugin "${pluginId}" no declaró la capacidad "${capacidad}"`,
      { pluginId, capability: capacidad },
    );
    this.name = "CapabilityDenied";
  }
}

export function requireCapability(manifest: Manifest, capacidad: Capacidad): void {
  if (!manifest.permissions.includes(capacidad)) {
    throw new CapabilityDenied(manifest.id, capacidad);
  }
}

/**
 * Comprueba que una URL esté en la lista del manifiesto.
 *
 * Además de la lista, se bloquean las direcciones internas: sin eso, un plugin
 * declara `netAllow: ["*"]` y usa el servidor de puente hacia su propia red.
 */
export function checkUrl(manifest: Manifest, crudo: string): URL {
  let url: URL;
  try {
    url = new URL(crudo);
  } catch {
    throw new OmniError("validation_failed", `"${crudo}" no es una URL válida`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OmniError("forbidden", `esquema no permitido: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  const interno =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "0.0.0.0" || host === "::1" || host === "[::1]";
  if (interno) {
    throw new OmniError("forbidden", `un plugin no puede llamar a direcciones internas: ${host}`, { host });
  }

  const permitido = manifest.netAllow.some((patron) => {
    const p = patron.toLowerCase().trim();
    if (p === host) return true;
    // `*.ejemplo.com` cubre subdominios, pero NO el dominio desnudo: quien
    // quiera los dos, que los declare.
    if (p.startsWith("*.")) return host.endsWith(p.slice(1));
    return false;
  });
  if (!permitido) {
    throw new OmniError(
      "forbidden",
      `"${host}" no está en el netAllow del plugin "${manifest.id}"`,
      { host, netAllow: manifest.netAllow },
    );
  }
  return url;
}
