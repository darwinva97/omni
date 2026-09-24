import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { asLineId, type EventEnvelope } from "@omni/shared";
import { CloudDriver, cloudKind, cloudText, statusToState } from "./driver.js";
import { createFakeMeta, type FakeMeta } from "./fake-meta.js";
import type { CloudWebhookPayload } from "./types.js";

const LINE = asLineId("l-cloud");
const APP_SECRET = "secreto-de-la-app";

async function conectado(): Promise<{ driver: CloudDriver; meta: FakeMeta; eventos: EventEnvelope[] }> {
  const meta = createFakeMeta();
  const driver = new CloudDriver({ fetchImpl: meta.fetchImpl });
  const eventos: EventEnvelope[] = [];
  driver.subscribe((e) => void eventos.push(e));
  await driver.connect({
    lineId: LINE, credentials: null, saveCredentials: async () => {},
    config: { orgId: "org1", phoneNumberId: "123456", accessToken: "tok", appSecret: APP_SECRET },
  });
  return { driver, meta, eventos };
}

const webhook = (valor: Record<string, unknown>): CloudWebhookPayload => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "waba-1",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "51999888777", phone_number_id: "123456" },
        ...valor,
      } as never,
    }],
  }],
});

describe("conexión con la API oficial", () => {
  it("no hay QR: valida el token y queda conectada", async () => {
    const { driver } = await conectado();
    const estado = driver.status(LINE);
    expect(estado.state).toBe("connected");
    if (estado.state === "connected") {
      expect(estado.self.local).toBe("51999888777");
      expect(estado.pushName).toBe("Empresa");
    }
  });

  it("sin credenciales dice CUÁLES faltan, no un error genérico", async () => {
    const meta = createFakeMeta();
    const driver = new CloudDriver({ fetchImpl: meta.fetchImpl });
    const err = await driver.connect({
      lineId: LINE, credentials: null, saveCredentials: async () => {}, config: { orgId: "o" },
    }).then(() => null, (e: unknown) => e as Error & { details: { faltan: string[] } });
    expect(err, "conectar sin credenciales no puede tener éxito").not.toBeNull();
    expect(err!.message).toContain("phoneNumberId");
    expect(err!.details.faltan).toEqual(["phoneNumberId", "accessToken"]);
  });

  it("un token inválido se traduce a 401, no a un fallo aguas arriba", async () => {
    const meta = createFakeMeta();
    meta.fallo = { status: 401, message: "Invalid OAuth access token" };
    const driver = new CloudDriver({ fetchImpl: meta.fetchImpl });
    await expect(driver.connect({
      lineId: LINE, credentials: null, saveCredentials: async () => {},
      config: { phoneNumberId: "1", accessToken: "malo" },
    })).rejects.toMatchObject({ status: 401 });
  });

  it("el mensaje de Meta llega al usuario: 'HTTP 400' no es accionable", async () => {
    const { driver, meta } = await conectado();
    meta.fallo = { status: 400, message: "(#131030) Recipient phone number not in allowed list", code: 131030 };
    const err = await driver.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "c1", kind: "text", input: { to: "51988777666", text: "hola" },
    }).then(() => null, (e: unknown) => e as Error & { details: { metaCode: number } });
    expect(err, "Meta rechazó el envío y aun así resolvió").not.toBeNull();
    expect(err!.message).toContain("not in allowed list");
    expect(err!.details.metaCode).toBe(131030);
  });
});

