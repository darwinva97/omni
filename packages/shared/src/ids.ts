/**
 * Identificadores con marca de tipo. Impiden pasar un `ChatId` donde se espera
 * un `LineId`: son `string` en tiempo de ejecución y distintos para el compilador.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrgId = Brand<string, "OrgId">;
export type UserId = Brand<string, "UserId">;
/** Una "línea" es una cuenta de cualquier canal, no solo un número de WhatsApp. */
export type LineId = Brand<string, "LineId">;
export type ChatId = Brand<string, "ChatId">;
export type MessageId = Brand<string, "MessageId">;
export type ConnectorId = Brand<string, "ConnectorId">;
export type ApiKeyId = Brand<string, "ApiKeyId">;

export const asOrgId = (v: string): OrgId => v as OrgId;
export const asUserId = (v: string): UserId => v as UserId;
export const asLineId = (v: string): LineId => v as LineId;
export const asChatId = (v: string): ChatId => v as ChatId;
export const asMessageId = (v: string): MessageId => v as MessageId;
export const asConnectorId = (v: string): ConnectorId => v as ConnectorId;
export const asApiKeyId = (v: string): ApiKeyId => v as ApiKeyId;
