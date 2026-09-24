import { describe, it, expect } from "vitest";
import { MemoryJobQueue } from "@omni/platform";
import type { EventEnvelope } from "@omni/shared";
import { WebhookDispatcher, type DeliveryRecord, type WebhookEndpoint } from "./dispatcher.js";
import { verifySignature } from "./signature.js";

const SECRET = "wh-secret";
const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: "ep1", orgId: "o1", lineId: "l1", url: "https://receptor.test/hook",
  events: [], secret: SECRET, hmacEnabled: true, enabled: true,
  maxAttempts: 3, timeoutMs: 1000, filter: null, ...over,
});

const envelope = (event = "message.received"): EventEnvelope => ({
  id: "ev1", event: event as EventEnvelope["event"], orgId: "o1", lineId: "l1",
  timestamp: 1_800_000_000_000,
  data: { key: { id: "m1", remoteJid: "51999000111@s.whatsapp.net", fromMe: false }, kind: "text", text: "hola" },
});

interface Harness {
  queue: MemoryJobQueue;
  dispatcher: WebhookDispatcher;
  records: DeliveryRecord[];
  calls: { url: string; headers: Record<string, string>; body: string }[];
}

const FIXED_NOW = 1_800_000_000_000;

function harness(
  endpoints: WebhookEndpoint[],
  responder: (attempt: number) => Response | Promise<Response> | never,
): Harness {
  const queue = new MemoryJobQueue();
  const records: DeliveryRecord[] = [];
  const calls: Harness["calls"] = [];
  let attempt = 0;

  const dispatcher = new WebhookDispatcher(queue, {
    endpointsFor: async () => endpoints,
    recordDelivery: async (r) => void records.push(r),
    fetchImpl: (async (url: string, init: RequestInit) => {
      attempt++;
      calls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return responder(attempt);
    }) as unknown as typeof fetch,
    // Reloj fijo: la firma lleva marca de tiempo y el test la verifica igual
    // que lo haría el receptor.
    now: () => FIXED_NOW,
  });
  return { queue, dispatcher, records, calls };
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const ok = () => new Response("ok", { status: 200 });

describe("despacho de webhooks", () => {
  it("entrega y firma el cuerpo crudo de forma verificable", async () => {
    const h = harness([endpoint()], ok);
    const worker = h.dispatcher.startWorker();
    expect(await h.dispatcher.dispatch(envelope())).toBe(1);
    await settle();
    await worker.stop();

    expect(h.records.map((r) => r.status)).toEqual(["delivered"]);
    const call = h.calls[0]!;
    // El receptor debe poder verificar con el MISMO cuerpo que recibió.
    const sig = call.headers["x-omni-signature"]!;
    expect(verifySignature(call.body, sig, SECRET, { now: () => FIXED_NOW })).toEqual({ ok: true });
    expect(JSON.parse(call.body)).toMatchObject({ event: "message.received", lineId: "l1" });
  });

  it("reintenta ante un 500 y acaba entregando", async () => {
    const h = harness([endpoint({ backoffMs: 20 })], (n) =>
      n < 3 ? new Response("boom", { status: 500 }) : ok(),
    );
    const worker = h.dispatcher.startWorker();
    await h.dispatcher.dispatch(envelope());
    await settle(800);
    await worker.stop();
    expect(h.records.map((r) => r.status)).toEqual(["failed", "failed", "delivered"]);
  });

  it("agotar los intentos deja registro consultable, no un log perdido", async () => {
    const h = harness([endpoint({ maxAttempts: 2, backoffMs: 20 })], () => new Response("no", { status: 503 }));
    const worker = h.dispatcher.startWorker();
    await h.dispatcher.dispatch(envelope());
    await settle(800);
    await worker.stop();
    expect(h.records.at(-1)!.status).toBe("dead");
    expect(h.records.filter((r) => r.status === "failed")).toHaveLength(2);
  });

  it("un receptor caído no impide despachar: dispatch no hace red", async () => {
    // La diferencia con el gateway anterior: allí el `await fetch` estaba dentro
    // del bucle de ingesta y un receptor lento bloqueaba los mensajes.
    const h = harness([endpoint()], () => { throw new Error("ECONNREFUSED"); });
    const start = Date.now();
    await h.dispatcher.dispatch(envelope());
    expect(Date.now() - start).toBeLessThan(50);
    expect(await h.queue.depth("webhooks")).toBe(1);
    await h.queue.close();
  });

  it("respeta la suscripción a eventos y el filtro", async () => {
    const h = harness(
      [
        endpoint({ id: "solo-sesion", events: ["session.*"] }),
        endpoint({ id: "solo-grupos", filter: { isGroup: true } }),
        endpoint({ id: "todo" }),
      ],
      ok,
    );
    expect(await h.dispatcher.dispatch(envelope())).toBe(1);
    await h.queue.close();
  });

  it("no entrega a un endpoint de otra línea ni a uno apagado", async () => {
    const h = harness(
      [endpoint({ id: "otra", lineId: "l2" }), endpoint({ id: "apagado", enabled: false })],
      ok,
    );
    expect(await h.dispatcher.dispatch(envelope())).toBe(0);
    await h.queue.close();
  });

  it("el mismo evento no se encola dos veces para el mismo endpoint", async () => {
    const h = harness([endpoint()], ok);
    await h.dispatcher.dispatch(envelope());
    await h.dispatcher.dispatch(envelope());
    expect(await h.queue.depth("webhooks")).toBe(1);
    await h.queue.close();
  });
});
