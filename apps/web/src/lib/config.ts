/** Dónde vive la API. El panel nunca habla con WhatsApp: habla con Omni. */
export const API_URL = process.env["OMNI_API_URL"] ?? "http://127.0.0.1:4010";
export const SESSION_COOKIE = "omni_session";
