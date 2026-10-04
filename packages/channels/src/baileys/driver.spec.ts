import { describe, it, expect } from "vitest";
import { asLineId, parseAddress, type EventEnvelope } from "@omni/shared";
import { BaileysDriver, ackToState, deterministicMessageId, extractText, messageKind } from "./driver.js";
import { createFakeSocket, type FakeSocketControl } from "./fake-socket.js";
import { generateMessageIDV2 } from "baileys";

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

  it("tiene la MISMA forma que el que genera Baileys", () => {
    /*
     * Se compara contra el generador DE BAILEYS, no contra una longitud
     * escrita aquí a mano.
     *
     * La versión anterior de esta prueba afirmaba 28 dígitos hexadecimales
     * porque es lo que ponía el código, y el código estaba mal: Baileys usa
     * 18. Con la longitud equivocada el servidor de WhatsApp acepta el envío,
     * devuelve identificador y hasta manda acuses de lectura, y el mensaje no
     * aparece en NINGÚN cliente —ni en el teléfono de quien lo envía—. Una
     * prueba que repite lo que dice el código no comprueba nada.
     */
    const nuestro = deterministicMessageId("x");
    const deBaileys = generateMessageIDV2("51999888777@s.whatsapp.net");

    expect(nuestro).toHaveLength(deBaileys.length);
    expect(nuestro).toMatch(/^3EB0[0-9A-F]+$/);
    expect(deBaileys).toMatch(/^3EB0[0-9A-F]+$/);
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

describe("reintentos que pide el destinatario", () => {
  it("conserva lo enviado para poder servir el reintento", async () => {
    /*
     * Cuando un dispositivo no consigue descifrar un mensaje pide un
     * REINTENTO, y Baileys nos lo reclama por `getMessage`. Devolver
     * `undefined` —lo que se hacía— significa «no lo tengo»: ese dispositivo
     * se queda sin el mensaje y no hay ningún error por nuestra parte.
     */
    const fake = createFakeSocket({ id: "51999888777:1@s.whatsapp.net" });
    let opciones: Record<string, unknown> = {};
    const driver = new BaileysDriver({
      makeSocket: (o) => { opciones = o as Record<string, unknown>; return fake.socket; },
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      // Sin espera: el enlace lo simula `emitConnection` justo después.
      linkWaitMs: 0,
    });
    const line = asLineId("l-retry");
    await driver.connect({
      lineId: line, credentials: null, saveCredentials: async () => {},
      config: { orgId: "org1" },
    });
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));

    const receipt = await driver.send({
      lineId: line, to: parseAddress("51988777666"), clientMessageId: "r-1",
      kind: "text", input: { to: "51988777666", text: "hola" },
    });

    const getMessage = opciones["getMessage"] as (k: { id: string }) => Promise<unknown>;
    expect(typeof getMessage).toBe("function");
    expect(await getMessage({ id: receipt.providerMessageId })).toBeDefined();
    // Y de uno que no es nuestro, no se inventa nada.
    expect(await getMessage({ id: "NO-ES-NUESTRO" })).toBeUndefined();
  });
});

describe("reconocer el mensaje propio cuando vuelve", () => {
  it("el eco y el acuse llevan el identificador que pusimos nosotros", async () => {
    /*
     * WhatsApp devuelve SU identificador, y lo que vuelve por los eventos solo
     * lleva ese. Sin este puente, quien envió no reconoce su propio mensaje al
     * volver: el panel dejaba las notas de voz en «queued» para siempre,
     * porque emparejaba por el texto y un audio no tiene.
     */
    const fake = createFakeSocket({ id: "51999888777:1@s.whatsapp.net" });
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    const line = asLineId("l-eco");
    await driver.connect({
      lineId: line, credentials: null, saveCredentials: async () => {},
      config: { orgId: "org1" },
    });
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));

    const receipt = await driver.send({
      lineId: line, to: parseAddress("51988777666"), clientMessageId: "mio-1",
      kind: "audio", input: { to: "51988777666", audio: { url: "https://x.test/a.ogg" }, ptt: true },
      // El motor resuelve los bytes antes de llegar al driver.
      media: { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" },
    });

    // El eco que manda WhatsApp de nuestro propio mensaje.
    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: receipt.providerMessageId, remoteJid: "51988777666@s.whatsapp.net", fromMe: true },
        message: { audioMessage: {} }, messageTimestamp: 1_800_000_000,
      }],
    });
    await new Promise((r) => setTimeout(r, 20));

    const eco = eventos.find((e) => e.event === "message.sent");
    expect(eco).toBeDefined();
    expect((eco!.data as { clientMessageId?: string }).clientMessageId).toBe("mio-1");

    // Y el acuse, que es lo que saca el mensaje de «queued».
    fake.emitRaw("message-receipt.update", [{
      key: { id: receipt.providerMessageId, remoteJid: "51988777666@s.whatsapp.net", fromMe: true },
      receipt: { readTimestamp: 1_800_000_050 },
    }]);
    await new Promise((r) => setTimeout(r, 20));

    const acuse = eventos.find((e) => e.event === "message.receipt");
    expect((acuse!.data as { clientMessageId?: string }).clientMessageId).toBe("mio-1");
  });

  it("de un mensaje AJENO no se inventa un identificador propio", async () => {
    const fake = createFakeSocket({ id: "51999888777:1@s.whatsapp.net" });
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({
      lineId: asLineId("l-ajeno"), credentials: null, saveCredentials: async () => {},
      config: { orgId: "org1" },
    });
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));

    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "AJENO1", remoteJid: "51988777666@s.whatsapp.net", fromMe: false },
        message: { conversation: "hola" }, messageTimestamp: 1_800_000_000,
      }],
    });
    await new Promise((r) => setTimeout(r, 20));

    const recibido = eventos.find((e) => e.event === "message.received")!;
    expect((recibido.data as { clientMessageId?: string }).clientMessageId).toBeUndefined();
  });
});
