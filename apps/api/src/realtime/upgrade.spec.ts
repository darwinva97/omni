import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { protegerUpgrades } from "./upgrade.js";

/**
 * Monta lo mismo que `main.ts`: Hono, el adaptador de WebSocket y una ruta que
 * tarda en canjear el billete y lo rechaza, como pasa con uno caducado.
 */
function servidor(proteger: boolean) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.get("/ws", upgradeWebSocket(async () => {
    await new Promise((r) => setTimeout(r, 50)); // el canje va a la base
    throw new Error("billete caducado");
  }));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const errores: string[] = [];
  if (proteger) protegerUpgrades(server, (e) => errores.push(String(e.code)));
  injectWebSocket(server);
  return { server, errores };
}

/** Un panel que pide el socket y se va antes de la respuesta. */
function clienteQueSeVa(puerto: number): Promise<void> {
  return new Promise((res) => {
    const s = net.connect(puerto, "127.0.0.1", () => {
      s.write(
        "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
      setTimeout(() => { s.resetAndDestroy(); res(); }, 10);
    });
    s.on("error", () => res());
  });
}

let cerrar: (() => void) | null = null;
afterEach(() => { cerrar?.(); cerrar = null; });

describe("apretón de manos del WebSocket", () => {
  it("un cliente que se va a medias no tumba el proceso", async () => {
    const { server, errores } = servidor(true);
    cerrar = () => server.close();
    await new Promise((r) => server.once("listening", r));
    const puerto = (server.address() as AddressInfo).port;

    // Sin la protección, el primero ya era una excepción no capturada: vitest
    // la marca como error del test aunque las aserciones pasen.
    await Promise.all(Array.from({ length: 10 }, () => clienteQueSeVa(puerto)));
    await new Promise((r) => setTimeout(r, 150));

    expect(errores.length).toBeGreaterThan(0);
    expect(errores.every((c) => c === "ECONNRESET" || c === "EPIPE")).toBe(true);

    // Y sigue atendiendo.
    const res = await fetch(`http://127.0.0.1:${puerto}/ws`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
