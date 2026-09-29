import type { ImapClient, ImapMessage, SmtpTransport } from "./driver.js";

/**
 * Un servidor de correo falso: SMTP que acepta y buzón IMAP que se va
 * llenando. Permite probar el canal entero —envío, ingesta y el corte por UID—
 * sin una cuenta real ni una conexión.
 */

export interface FakeMail {
  readonly enviados: Record<string, unknown>[];
  readonly buzon: ImapMessage[];
  /** Si se define, el siguiente envío falla con este error. */
  fallarAlEnviar: Error | null;
  /** Si se define, `verify` falla: credenciales malas. */
  fallarAlVerificar: Error | null;
  readonly smtp: SmtpTransport;
  readonly imap: ImapClient;
  /** Deja un correo nuevo en el buzón, como si acabara de llegar. */
  recibir(de: string, asunto: string, opts?: { nombre?: string; inReplyTo?: string }): ImapMessage;
  cerrado: boolean;
}

export function createFakeMail(): FakeMail {
  let uid = 0;

  const control: FakeMail = {
    enviados: [],
    buzon: [],
    fallarAlEnviar: null,
    fallarAlVerificar: null,
    cerrado: false,
    smtp: null as unknown as SmtpTransport,
    imap: null as unknown as ImapClient,
    recibir: (de, asunto, opts = {}) => {
      const m: ImapMessage = {
        uid: ++uid,
        envelope: {
          messageId: `<${uid}@remoto.test>`,
          date: new Date(1_800_000_000_000),
          subject: asunto,
          from: [{ address: de, ...(opts.nombre ? { name: opts.nombre } : {}) }],
          ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
        },
      };
      control.buzon.push(m);
      return m;
    },
  };

  const smtp: SmtpTransport = {
    sendMail: async (mensaje) => {
      if (control.fallarAlEnviar) throw control.fallarAlEnviar;
      control.enviados.push(mensaje);
      return { messageId: String(mensaje["messageId"] ?? ""), accepted: [mensaje["to"]] };
    },
    verify: async () => {
      if (control.fallarAlVerificar) throw control.fallarAlVerificar;
      return true;
    },
    close: () => { control.cerrado = true; },
  };

  const imap: ImapClient = {
    connect: async () => {},
    logout: async () => {},
    on: () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    mailboxOpen: async () => ({ exists: control.buzon.length }),
    fetch: (rango) => {
      // `desde:*`, como pide el driver. Se respeta de verdad para que la
      // prueba del corte por UID signifique algo.
      const desde = Number(rango.split(":")[0] ?? "1");
      const lote = control.buzon.filter((m) => m.uid >= desde);
      return (async function* () {
        for (const m of lote) yield m;
      })();
    },
  };

  (control as { smtp: SmtpTransport }).smtp = smtp;
  (control as { imap: ImapClient }).imap = imap;
  return control;
}
