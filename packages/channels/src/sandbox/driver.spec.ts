import { describe, it, expect, beforeEach } from "vitest";
import { asLineId, type EventEnvelope } from "@omni/shared";
import { SandboxDriver } from "./driver.js";

const LINE = asLineId("l1");

async function connected(opts = {}) {
  const d = new SandboxDriver({ nextId: (() => { let n = 0; return () => `ID${++n}`; })(), ...opts });
  const events: EventEnvelope[] = [];
  d.subscribe((e) => void events.push(e));
  await d.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: { orgId: "org1" } });
  await d.scan(LINE, "51999888777");
  return { d, events };
}

describe("sandbox: enlace", () => {
  it("emite QR y solo se conecta tras escanear", async () => {
    const d = new SandboxDriver();
    const events: EventEnvelope[] = [];
    d.subscribe((e) => void events.push(e));

    const r = await d.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });
    expect(r.status.state).toBe("awaiting-link");
    expect(events.some((e) => e.event === "session.qr")).toBe(true);

    await d.scan(LINE, "51999888777");
    expect(d.status(LINE).state).toBe("connected");
  });

  it("con credenciales guardadas reconecta sin pedir QR", async () => {
    // Lo que debe pasar en un redespliegue: no volver a escanear nada.
    const d = new SandboxDriver();
    let saved: Uint8Array | null = null;
    await d.connect({ lineId: LINE, credentials: null, saveCredentials: async (b) => { saved = b; }, config: {} });
    await d.scan(LINE, "51999888777", async (b) => { saved = b; });
    expect(saved).not.toBeNull();

    const d2 = new SandboxDriver();
    const r = await d2.connect({ lineId: LINE, credentials: saved!, saveCredentials: async () => {}, config: {} });
    expect(r.status.state).toBe("connected");
  });

  it("escanear una línea que no espera enlace es conflicto", async () => {
    const { d } = await connected();
    await expect(d.scan(LINE, "51999888777")).rejects.toMatchObject({ status: 409 });
  });
});

describe("sandbox: mensajes entrantes fabricados", () => {
  it("un contacto inexistente dispara message.received como uno real", async () => {
    const { d, events } = await connected();
    await d.inbound(LINE, "51988777666", "hola, ¿hay stock?");

    const received = events.find((e) => e.event === "message.received");
    expect(received).toBeDefined();
    const data = received!.data as { key: { remoteJid: string; fromMe: boolean }; text: string };
    expect(data.key.remoteJid).toBe("51988777666@s.whatsapp.net");
    expect(data.key.fromMe).toBe(false);
    expect(data.text).toBe("hola, ¿hay stock?");
    expect(received!.orgId).toBe("org1");
  });

  it("en grupo marca el participante aparte del chat", async () => {
    const { d, events } = await connected();
    await d.inbound(LINE, "51988777666", "hola grupo", { chat: "12036304-1599@g.us" });
    const data = events.find((e) => e.event === "message.received")!.data as {
      key: { remoteJid: string; participant?: string };
    };
    // El chat es el grupo; el participante es QUIEN escribió. Confundirlos es el
    // fallo que hace que una respuesta automática conteste al grupo entero.
    expect(data.key.remoteJid).toBe("12036304-1599@g.us");
    expect(data.key.participant).toBe("51988777666@s.whatsapp.net");
  });

  it("no acepta entrantes en una línea sin conectar", async () => {
    const d = new SandboxDriver();
    await d.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });
    await expect(d.inbound(LINE, "51988777666", "x")).rejects.toMatchObject({ status: 409 });
  });
});

describe("sandbox: envío y acuses", () => {
  it("progresa sent → delivered → read y lo publica", async () => {
    const { d, events } = await connected();
    await d.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "c1", kind: "text", input: { to: "51988777666", text: "hola" },
    });
    const states = events.filter((e) => e.event === "message.receipt").map((e) => (e.data as { state: string }).state);
    expect(states).toEqual(["delivered", "read"]);
  });

  it("con autoAck apagado el test controla el acuse", async () => {
    const { d, events } = await connected({ autoAck: false });
    const r = await d.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "c1", kind: "text", input: { to: "51988777666", text: "hola" },
    });
    expect(events.filter((e) => e.event === "message.receipt")).toHaveLength(0);
    await d.ack(LINE, r.providerMessageId, "delivered");
    expect(events.filter((e) => e.event === "message.receipt")).toHaveLength(1);
  });

  it("el hilo guarda ambos sentidos", async () => {
    const { d } = await connected();
    await d.inbound(LINE, "51988777666", "pregunta");
    await d.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "c1", kind: "text", input: { to: "51988777666", text: "respuesta" },
    });
    const thread = d.thread(LINE, "51988777666");
    expect(thread.map((m) => m.fromMe)).toEqual([false, true]);
    expect(thread.map((m) => m.text)).toEqual(["pregunta", "respuesta"]);
  });
});

describe("sandbox: grupos", () => {
  let d: SandboxDriver;
  beforeEach(async () => { ({ d } = await connected()); });

  it("crea un grupo con el dueño como superadmin", async () => {
    const g = await d.createGroup(LINE, "Equipo", ["51988777666"]);
    expect(g.subject).toBe("Equipo");
    expect(g.participants[0]!.role).toBe("superadmin");
    expect(g.participants).toHaveLength(2);
  });

  it("informa por participante en vez de fallar entero", async () => {
    // WhatsApp real acepta unos y rechaza otros; la API debe decir cuál fue cuál.
    const g = await d.createGroup(LINE, "Equipo", ["51988777666"]);
    const res = await d.updateParticipants(
      LINE, g.address,
      [{ kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
       { kind: "pn", local: "51900000000", value: "51900000000@s.whatsapp.net" }],
      "add",
    );
    expect(res[0]).toMatchObject({ ok: false, reason: "ya es miembro" });
    expect(res[1]).toMatchObject({ ok: true });
  });

  it("pedir un grupo inexistente es 404", async () => {
    await expect(
      d.groupMetadata(LINE, { kind: "group", local: "x", value: "x@g.us" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
