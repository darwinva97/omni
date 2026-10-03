export * from "./port.js";
export * from "./sandbox/driver.js";
export { runChannelContract, type DriverUnderTest } from "./contract/suite.js";
export { BaileysDriver, BAILEYS_DESCRIPTOR, ackToState, extractText, messageKind, type RegistroBaileys } from "./baileys/driver.js";
export { BlobAuthStore } from "./baileys/auth-store.js";
export { toBaileysContent } from "./baileys/content.js";
export { createFakeSocket, type FakeSocketControl } from "./baileys/fake-socket.js";
export { CloudDriver, CLOUD_DESCRIPTOR, cloudKind, cloudText, statusToState } from "./cloud/driver.js";
export { createFakeMeta, type FakeMeta } from "./cloud/fake-meta.js";
export type { CloudWebhookPayload, CloudInboundMessage, CloudStatus } from "./cloud/types.js";
export { WhatsappWebDriver, WEB_DESCRIPTOR, webKind, toWebContent } from "./web/driver.js";
export { ObjectStorageSessionStore } from "./web/session-store.js";
export { createFakeWebClient, type FakeWebControl } from "./web/fake-client.js";
export { TelegramDriver, TELEGRAM_DESCRIPTOR, telegramKind } from "./telegram/driver.js";
export { createFakeTelegram, type FakeTelegram } from "./telegram/fake-api.js";
export {
  EmailDriver, EMAIL_DESCRIPTOR, deterministicMessageId, asuntoDe,
  type SmtpTransport, type ImapClient, type ImapMessage, type EmailOptions,
} from "./email/driver.js";
export { createFakeMail, type FakeMail } from "./email/fake-mail.js";
