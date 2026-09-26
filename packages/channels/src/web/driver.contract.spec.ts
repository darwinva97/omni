import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asLineId } from "@omni/shared";
import { LocalStorage } from "@omni/storage";
import { runChannelContract } from "../contract/suite.js";
import { WhatsappWebDriver } from "./driver.js";
import { createFakeWebClient } from "./fake-client.js";

/**
 * El tercer transporte corriendo la MISMA batería, con un cliente falso debajo.
 * Sin esto no se podría probar en CI: el real abre un Chromium.
 */
runChannelContract("whatsapp-web.js (cliente falso)", async () => {
  const almacen = new LocalStorage({
    directory: await mkdtemp(join(tmpdir(), "omni-wweb-")),
    signingSecret: "secreto-de-firma-de-pruebas",
  });
  const fake = createFakeWebClient();
  const driver = new WhatsappWebDriver({ storage: almacen, makeClient: () => fake.cliente });
  const lineId = asLineId("linea-web");

  return {
    driver,
    lineId,
    link: async () => {
      await driver.connect({
        lineId, credentials: null, saveCredentials: async () => {}, config: { orgId: "org1" },
      });
      fake.emitir("ready");
      await new Promise((r) => setTimeout(r, 20));
    },
  };
});
