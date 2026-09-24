import type { AnyMessageContent } from "baileys";
import { OmniError, resolveContent, type SendMessageInput } from "@omni/shared";
import type { OutboundCommand } from "../port.js";

/**
 * Traduce nuestra orden de envío al contenido que entiende Baileys.
 *
 * Es el único sitio del sistema que conoce la forma de los mensajes de
 * WhatsApp. Todo lo demás habla en términos de `SendMessageInput`.
 */
export function toBaileysContent(cmd: OutboundCommand): AnyMessageContent {
  const input: SendMessageInput = cmd.input;
  const resolved = resolveContent(input);
  if (!resolved.ok) throw new OmniError("validation_failed", resolved.reason);

  const mentions = input.mentions?.length
    ? { mentions: input.mentions.map((m) => (m.includes("@") ? m : `${m}@s.whatsapp.net`)) }
    : {};
  const caption = input.caption ? { caption: input.caption } : {};

  const media = (): Buffer => {
    if (!cmd.media) {
      throw new OmniError("validation_failed", `falta el contenido del medio para "${resolved.field}"`);
    }
    return Buffer.from(cmd.media.bytes);
  };

  switch (resolved.field) {
    case "text":
      return { text: input.text!, ...mentions };

    case "image":
      return { image: media(), ...caption, ...mentions, ...(input.viewOnce ? { viewOnce: true } : {}) };

    case "video":
      return { video: media(), ...caption, ...mentions, ...(input.viewOnce ? { viewOnce: true } : {}) };

    case "audio":
      return {
        audio: media(),
        mimetype: cmd.media?.mimeType ?? "audio/ogg; codecs=opus",
        // `ptt` es lo que distingue una nota de voz de un fichero de audio.
        ptt: input.ptt ?? false,
      };

    case "document":
      return {
        document: media(),
        mimetype: cmd.media?.mimeType ?? "application/octet-stream",
        fileName: input.fileName ?? cmd.media?.fileName ?? "documento",
        ...caption,
      };

    case "sticker":
      return { sticker: media() };

    case "location":
      return {
        location: {
          degreesLatitude: input.location!.latitude,
          degreesLongitude: input.location!.longitude,
          ...(input.location!.name ? { name: input.location!.name } : {}),
          ...(input.location!.address ? { address: input.location!.address } : {}),
        },
      };

    case "contact": {
      const c = input.contact!;
      // vCard 3.0 es el formato que WhatsApp espera; un vCard mal formado se
      // entrega pero el destinatario no puede guardarlo.
      const vcard = [
        "BEGIN:VCARD", "VERSION:3.0",
        `FN:${c.fullName}`,
        ...(c.organization ? [`ORG:${c.organization}`] : []),
        `TEL;type=CELL;type=VOICE;waid=${c.phone.replace(/\D/g, "")}:${c.phone}`,
        ...(c.email ? [`EMAIL:${c.email}`] : []),
        "END:VCARD",
      ].join("\n");
      return { contacts: { contacts: [{ displayName: c.fullName, vcard }] } };
    }

    case "poll":
      return {
        poll: {
          name: input.poll!.question,
          values: [...input.poll!.options],
          selectableCount: input.poll!.allowMultipleAnswers ? input.poll!.options.length : 1,
        },
      };

    case "buttons":
    case "list":
      // El núcleo oficial de Baileys ya no las envía de forma fiable; sólo
      // funcionan con forks. Decirlo es mejor que mandar algo que no llega.
      throw new OmniError(
        "capability_unsupported",
        `"${resolved.field}" requiere un fork de Baileys; el núcleo oficial no lo soporta de forma fiable`,
        { capability: `send.${resolved.field}` },
      );

    default:
      throw new OmniError("validation_failed", `tipo de contenido no soportado: ${resolved.field}`);
  }
}
