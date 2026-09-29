import { asLineId } from "@omni/shared";
import { runChannelContract } from "../contract/suite.js";
import { TelegramDriver } from "./driver.js";
import { createFakeTelegram } from "./fake-api.js";

/**
 * El primer canal que no es WhatsApp corriendo la MISMA batería que los otros
 * cuatro. Si un canal de otra red entra sin tocar el contrato, el puerto vale
 * para lo que se diseñó; si hubiera que aflojarlo, no valdría.
 */
runChannelContract("telegram (API falsa)", async () => {
  const api = createFakeTelegram();
  const driver = new TelegramDriver({ fetchImpl: api.fetchImpl, autoPoll: false });
  const lineId = asLineId("linea-telegram");

  return {
    driver,
    lineId,
    link: async () => {
      await driver.connect({
        lineId, credentials: null, saveCredentials: async () => {},
        config: { orgId: "org1", botToken: "123456:FALSO" },
      });
    },
  };
});
