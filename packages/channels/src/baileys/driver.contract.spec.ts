import { asLineId } from "@omni/shared";
import { runChannelContract } from "../contract/suite.js";
import { BaileysDriver } from "./driver.js";
import { createFakeSocket } from "./fake-socket.js";

/**
 * El driver real de Baileys corriendo la MISMA batería que el sandbox, con un
 * socket falso debajo. Lo que se comprueba es el contrato del puerto, no el
 * protocolo de WhatsApp: eso necesita un número real.
 */
runChannelContract("baileys (socket falso)", async () => {
  const fake = createFakeSocket();
  const driver = new BaileysDriver({
    makeSocket: () => fake.socket,
    fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
    linkWaitMs: 0,
    reconnectBaseMs: 10,
  });
  const lineId = asLineId("linea-baileys");

  return {
    driver,
    lineId,
    link: async () => {
      await driver.connect({
        lineId, credentials: null, saveCredentials: async () => {}, config: { orgId: "org1" },
      });
      fake.emitConnection({ connection: "open" });
      await new Promise((r) => setTimeout(r, 20));
    },
  };
});
