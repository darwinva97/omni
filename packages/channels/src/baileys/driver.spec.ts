import { describe, it, expect } from "vitest";
import { asLineId, type EventEnvelope } from "@omni/shared";
import { BaileysDriver, ackToState, deterministicMessageId, extractText, messageKind } from "./driver.js";
import { createFakeSocket, type FakeSocketControl } from "./fake-socket.js";

const LINE = asLineId("l1");

async function conectado(): Promise<{ driver: BaileysDriver; fake: FakeSocketControl; eventos: EventEnvelope[] }> {
  const fake = createFakeSocket();
  const driver = new BaileysDriver({
    makeSocket: () => fake.socket,
    fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
    linkWaitMs: 0,
    reconnectBaseMs: 10,
  });
  const eventos: EventEnvelope[] = [];
  driver.subscribe((e) => void eventos.push(e));
  await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: { orgId: "org1" } });
  fake.emitConnection({ connection: "open" });
  await new Promise((r) => setTimeout(r, 20));
  return { driver, fake, eventos };
}

describe("acuses de WhatsApp", () => {
  it("traduce cada código a su estado", () => {
    expect(ackToState(1)).toBe("sent");
    expect(ackToState(2)).toBe("delivered");
    expect(ackToState(3)).toBe("read");
    expect(ackToState(4)).toBe("played");
    expect(ackToState(0)).toBe("failed");
  });

  it("un código desconocido no inventa un estado", () => {
    expect(ackToState(99)).toBeNull();
    expect(ackToState(null)).toBeNull();
    expect(ackToState(undefined)).toBeNull();
  });
});

describe("extracción de texto", () => {
  it("lee el texto simple", () => {
    expect(extractText({ conversation: "hola" })).toBe("hola");
  });

  it("lee el texto con formato, que va en otro campo", () => {
    // Asumir sólo `conversation` es el fallo más común al integrar: cualquier
    // mensaje con enlace o con formato llega por `extendedTextMessage`.
    expect(extractText({ extendedTextMessage: { text: "con *formato*" } })).toBe("con *formato*");
  });

  it("lee el pie de una imagen o un vídeo", () => {
    expect(extractText({ imageMessage: { caption: "mira esto" } })).toBe("mira esto");
    expect(extractText({ videoMessage: { caption: "vídeo" } })).toBe("vídeo");
  });

  it("un mensaje sin texto devuelve null, no cadena vacía", () => {
    expect(extractText({ stickerMessage: {} })).toBeNull();
    expect(extractText(null)).toBeNull();
  });
});

describe("tipo de mensaje", () => {
  it("reconoce los tipos habituales", () => {
    const k = (message: unknown) => messageKind({ message } as never);
    expect(k({ conversation: "x" })).toBe("text");
    expect(k({ extendedTextMessage: { text: "x" } })).toBe("text");
    expect(k({ imageMessage: {} })).toBe("image");
    expect(k({ audioMessage: {} })).toBe("audio");
    expect(k({ pollCreationMessageV3: {} })).toBe("poll");
    expect(k({ protocolMessage: {} })).toBe("system");
    expect(k(null)).toBe("unknown");
    expect(k({ algoNuevo: {} })).toBe("unknown");
  });
});

describe("identificador derivado", () => {
  it("la misma orden produce siempre el mismo identificador", () => {
    expect(deterministicMessageId("pedido-42")).toBe(deterministicMessageId("pedido-42"));
    expect(deterministicMessageId("pedido-42")).not.toBe(deterministicMessageId("pedido-43"));
  });

  it("tiene la forma que usan los clientes oficiales", () => {
    const id = deterministicMessageId("x");
    expect(id).toMatch(/^3EB0[0-9A-F]{28}$/);
  });
});

describe("driver de Baileys: conexión", () => {
  it("emite el QR y no se da por conectado hasta que abre", async () => {
    const fake = createFakeSocket();
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });

    fake.emitConnection({ qr: "QR-DE-PRUEBA" });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.status(LINE).state).toBe("awaiting-link");
    expect(eventos.some((e) => e.event === "session.qr")).toBe(true);

    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.status(LINE).state).toBe("connected");
  });

  it("ante una desvinculación NO reintenta: las credenciales ya no valen", async () => {
    const fake = createFakeSocket();
    let sockets = 0;
    const driver = new BaileysDriver({
      makeSocket: () => { sockets++; return fake.socket; },
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
    linkWaitMs: 0,
      reconnectBaseMs: 5,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });

    const boom = Object.assign(new Error("logged out"), { output: { statusCode: 401 } });
    fake.emitConnection({ connection: "close", lastDisconnect: { error: boom as Error } });
    await new Promise((r) => setTimeout(r, 60));

    expect(driver.status(LINE).state).toBe("logged-out");
    expect(eventos.some((e) => e.event === "session.logged_out")).toBe(true);
    expect(sockets, "reintentó pese a estar desvinculado").toBe(1);
  });

  it("ante una caída normal sí reintenta, con retardo creciente", async () => {
    const fake = createFakeSocket();
    let sockets = 0;
    const driver = new BaileysDriver({
      makeSocket: () => { sockets++; return fake.socket; },
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
    linkWaitMs: 0,
      reconnectBaseMs: 5, maxReconnectAttempts: 2,
    });
    await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });
    const boom = Object.assign(new Error("caída"), { output: { statusCode: 500 } });
    fake.emitConnection({ connection: "close", lastDisconnect: { error: boom as Error } });
    await new Promise((r) => setTimeout(r, 80));
    expect(sockets).toBeGreaterThan(1);
  });
});

