/** Dónde vive la API. El panel nunca habla con WhatsApp: habla con Omni. */
export const API_URL = process.env["OMNI_API_URL"] ?? "http://127.0.0.1:4010";
export const SESSION_COOKIE = "omni_session";
/** La dirección pública, para enlaces que salen del panel (invitaciones). */
export const PUBLIC_URL = (process.env["OMNI_PUBLIC_URL"] ?? "http://127.0.0.1:4011").replace(/\/$/, "");
