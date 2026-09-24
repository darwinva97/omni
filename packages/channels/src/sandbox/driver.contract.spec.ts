import { asLineId } from "@omni/shared";
import { runChannelContract } from "../contract/suite.js";
import { SandboxDriver } from "./driver.js";

runChannelContract("sandbox", async () => {
  const driver = new SandboxDriver();
  const lineId = asLineId("linea-contrato");
  return {
    driver,
    lineId,
    link: async () => {
      await driver.connect({ lineId, credentials: null, saveCredentials: async () => {}, config: {} });
      await driver.scan(lineId, "51999888777");
    },
    cleanup: async () => driver.reset(),
  };
});
