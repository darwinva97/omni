import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asLineId, parseAddress, type EventEnvelope } from "@omni/shared";
import { LocalStorage } from "@omni/storage";
import { WhatsappWebDriver, ackToState, toWebContent, toWebId, webKind } from "./driver.js";
import { createFakeWebClient, type FakeWebControl } from "./fake-client.js";
import { ObjectStorageSessionStore } from "./session-store.js";
import type { OutboundCommand } from "../port.js";

const LINE = asLineId("l-web");

async function almacen(): Promise<LocalStorage> {
  return new LocalStorage({
    directory: await mkdtemp(join(tmpdir(), "omni-web-")),
    signingSecret: "secreto-de-firma-de-pruebas",
  });
}

async function conectado(): Promise<{
  driver: WhatsappWebDriver; fake: FakeWebControl; eventos: EventEnvelope[];
  guardadas: Uint8Array[];
}> {
  const fake = createFakeWebClient();
  const driver = new WhatsappWebDriver({ storage: await almacen(), makeClient: () => fake.cliente });
  const eventos: EventEnvelope[] = [];
  const guardadas: Uint8Array[] = [];
  driver.subscribe((e) => void eventos.push(e));
  await driver.connect({
    lineId: LINE, credentials: null,
    saveCredentials: async (b) => { guardadas.push(b); },
    config: { orgId: "org1" },
  });
  fake.emitir("ready");
  await new Promise((r) => setTimeout(r, 20));
  return { driver, fake, eventos, guardadas };
}

const cmd = (input: Record<string, unknown>, media?: OutboundCommand["media"]): OutboundCommand => ({
  lineId: LINE,
  to: parseAddress("51988777666@c.us"),
  clientMessageId: `c-${Math.random()}`,
  kind: "text",
  input: { to: "51988777666", ...input } as never,
  ...(media ? { media } : {}),
});

describe("enlace y ciclo de vida", () => {
  it("emite el QR y solo se da por listo con `ready`", async () => {
    const fake = createFakeWebClient();
    const driver = new WhatsappWebDriver({ storage: await almacen(), makeClient: () => fake.cliente });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });

    fake.emitir("qr", "QR-WEB-123");
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.status(LINE).state).toBe("awaiting-link");
    expect(eventos.some((e) => e.event === "session.qr")).toBe(true);

    fake.emitir("ready");
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.status(LINE).state).toBe("connected");
  });

  it("distingue caída de desvinculación", async () => {
    // Igual que en Baileys: ante LOGOUT reconectar no serviría de nada.
    const { driver, fake, eventos } = await conectado();
    fake.emitir("disconnected", "LOGOUT");
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.status(LINE).state).toBe("logged-out");
    expect(eventos.some((e) => e.event === "session.logged_out")).toBe(true);
  });

  it("una caída normal no se confunde con desvinculación", async () => {
    const { driver, fake, eventos } = await conectado();
    fake.emitir("disconnected", "NAVIGATION");
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.status(LINE).state).toBe("disconnected");
    expect(eventos.some((e) => e.event === "session.logged_out")).toBe(false);
  });

  it("desconectar CIERRA el navegador de verdad", async () => {
    // Un Chromium huérfano se queda con sus cientos de megas hasta que alguien
    // lo mate a mano.
    const { driver, fake } = await conectado();
    await driver.disconnect(LINE);
    expect(fake.destruido).toBe(true);
  });

  it("al guardarse la sesión remota solo se persiste un marcador", async () => {
    // El zip del perfil va al almacén de objetos; meterlo en una columna de la
    // base inflaría cada copia de seguridad con un navegador entero.
    const { fake, guardadas } = await conectado();
    fake.emitir("remote_session_saved");
    await new Promise((r) => setTimeout(r, 10));
    expect(guardadas).toHaveLength(1);
    const marcador = JSON.parse(new TextDecoder().decode(guardadas[0]!)) as { store: string };
    expect(marcador.store).toBe("object-storage");
    expect(guardadas[0]!.byteLength).toBeLessThan(200);
  });
});

