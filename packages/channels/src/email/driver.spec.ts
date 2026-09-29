import { describe, it, expect, beforeEach } from "vitest";
import { asLineId, parseAddress, type EventEnvelope } from "@omni/shared";
import { EmailDriver, asuntoDe, deterministicMessageId } from "./driver.js";
import { createFakeMail, type FakeMail } from "./fake-mail.js";

const LINE = asLineId("l-mail");
const YO = "soporte@ejemplo.test";

async function conectado(): Promise<{ d: EmailDriver; mail: FakeMail; eventos: EventEnvelope[] }> {
  const mail = createFakeMail();
  const d = new EmailDriver({
    makeSmtp: () => mail.smtp, makeImap: () => mail.imap, autoPoll: false,
  });
  const eventos: EventEnvelope[] = [];
  d.subscribe((e) => { eventos.push(e); });
  await d.connect({
    lineId: LINE, credentials: null, saveCredentials: async () => {},
    config: { orgId: "org1", address: YO },
  });
  return { d, mail, eventos };
}

describe("driver de correo", () => {
  let d: EmailDriver;
  let mail: FakeMail;
  let eventos: EventEnvelope[];
  beforeEach(async () => { ({ d, mail, eventos } = await conectado()); });

  it("comprueba las credenciales al conectar, no al primer envío", async () => {
    // Una contraseña mal puesta que no se nota hasta el primer envío se
    // descubre horas después y en manos de otra persona.
    const otro = createFakeMail();
    otro.fallarAlVerificar = new Error("535 authentication failed");
    const driver = new EmailDriver({ makeSmtp: () => otro.smtp, autoPoll: false });
    const err = await driver.connect({
      lineId: asLineId("l2"), credentials: null, saveCredentials: async () => {},
      config: { address: YO },
    }).then(() => null).catch((e: { status: number }) => e);
    expect(err?.status).toBe(422);
  });

  it("no deja escribir a algo que no es una dirección de correo", async () => {
    const err = await d.send({
      lineId: LINE, to: parseAddress("51999888777"), clientMessageId: "m1",
      kind: "text", input: { to: "51999888777", text: "hola" },
    }).then(() => null).catch((e: { status: number }) => e);
    expect(err?.status).toBe(422);
  });

  it("el identificador se deriva del cliente, así que el reintento no duplica", () => {
    // En el correo el Message-ID lo pone quien envía. Derivarlo da idempotencia
    // aunque el proceso se caiga entre enviar y registrar.
    const a = deterministicMessageId("pedido-42", YO);
    const b = deterministicMessageId("pedido-42", YO);
    expect(a).toBe(b);
    expect(a).toContain("@ejemplo.test");
    expect(deterministicMessageId("pedido-43", YO)).not.toBe(a);
  });

  it("envía con asunto propio o con la primera línea del texto", async () => {
    await d.send({
      lineId: LINE, to: parseAddress("ada@remoto.test"), clientMessageId: "s1",
      kind: "text", input: { to: "ada@remoto.test", text: "Hola Ada\nte escribo por..." },
    });
    expect(mail.enviados.at(-1)!["subject"]).toBe("Hola Ada");

    await d.send({
      lineId: LINE, to: parseAddress("ada@remoto.test"), clientMessageId: "s2",
      kind: "text",
      input: { to: "ada@remoto.test", text: "cuerpo", bodyText: "Factura de marzo" },
    });
    expect(mail.enviados.at(-1)!["subject"]).toBe("Factura de marzo");
  });

  it("responder dentro del hilo lleva In-Reply-To y References", async () => {
    await d.send({
      lineId: LINE, to: parseAddress("ada@remoto.test"), clientMessageId: "r1",
      kind: "text",
      input: { to: "ada@remoto.test", text: "te respondo", replyTo: "<7@remoto.test>" },
    });
    const enviado = mail.enviados.at(-1)!;
    expect(enviado["inReplyTo"]).toBe("<7@remoto.test>");
    expect(enviado["references"]).toEqual(["<7@remoto.test>"]);
  });

  it("un adjunto por URL va como adjunto, no como cuerpo", async () => {
    await d.send({
      lineId: LINE, to: parseAddress("ada@remoto.test"), clientMessageId: "a1",
      kind: "document",
      input: {
        to: "ada@remoto.test", document: { url: "https://x.test/f.pdf" },
        fileName: "factura.pdf", caption: "ahí va",
      },
    });
    const adjuntos = mail.enviados.at(-1)!["attachments"] as { path: string; filename: string }[];
    expect(adjuntos[0]!.path).toBe("https://x.test/f.pdf");
    expect(adjuntos[0]!.filename).toBe("factura.pdf");
  });

  it("un envío queda en `sent`: que el SMTP lo acepte no es que llegue", async () => {
    const r = await d.send({
      lineId: LINE, to: parseAddress("ada@remoto.test"), clientMessageId: "e1",
      kind: "text", input: { to: "ada@remoto.test", text: "hola" },
    });
    expect(r.state).toBe("sent");
  });

  it("un rechazo del SMTP es fallo de la otra parte, no de quien pide", async () => {
    mail.fallarAlEnviar = new Error("451 try again later");
    const err = await d.send({
      lineId: LINE, to: parseAddress("ada@remoto.test"), clientMessageId: "f1",
      kind: "text", input: { to: "ada@remoto.test", text: "hola" },
    }).then(() => null).catch((e: { status: number }) => e);
    expect(err?.status).toBe(502);
  });

  it("ingiere lo nuevo del buzón y no repite lo ya visto", async () => {
    mail.recibir("ada@remoto.test", "Consulta", { nombre: "Ada" });
    expect(await d.pollOnce(LINE)).toBe(1);

    const recibido = eventos.find((e) => e.event === "message.received")!;
    const data = recibido.data as { from: string; subject: string; pushName: string };
    expect(data.from).toBe("ada@remoto.test");
    expect(data.subject).toBe("Consulta");
    expect(data.pushName).toBe("Ada");

    // La segunda vuelta no devuelve nada: sin el corte por UID, cada correo
    // saldría por el webhook una vez por revisión, para siempre.
    expect(await d.pollOnce(LINE)).toBe(0);

    mail.recibir("otro@remoto.test", "Otra cosa");
    expect(await d.pollOnce(LINE)).toBe(1);
  });

  it("el correo propio que vuelve al buzón no se ingiere", async () => {
    // Algunos buzones guardan copia de lo enviado en la misma carpeta.
    // Ingerirlo lo duplicaría y lo atribuiría al destinatario.
    mail.recibir(YO, "copia de lo que envié");
    expect(await d.pollOnce(LINE)).toBe(0);
    expect(eventos.filter((e) => e.event === "message.received")).toHaveLength(0);
  });

  it("recorta el asunto largo y no deja uno vacío", () => {
    expect(asuntoDe("")).toBe("(sin asunto)");
    expect(asuntoDe("   \n")).toBe("(sin asunto)");
    expect(asuntoDe("x".repeat(200))).toHaveLength(78);
  });

  it("desconectar cierra el transporte y deja la línea desconectada", async () => {
    await d.disconnect(LINE);
    expect(mail.cerrado).toBe(true);
    expect(d.status(LINE).state).toBe("disconnected");
  });
});
