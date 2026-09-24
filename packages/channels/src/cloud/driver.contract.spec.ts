import { asLineId } from "@omni/shared";
import { runChannelContract } from "../contract/suite.js";
import { CloudDriver } from "./driver.js";
import { createFakeMeta } from "./fake-meta.js";

/**
 * El driver oficial corriendo la MISMA batería que el sandbox y que Baileys,
 * con una Graph API falsa debajo. Es lo que impide que tres implementaciones
 * del mismo puerto diverjan sin que nadie se entere.
 */
runChannelContract("whatsapp cloud (Meta falso)", async () => {
  const meta = createFakeMeta();
  const driver = new CloudDriver({ fetchImpl: meta.fetchImpl });
  const lineId = asLineId("linea-cloud");

  return {
    driver,
    lineId,
    link: async () => {
      await driver.connect({
        lineId, credentials: null, saveCredentials: async () => {},
        config: {
          orgId: "org1", phoneNumberId: "123456", accessToken: "token-de-prueba",
          appSecret: "secreto-de-app",
        },
      });
    },
  };
});