describe("ingesta", () => {
  it("un entrante sale como message.received con su tipo traducido", async () => {
    const { fake, eventos } = await conectado();
    fake.emitir("message", {
      id: { _serialized: "false_51988777666@c.us_ABC" },
      from: "51988777666@c.us", body: "hola desde la web",
      type: "chat", fromMe: false, timestamp: 1_800_000_000, notifyName: "Ada",
    });
    await new Promise((r) => setTimeout(r, 20));
    const e = eventos.find((x) => x.event === "message.received")!;
    const d = e.data as { text: string; kind: string; pushName: string; timestamp: number };
    expect(d.text).toBe("hola desde la web");
    expect(d.kind).toBe("text");
    expect(d.pushName).toBe("Ada");
    // Los segundos de la interfaz web, a milisegundos.
    expect(d.timestamp).toBe(1_800_000_000_000);
  });

  it("los propios llegan por `message_create` y no se confunden", async () => {
    const { fake, eventos } = await conectado();
    fake.emitir("message_create", {
      id: { _serialized: "x" }, to: "51988777666@c.us", body: "mío",
      type: "chat", fromMe: true, timestamp: 1_800_000_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(eventos.some((e) => e.event === "message.sent")).toBe(true);
    expect(eventos.some((e) => e.event === "message.received")).toBe(false);
  });

  it("los acuses usan la escala de la interfaz web", async () => {
    const { fake, eventos } = await conectado();
    fake.emitir("message_ack", { id: { _serialized: "m1" }, from: "x@c.us" }, 3);
    await new Promise((r) => setTimeout(r, 20));
    expect((eventos.find((e) => e.event === "message.receipt")!.data as { state: string }).state).toBe("read");
  });

  it("un borrado para todos se publica", async () => {
    const { fake, eventos } = await conectado();
    fake.emitir("message_revoke_everyone", { id: { _serialized: "m1" }, from: "x@c.us", fromMe: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(eventos.some((e) => e.event === "message.deleted")).toBe(true);
  });
});

describe("acciones", () => {
  it("marca el chat como visto", async () => {
    const { driver, fake } = await conectado();
    await driver.markRead(LINE, parseAddress("51988777666@c.us"), []);
    expect(fake.vistos).toEqual(["51988777666@c.us"]);
  });

  it("lee un grupo con sus roles", async () => {
    const { driver } = await conectado();
    const meta = await driver.groupMetadata(LINE, parseAddress("120@g.us"));
    expect(meta.subject).toBe("Grupo falso");
    expect(meta.participants[0]!.role).toBe("superadmin");
    expect(meta.participants[1]!.role).toBe("member");
  });

  it("pedir datos de grupo sobre un contacto se rechaza", async () => {
    const { driver } = await conectado();
    await expect(driver.groupMetadata(LINE, parseAddress("51988777666@c.us")))
      .rejects.toMatchObject({ status: 422 });
  });

  it("informa por participante donde el cliente lo dice", async () => {
    const { driver } = await conectado();
    const res = await driver.updateParticipants(
      LINE, parseAddress("120@g.us"),
      [parseAddress("51999000111@c.us"), parseAddress("51900000000@c.us")],
      "add",
    );
    expect(res[0]!.ok).toBe(true);
    expect(res[1]!.ok).toBe(false);
    expect(res[1]!.reason).toContain("no se puede añadir");
  });

  it("editar un mensaje que no está entre los últimos cien lo DICE", async () => {
    // La interfaz web no busca por identificador: hay que recorrer el chat, y
    // fingir que se encontró sería peor que explicarlo.
    const { driver } = await conectado();
    await expect(driver.editMessage(LINE, parseAddress("51988777666@c.us"), "no-existe", "x"))
      .rejects.toThrow(/no busca por identificador/);
  });

  it("edita cuando el mensaje sí está en el chat", async () => {
    const { driver, fake } = await conectado();
    let editado = "";
    fake.historial["51988777666@c.us"] = [
      { id: { _serialized: "m-real" }, edit: async (t: string) => { editado = t; } },
    ];
    await driver.editMessage(LINE, parseAddress("51988777666@c.us"), "m-real", "corregido");
    expect(editado).toBe("corregido");
  });

  it("trae historial, que es lo que Baileys no puede", async () => {
    const { driver, fake, eventos } = await conectado();
    fake.historial["51988777666@c.us"] = [{ id: { _serialized: "a" } }, { id: { _serialized: "b" } }];
    await driver.fetchHistory(LINE, parseAddress("51988777666@c.us"), Date.now(), 50);
    const e = eventos.find((x) => x.event === "history.synced")!;
    expect((e.data as { count: number }).count).toBe(2);
  });
});

describe("traducción de contenido", () => {
  it("texto, con cita y menciones", () => {
    const { contenido, opciones } = toWebContent(
      cmd({ text: "hola", replyTo: "m1", mentions: ["51999000111"] }), "text",
    );
    expect(contenido).toBe("hola");
    expect(opciones).toMatchObject({ quotedMessageId: "m1", mentions: ["51999000111"] });
  });

  it("un medio va en base64 con su tipo", () => {
    const r = toWebContent(
      cmd({ image: { url: "https://e.com/a.png" }, caption: "mira" },
          { bytes: new Uint8Array([1, 2]), mimeType: "image/png" }),
      "image",
    );
    expect(r.contenido).toMatchObject({ mimetype: "image/png", data: "AQI=" });
    expect(r.opciones).toMatchObject({ caption: "mira" });
  });

  it("una nota de voz se marca como tal", () => {
    const r = toWebContent(
      cmd({ audio: { url: "x" }, ptt: true }, { bytes: new Uint8Array([1]), mimeType: "audio/ogg" }),
      "audio",
    );
    expect(r.opciones).toMatchObject({ sendAudioAsVoice: true });
  });

  it("un pegatina y un documento llevan su bandera", () => {
    const s = toWebContent(cmd({ sticker: { url: "x" } }, { bytes: new Uint8Array([1]), mimeType: "image/webp" }), "sticker");
    expect(s.opciones).toMatchObject({ sendMediaAsSticker: true });
    const d = toWebContent(cmd({ document: { url: "x" } }, { bytes: new Uint8Array([1]), mimeType: "application/pdf" }), "document");
    expect(d.opciones).toMatchObject({ sendMediaAsDocument: true });
  });

  it("un medio sin bytes falla en vez de enviar vacío", () => {
    expect(() => toWebContent(cmd({ image: { url: "x" } }), "image")).toThrow(/falta el contenido/);
  });
});

describe("capacidades honestas", () => {
  it("SÍ declara historial: es su ventaja sobre Baileys", async () => {
    const d = new WhatsappWebDriver({ storage: await almacen() });
    expect(d.descriptor.capabilities.has("history.sync")).toBe(true);
    expect(d.descriptor.capabilities.has("label.manage")).toBe(true);
  });

  it("NO declara rechazar llamadas ni vista única: la web no los tiene", async () => {
    const d = new WhatsappWebDriver({ storage: await almacen() });
    for (const c of ["call.reject", "send.viewOnce", "chat.ephemeral", "identity.lid", "send.buttons"] as const) {
      expect(d.descriptor.capabilities.has(c), c).toBe(false);
    }
  });

  it("declara su coste real de memoria, muy por encima de Baileys", async () => {
    const d = new WhatsappWebDriver({ storage: await almacen() });
    expect(d.descriptor.approxMemoryMbPerLine).toBeGreaterThan(100);
    expect(d.descriptor.risk).toBe("unofficial");
  });
});

describe("traducción de direcciones", () => {
  it("un individuo va como @c.us, que es lo que esta biblioteca usa", () => {
    // Pasarle nuestra forma canónica hace que toda búsqueda de chat falle sin
    // decir por qué.
    expect(toWebId(parseAddress("51988777666@s.whatsapp.net"))).toBe("51988777666@c.us");
    expect(toWebId(parseAddress("51988777666@c.us"))).toBe("51988777666@c.us");
  });

  it("un grupo mantiene su sufijo", () => {
    expect(toWebId(parseAddress("120@g.us"))).toBe("120@g.us");
  });
});

describe("traducciones", () => {
  it("acuses", () => {
    expect(ackToState(-1)).toBe("failed");
    expect(ackToState(1)).toBe("sent");
    expect(ackToState(3)).toBe("read");
    expect(ackToState(99)).toBeNull();
  });

  it("tipos, sin inventar los desconocidos", () => {
    expect(webKind("chat")).toBe("text");
    expect(webKind("ptt")).toBe("audio");
    expect(webKind("multi_vcard")).toBe("contact");
    expect(webKind("algo_nuevo")).toBe("unknown");
  });
});

describe("almacén de sesión", () => {
  it("guarda el zip bajo un prefijo por organización", async () => {
    const s = await almacen();
    const store = new ObjectStorageSessionStore(s, "org1", {
      readFile: async () => new Uint8Array([80, 75, 3, 4]),
      writeFile: async () => {},
    });
    expect(await store.sessionExists({ session: "l1" })).toBe(false);
    await store.save({ session: "l1" });
    expect(await store.sessionExists({ session: "l1" })).toBe(true);
    expect(await s.exists("sessions/org1/wwebjs/l1.zip")).toBe(true);
  });

  it("que no haya sesión NO es un error: significa primer enlace", async () => {
    const store = new ObjectStorageSessionStore(await almacen(), "org1", {
      readFile: async () => new Uint8Array(),
      writeFile: async () => { throw new Error("no debería escribir"); },
    });
    await expect(store.extract({ session: "nueva", path: "/tmp/x.zip" })).resolves.toBeUndefined();
  });

  it("borrar quita el objeto", async () => {
    const s = await almacen();
    const store = new ObjectStorageSessionStore(s, "org1", {
      readFile: async () => new Uint8Array([1]), writeFile: async () => {},
    });
    await store.save({ session: "l1" });
    await store.delete({ session: "l1" });
    expect(await s.exists("sessions/org1/wwebjs/l1.zip")).toBe(false);
  });
});
