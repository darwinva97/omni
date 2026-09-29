import { createTransport } from "nodemailer";
import { ImapFlow } from "imapflow";
import { OmniError } from "@omni/shared";
import type { ImapClient, SmtpTransport } from "@omni/channels";

/**
 * Fabrica el SMTP y el IMAP de una línea de correo desde su `driverConfig`.
 *
 * Vive aquí y no en el driver a propósito: el driver no debe saber de qué
 * bibliotecas concretas se trata, que es lo que permite probarlo entero con un
 * servidor falso y sin red.
 */

const exigir = (cfg: Readonly<Record<string, unknown>>, clave: string): string => {
  const v = cfg[clave];
  if (typeof v !== "string" || v.length === 0) {
    throw new OmniError(
      "validation_failed",
      `la configuración de esta línea de correo necesita "${clave}"`,
    );
  }
  return v;
};

export function makeSmtp(cfg: Readonly<Record<string, unknown>>): SmtpTransport {
  const puerto = Number(cfg["smtpPort"] ?? 587);
  return createTransport({
    host: exigir(cfg, "smtpHost"),
    port: puerto,
    // 465 es TLS implícito; 587 y 25 empiezan en claro y suben con STARTTLS.
    secure: cfg["smtpSecure"] !== undefined ? Boolean(cfg["smtpSecure"]) : puerto === 465,
    auth: { user: exigir(cfg, "smtpUser"), pass: exigir(cfg, "smtpPassword") },
  }) as unknown as SmtpTransport;
}

export function makeImap(cfg: Readonly<Record<string, unknown>>): ImapClient | null {
  // Sin IMAP la línea sigue sirviendo para enviar; simplemente no recibe.
  if (!cfg["imapHost"]) return null;
  const puerto = Number(cfg["imapPort"] ?? 993);
  return new ImapFlow({
    host: String(cfg["imapHost"]),
    port: puerto,
    secure: cfg["imapSecure"] !== undefined ? Boolean(cfg["imapSecure"]) : puerto === 993,
    auth: {
      user: String(cfg["imapUser"] ?? exigir(cfg, "smtpUser")),
      pass: String(cfg["imapPassword"] ?? exigir(cfg, "smtpPassword")),
    },
    logger: false,
  }) as unknown as ImapClient;
}
