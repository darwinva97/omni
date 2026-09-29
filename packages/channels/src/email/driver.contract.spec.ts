import { asLineId } from "@omni/shared";
import { runChannelContract } from "../contract/suite.js";
import { EmailDriver } from "./driver.js";
import { createFakeMail } from "./fake-mail.js";

/**
 * El correo corriendo la misma batería que WhatsApp y Telegram.
 *
 * Es el canal que menos se parece a los demás —sin presencia, sin acuses, sin
 * grupos— y aun así entra por el mismo puerto sin excepciones.
 */
runChannelContract("email (SMTP/IMAP falsos)", async () => {
  const mail = createFakeMail();
  const driver = new EmailDriver({
    makeSmtp: () => mail.smtp,
    makeImap: () => mail.imap,
    autoPoll: false,
  });
  const lineId = asLineId("linea-email");

  return {
    driver,
    lineId,
    // Al correo se le escribe a una dirección de correo, no a un teléfono.
    sampleTo: "ada@ejemplo.test",
    link: async () => {
      await driver.connect({
        lineId, credentials: null, saveCredentials: async () => {},
        config: { orgId: "org1", address: "soporte@ejemplo.test" },
      });
    },
  };
});
