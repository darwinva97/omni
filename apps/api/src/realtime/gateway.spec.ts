import { describe, it, expect } from "vitest";
import { MemoryBus, MemoryKv } from "@omni/platform";
import type { EventEnvelope } from "@omni/shared";
import { RealtimeGateway, pasaSuscripcion, parseMensajeCliente, visibleFor, SUSCRIPCION_TODO } from "./gateway.js";
import { issueTicket, redeemTicket } from "./tickets.js";
import type { TicketPayload } from "./tickets.js";

const evento = (over: Partial<EventEnvelope> = {}): EventEnvelope => ({
  id: "e1", event: "message.received", orgId: "org1", lineId: "l1",
  timestamp: Date.now(),
  data: { key: { id: "m1", remoteJid: "51999000111@s.whatsapp.net", fromMe: false }, text: "hola" },
  ...over,
});

const billete = (over: Partial<TicketPayload> = {}): TicketPayload => ({
  orgId: "org1", kind: "api-key", apiKeyId: "k1",
  allowedLines: [], allowedChats: [], ...over,
});

describe("qué puede ver una conexión", () => {
  it("nunca eventos de otra organización", () => {
    expect(visibleFor(billete(), evento({ orgId: "otra" }))).toBe(false);
  });

  it("respeta el alcance por línea", () => {
    const b = billete({ allowedLines: ["l1"] });
    expect(visibleFor(b, evento({ lineId: "l1" }))).toBe(true);
    expect(visibleFor(b, evento({ lineId: "l2" }))).toBe(false);
  });

  it("respeta el alcance por chat", () => {
    const b = billete({ allowedChats: ["51999000111@s.whatsapp.net"] });
    expect(visibleFor(b, evento())).toBe(true);
    expect(visibleFor(b, evento({
      data: { key: { remoteJid: "51900000000@s.whatsapp.net" } },
    }))).toBe(false);
  });

  it("un evento sin chat identificable NO se entrega a una credencial acotada", () => {
    // El estado de la sesión no pertenece a ningún chat. En la duda, no se
    // enseña: es el mismo criterio que en el guard REST.
    const b = billete({ allowedChats: ["51999000111@s.whatsapp.net"] });
    expect(visibleFor(b, evento({ event: "session.connected", data: { state: "connected" } }))).toBe(false);
    // Sin acotar por chat, sí lo ve.
    expect(visibleFor(billete(), evento({ event: "session.connected", data: {} }))).toBe(true);
  });
});

describe("suscripción del cliente", () => {
  it("vacía significa todo", () => {
    expect(pasaSuscripcion(SUSCRIPCION_TODO, evento())).toBe(true);
  });

  it("filtra por patrón de evento y por línea", () => {
    expect(pasaSuscripcion({ events: ["message.*"], lines: [] }, evento())).toBe(true);
    expect(pasaSuscripcion({ events: ["session.*"], lines: [] }, evento())).toBe(false);
    expect(pasaSuscripcion({ events: [], lines: ["l2"] }, evento())).toBe(false);
  });

  it("solo acepta los mensajes que entiende", () => {
    expect(parseMensajeCliente('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(parseMensajeCliente('{"type":"subscribe","events":["message.*"]}')).toMatchObject({ type: "subscribe" });
    expect(parseMensajeCliente('{"type":"enviar","text":"hola"}')).toBeNull();
    expect(parseMensajeCliente("no es json")).toBeNull();
  });
});

describe("reparto", () => {
  const abrir = async () => {
    const bus = new MemoryBus();
    const gateway = new RealtimeGateway(bus);
    return { bus, gateway };
  };

  it("entrega a quien puede verlo y a nadie más", async () => {
    const { bus, gateway } = await abrir();
    const deA: string[] = [];
    const deB: string[] = [];
    await gateway.añadir("a", billete({ allowedLines: ["l1"] }), (t) => deA.push(t));
    await gateway.añadir("b", billete({ allowedLines: ["l2"] }), (t) => deB.push(t));

    await bus.publish("org:org1", evento({ lineId: "l1" }));
    expect(deA).toHaveLength(1);
    expect(deB).toHaveLength(0);
    expect(JSON.parse(deA[0]!)).toMatchObject({ type: "event", event: "message.received" });
  });

  it("una suscripción estrecha recibe menos", async () => {
    const { bus, gateway } = await abrir();
    const recibidos: string[] = [];
    await gateway.añadir("a", billete(), (t) => recibidos.push(t));
    gateway.suscribir("a", { events: ["session.*"], lines: [] });

    await bus.publish("org:org1", evento({ event: "message.received" }));
    expect(recibidos).toHaveLength(0);
    await bus.publish("org:org1", evento({ event: "session.connected", data: {} }));
    expect(recibidos).toHaveLength(1);
  });

  it("se suscribe UNA vez al bus por organización, no una por conexión", async () => {
    // Con doscientas pestañas abiertas, doscientas suscripciones a Postgres
    // serían doscientas conexiones LISTEN contra la base.
    const bus = new MemoryBus();
    let suscripciones = 0;
    const original = bus.subscribe.bind(bus);
    bus.subscribe = (async (t: string, h: never) => { suscripciones++; return original(t, h); }) as typeof bus.subscribe;

    const gateway = new RealtimeGateway(bus);
    for (const id of ["a", "b", "c"]) await gateway.añadir(id, billete(), () => {});
    expect(suscripciones).toBe(1);
    expect(gateway.conexionesAbiertas).toBe(3);
  });

  it("al cerrarse la última conexión se suelta la suscripción", async () => {
    const { gateway } = await abrir();
    await gateway.añadir("a", billete(), () => {});
    await gateway.añadir("b", billete(), () => {});
    await gateway.quitar("a");
    await gateway.quitar("b");
    expect(gateway.conexionesAbiertas).toBe(0);
  });

  it("una conexión rota no impide que el resto reciba", async () => {
    const { bus, gateway } = await abrir();
    const buenos: string[] = [];
    await gateway.añadir("rota", billete(), () => { throw new Error("socket cerrado"); });
    await gateway.añadir("buena", billete(), (t) => buenos.push(t));
    await bus.publish("org:org1", evento());
    expect(buenos).toHaveLength(1);
  });
});

describe("billetes", () => {
  it("se canjean una sola vez", async () => {
    // Capturarlo de un registro de acceso después ya no sirve de nada.
    const kv = new MemoryKv();
    const { ticket } = await issueTicket(kv, {
      kind: "api-key", apiKeyId: "k1", orgId: "org1",
      keyRole: "operator", allowedLines: ["l1"], allowedChats: [],
    });
    const payload = await redeemTicket(kv, ticket);
    expect(payload.allowedLines).toEqual(["l1"]);
    await expect(redeemTicket(kv, ticket)).rejects.toMatchObject({ status: 401 });
  });

  it("uno inventado no vale", async () => {
    await expect(redeemTicket(new MemoryKv(), "inventado")).rejects.toMatchObject({ status: 401 });
  });

  it("lleva el alcance de la credencial, no solo su identidad", async () => {
    const kv = new MemoryKv();
    const { ticket } = await issueTicket(kv, {
      kind: "api-key", apiKeyId: "k1", orgId: "org1", keyRole: "operator",
      allowedLines: [], allowedChats: ["51999000111@s.whatsapp.net"],
    });
    expect((await redeemTicket(kv, ticket)).allowedChats).toEqual(["51999000111@s.whatsapp.net"]);
  });
});