describe("envío", () => {
  it("manda texto con el cuerpo que espera la Graph API", async () => {
    const { driver, meta } = await conectado();
    await driver.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "c1", kind: "text", input: { to: "51988777666", text: "hola" },
    });
    const envio = meta.llamadas.at(-1)!;
    expect(envio.url).toContain("/v21.0/123456/messages");
    expect(envio.body).toMatchObject({
      messaging_product: "whatsapp", to: "51988777666",
      type: "text", text: { body: "hola" },
    });
  });

  it("una respuesta lleva el contexto del mensaje citado", async () => {
    const { driver, meta } = await conectado();
    await driver.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "c2", kind: "text",
      input: { to: "51988777666", text: "respondo", replyTo: "wamid.ABC" },
    });
    expect(meta.llamadas.at(-1)!.body).toMatchObject({ context: { message_id: "wamid.ABC" } });
  });

  it("un medio sin URL pública lo dice en vez de enviar algo roto", async () => {
    // Meta descarga el fichero por su cuenta: sin URL alcanzable no hay envío.
    const { driver } = await conectado();
    await expect(driver.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "c3", kind: "image",
      input: { to: "51988777666", image: { base64: "AAA=", mimeType: "image/png" } },
    })).rejects.toThrow(/URL pública/);
  });

  it("lo que la API oficial no admite se rechaza nombrando la capacidad", async () => {
    const { driver } = await conectado();
    const err = await driver.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "c4", kind: "poll",
      input: { to: "51988777666", poll: { question: "¿?", options: ["a", "b"], allowMultipleAnswers: false } },
    }).then(() => null, (e: unknown) => e as Error & { status: number; details: { capability: string } });
    expect(err, "aceptó una encuesta que la API oficial no admite").not.toBeNull();
    expect(err!.status).toBe(422);
    expect(err!.details.capability).toBe("send.poll");
  });
});

describe("ingesta por webhook", () => {
  it("un mensaje entrante sale como message.received", async () => {
    const { driver, eventos } = await conectado();
    const n = await driver.ingestWebhook(LINE, webhook({
      contacts: [{ profile: { name: "Ada" }, wa_id: "51988777666" }],
      messages: [{
        from: "51988777666", id: "wamid.IN1", timestamp: "1800000000",
        type: "text", text: { body: "quiero un presupuesto" },
      }],
    }));
    expect(n).toBe(1);

    const recibido = eventos.find((e) => e.event === "message.received")!;
    const data = recibido.data as { text: string; pushName: string; timestamp: number };
    expect(data.text).toBe("quiero un presupuesto");
    expect(data.pushName).toBe("Ada");
    // Meta da segundos: tratarlos como milisegundos sitúa el mensaje en 1970.
    expect(data.timestamp).toBe(1_800_000_000_000);
  });

  it("los acuses de estado se traducen a recibos", async () => {
    const { driver, eventos } = await conectado();
    await driver.ingestWebhook(LINE, webhook({
      statuses: [{ id: "wamid.OUT1", status: "read", timestamp: "1800000001", recipient_id: "51988777666" }],
    }));
    const recibo = eventos.find((e) => e.event === "message.receipt")!;
    expect((recibo.data as { state: string }).state).toBe("read");
  });

  it("un envío fallido trae el motivo de Meta", async () => {
    const { driver, eventos } = await conectado();
    await driver.ingestWebhook(LINE, webhook({
      statuses: [{
        id: "wamid.OUT2", status: "failed", timestamp: "1800000002", recipient_id: "51988777666",
        errors: [{ message: "Message failed to send because more than 24 hours have passed", code: 131047, type: "x" }],
      }],
    }));
    const recibo = eventos.find((e) => (e.data as { state?: string }).state === "failed")!;
    expect((recibo.data as { error: string }).error).toContain("24 hours");
  });

  it("una reacción no se confunde con un mensaje nuevo", async () => {
    const { driver, eventos } = await conectado();
    await driver.ingestWebhook(LINE, webhook({
      messages: [{
        from: "51988777666", id: "wamid.R1", timestamp: "1800000003",
        type: "reaction", reaction: { message_id: "wamid.OUT1", emoji: "👍" },
      }],
    }));
    expect(eventos.some((e) => e.event === "message.reaction")).toBe(true);
    expect(eventos.some((e) => e.event === "message.received")).toBe(false);
  });

  it("procesa varios cambios en una sola entrega", async () => {
    // Meta agrupa: tratar solo el primero pierde mensajes en horas punta.
    const { driver } = await conectado();
    const n = await driver.ingestWebhook(LINE, webhook({
      messages: [
        { from: "51988777666", id: "a", timestamp: "1800000000", type: "text", text: { body: "uno" } },
        { from: "51900000000", id: "b", timestamp: "1800000001", type: "text", text: { body: "dos" } },
      ],
      statuses: [{ id: "c", status: "delivered", timestamp: "1800000002", recipient_id: "51988777666" }],
    }));
    expect(n).toBe(3);
  });
});

