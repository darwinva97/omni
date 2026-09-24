import type { EventEnvelope } from "@omni/shared";

/**
 * Filtro declarativo, evaluado ANTES de encolar la entrega.
 *
 * Se escribe con cuidado porque en el gateway anterior este campo se guardaba,
 * se pintaba en el panel y NO se leía nunca: el usuario configuraba un filtro,
 * lo veía reflejado en pantalla y seguía recibiéndolo todo. Un filtro que
 * miente es peor que no tener filtro.
 */
export interface WebhookFilter {
  readonly fromMe?: boolean;
  readonly isGroup?: boolean;
  readonly hasMedia?: boolean;
  readonly kinds?: readonly string[];
  readonly chatIn?: readonly string[];
  readonly chatNotIn?: readonly string[];
  readonly senderIn?: readonly string[];
  readonly bodyContains?: string;
  readonly bodyMatches?: string;
  readonly mentionsMe?: boolean;
}

interface Facts {
  readonly fromMe: boolean;
  readonly isGroup: boolean;
  readonly hasMedia: boolean;
  readonly kind: string;
  readonly chat: string;
  readonly sender: string;
  readonly body: string;
  readonly mentionsMe: boolean;
}

/** Extrae del sobre solo lo que el filtro puede mirar. */
export function factsOf(envelope: EventEnvelope, selfAddress?: string): Facts {
  const d = (envelope.data ?? {}) as Record<string, unknown>;
  const key = (d["key"] ?? {}) as Record<string, unknown>;
  const chat = String(key["remoteJid"] ?? d["chat"] ?? "");
  const mentions = Array.isArray(d["mentions"]) ? (d["mentions"] as string[]) : [];
  return {
    fromMe: key["fromMe"] === true,
    isGroup: chat.endsWith("@g.us"),
    hasMedia: d["mediaKey"] !== undefined || d["media"] !== undefined,
    kind: String(d["kind"] ?? "unknown"),
    chat,
    sender: String(key["participant"] ?? chat),
    body: String(d["text"] ?? d["body"] ?? ""),
    mentionsMe: selfAddress !== undefined && mentions.includes(selfAddress),
  };
}

/** Todas las condiciones presentes deben cumplirse (Y lógico). */
export function passesFilter(
  filter: WebhookFilter | null | undefined,
  envelope: EventEnvelope,
  selfAddress?: string,
): boolean {
  if (!filter) return true;
  const f = factsOf(envelope, selfAddress);

  if (filter.fromMe !== undefined && f.fromMe !== filter.fromMe) return false;
  if (filter.isGroup !== undefined && f.isGroup !== filter.isGroup) return false;
  if (filter.hasMedia !== undefined && f.hasMedia !== filter.hasMedia) return false;
  if (filter.mentionsMe !== undefined && f.mentionsMe !== filter.mentionsMe) return false;
  if (filter.kinds && !filter.kinds.includes(f.kind)) return false;
  if (filter.chatIn && !filter.chatIn.includes(f.chat)) return false;
  if (filter.chatNotIn?.includes(f.chat)) return false;
  if (filter.senderIn && !filter.senderIn.includes(f.sender)) return false;
  if (filter.bodyContains && !f.body.toLowerCase().includes(filter.bodyContains.toLowerCase())) return false;
  if (filter.bodyMatches) {
    let re: RegExp;
    try {
      re = new RegExp(filter.bodyMatches, "i");
    } catch {
      // Una expresión inválida NO debe dejar pasar todo en silencio.
      return false;
    }
    if (!re.test(f.body)) return false;
  }
  return true;
}