describe("driver de Baileys: ingesta", () => {
  it("un mensaje entrante sale como message.received con su texto y tipo", async () => {
    const { fake, eventos } = await conectado();
    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "ABC", remoteJid: "51988777666@s.whatsapp.net", fromMe: false },
        message: { extendedTextMessage: { text: "hola con formato" } },
        pushName: "Ada", messageTimestamp: 1_800_000_000,
      }],
    });
    await new Promise((r) => setTimeout(r, 20));

    const recibido = eventos.find((e) => e.event === "message.received")!;
    const data = recibido.data as { text: string; kind: string; pushName: string };
    expect(data.text).toBe("hola con formato");
    expect(data.kind).toBe("text");
    expect(data.pushName).toBe("Ada");
  });

  it("un mensaje propio sale como message.sent, no como recibido", async () => {
    const { fake, eventos } = await conectado();
    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{ key: { id: "X", remoteJid: "51988777666@s.whatsapp.net", fromMe: true }, message: { conversation: "mío" } }],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(eventos.some((e) => e.event === "message.sent")).toBe(true);
    expect(eventos.some((e) => e.event === "message.received")).toBe(false);
  });

  it("ignora los mensajes que no son notificaciones nuevas", async () => {
    // `append` es historial que llega al sincronizar: tratarlo como entrante
    // dispararía respuestas automáticas a conversaciones de hace meses.
    const { fake, eventos } = await conectado();
    fake.emitRaw("messages.upsert", {
      type: "append",
      messages: [{ key: { id: "VIEJO", remoteJid: "x@s.whatsapp.net", fromMe: false }, message: { conversation: "antiguo" } }],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(eventos.some((e) => e.event === "message.received")).toBe(false);
  });

  it("traduce los acuses a recibos", async () => {
    const { fake, eventos } = await conectado();
    fake.emitRaw("messages.update", [
      { key: { id: "ABC", remoteJid: "x@s.whatsapp.net", fromMe: true }, update: { status: 3 } },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const recibo = eventos.find((e) => e.event === "message.receipt")!;
    expect((recibo.data as { state: string }).state).toBe("read");
  });

  it("una llamada entrante se publica y se puede rechazar", async () => {
    const { driver, fake, eventos } = await conectado();
    fake.emitRaw("call", [{ id: "CALL1", from: "51988777666@s.whatsapp.net", status: "offer" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(eventos.some((e) => e.event === "call.received")).toBe(true);
    await expect(driver.rejectCall(LINE, "CALL1", { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" }))
      .resolves.not.toThrow();
  });
});

describe("driver de Baileys: acciones", () => {
  it("el retardo de escritura anuncia y luego pausa", async () => {
    const { driver, fake } = await conectado();
    await driver.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "t1", kind: "text",
      input: { to: "51988777666", text: "hola", typingMs: 10 },
    });
    expect(fake.presence.map((p) => p.presence)).toEqual(["composing", "paused"]);
  });

  it("comprueba si un número existe", async () => {
    const { driver } = await conectado();
    const si = await driver.checkContact(LINE, { kind: "pn", local: "51999000111", value: "51999000111@s.whatsapp.net" });
    expect(si.exists).toBe(true);
    const no = await driver.checkContact(LINE, { kind: "pn", local: "10000000", value: "10000000@s.whatsapp.net" });
    expect(no.exists).toBe(false);
  });

  it("informa por participante al gestionar un grupo", async () => {
    const { driver } = await conectado();
    const res = await driver.updateParticipants(
      LINE, { kind: "group", local: "120", value: "120@g.us" },
      [
        { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
        { kind: "pn", local: "51900000000", value: "51900000000@s.whatsapp.net" },
      ],
      "add",
    );
    expect(res[0]!.ok).toBe(true);
    expect(res[1]!.ok).toBe(false);
    expect(res[1]!.reason).toContain("403");
  });

  it("lee los datos de un grupo con sus roles", async () => {
    const { driver } = await conectado();
    const meta = await driver.groupMetadata(LINE, { kind: "group", local: "120", value: "120@g.us" });
    expect(meta.subject).toBe("Grupo falso");
    expect(meta.participants[0]!.role).toBe("superadmin");
    expect(meta.participants[1]!.role).toBe("member");
  });
});

describe("capacidades declaradas", () => {
  it("NO declara lo que el núcleo oficial no sabe hacer", async () => {
    // Declararlas haría que la API aceptara peticiones que no llegan a ninguna
    // parte. Es preferible un 422 honesto.
    const { driver } = await conectado();
    expect(driver.descriptor.capabilities.has("send.buttons")).toBe(false);
    expect(driver.descriptor.capabilities.has("send.list")).toBe(false);
    expect(driver.descriptor.capabilities.has("label.manage")).toBe(false);
  });

  it("se declara como transporte NO oficial", () => {
    const driver = new BaileysDriver();
    expect(driver.descriptor.risk).toBe("unofficial");
  });
});