describe("firma del webhook de Meta", () => {
  const cuerpo = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const firma = (secreto: string): string =>
    "sha256=" + createHmac("sha256", secreto).update(cuerpo, "utf8").digest("hex");

  it("acepta la firma correcta", async () => {
    const { driver } = await conectado();
    expect(driver.verifyWebhookSignature(LINE, cuerpo, firma(APP_SECRET))).toBe(true);
  });

  it("rechaza otra firma, otro cuerpo y una cabecera ausente", async () => {
    // Sin esta comprobación, quien conozca la URL inventa mensajes entrantes
    // en nombre de tus clientes.
    const { driver } = await conectado();
    expect(driver.verifyWebhookSignature(LINE, cuerpo, firma("otro-secreto"))).toBe(false);
    expect(driver.verifyWebhookSignature(LINE, cuerpo + " ", firma(APP_SECRET))).toBe(false);
    expect(driver.verifyWebhookSignature(LINE, cuerpo, undefined)).toBe(false);
    expect(driver.verifyWebhookSignature(LINE, cuerpo, "no-es-sha256")).toBe(false);
  });

  it("sin appSecret configurado NO se acepta nada", async () => {
    const meta = createFakeMeta();
    const driver = new CloudDriver({ fetchImpl: meta.fetchImpl });
    await driver.connect({
      lineId: LINE, credentials: null, saveCredentials: async () => {},
      config: { phoneNumberId: "1", accessToken: "t" },
    });
    expect(driver.verifyWebhookSignature(LINE, cuerpo, firma(APP_SECRET))).toBe(false);
  });
});

describe("capacidades declaradas con honestidad", () => {
  it("NO dice ver grupos, que es la limitación que define este transporte", () => {
    const d = new CloudDriver();
    for (const c of ["group.read", "group.create", "group.manage", "group.participants"] as const) {
      expect(d.descriptor.capabilities.has(c), c).toBe(false);
    }
  });

  it("tampoco encuestas, edición, borrado, llamadas ni historial", () => {
    const d = new CloudDriver();
    for (const c of ["send.poll", "message.edit", "message.delete", "call.receive", "history.sync"] as const) {
      expect(d.descriptor.capabilities.has(c), c).toBe(false);
    }
  });

  it("se declara como transporte OFICIAL y sin coste de memoria", () => {
    const d = new CloudDriver();
    expect(d.descriptor.risk).toBe("official");
    expect(d.descriptor.linkMethod).toBe("api-key");
    expect(d.descriptor.approxMemoryMbPerLine).toBeLessThan(5);
  });
});

describe("traducciones", () => {
  it("estados de Meta a los nuestros", () => {
    expect(statusToState("sent")).toBe("sent");
    expect(statusToState("read")).toBe("read");
    expect(statusToState("failed")).toBe("failed");
    expect(statusToState("inventado")).toBeNull();
  });

  it("tipos de mensaje, sin inventar los desconocidos", () => {
    expect(cloudKind("image")).toBe("image");
    expect(cloudKind("contacts")).toBe("contact");
    expect(cloudKind("algo_nuevo")).toBe("unknown");
  });

  it("el texto sale del cuerpo o del pie, según el tipo", () => {
    expect(cloudText({ from: "x", id: "1", timestamp: "0", type: "text", text: { body: "hola" } })).toBe("hola");
    expect(cloudText({
      from: "x", id: "1", timestamp: "0", type: "image",
      image: { id: "m", mime_type: "image/png", sha256: "s", caption: "un pie" },
    })).toBe("un pie");
    expect(cloudText({ from: "x", id: "1", timestamp: "0", type: "sticker" })).toBeNull();
  });
});
