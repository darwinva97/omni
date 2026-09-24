import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SendMessageInput } from "@omni/shared";
import { LocalStorage } from "./local.js";
import { assertFetchableUrl, mediaFieldOf, resolveMedia } from "./resolve.js";

let storage: LocalStorage;
const CTX = { orgId: "org1", lineId: "line1", messageId: "m1" };

beforeEach(async () => {
  storage = new LocalStorage({
    directory: await mkdtemp(join(tmpdir(), "omni-res-")),
    signingSecret: "secreto-de-firma-largo",
  });
});

const fakeFetch = (body: Uint8Array, headers: Record<string, string> = {}, status = 200) =>
  (async () => new Response(body, { status, headers: { "content-type": "image/png", ...headers } })) as unknown as typeof fetch;

describe("qué campo trae el medio", () => {
  it("reconoce cada tipo y no confunde el texto", () => {
    expect(mediaFieldOf(SendMessageInput.parse({ to: "x", text: "hola" }))).toBeNull();
    expect(mediaFieldOf(SendMessageInput.parse({ to: "x", image: { url: "https://e.com/a.png" } }))).toBe("image");
    expect(mediaFieldOf(SendMessageInput.parse({ to: "x", document: { url: "https://e.com/a.pdf" } }))).toBe("document");
  });
});

describe("protección contra SSRF al descargar", () => {
  it("acepta http y https públicos", () => {
    expect(assertFetchableUrl("https://ejemplo.com/a.png").hostname).toBe("ejemplo.com");
    expect(assertFetchableUrl("http://ejemplo.com/a.png").hostname).toBe("ejemplo.com");
  });

  it("rechaza destinos internos y metadatos de la nube", () => {
    // Sin esto, un cliente usa el servidor de puente hacia la red interna y
    // encima con nuestras credenciales de salida.
    for (const u of [
      "http://localhost/x", "http://127.0.0.1:5432/x", "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/x", "http://192.168.1.1/x", "http://172.16.0.1/x", "http://0.0.0.0/x",
      "http://algo.internal/x",
    ]) {
      expect(() => assertFetchableUrl(u), u).toThrow(/internas/);
    }
  });

  it("rechaza esquemas que no son http", () => {
    expect(() => assertFetchableUrl("file:///etc/passwd")).toThrow(/esquema/);
    expect(() => assertFetchableUrl("gopher://x/1")).toThrow(/esquema/);
    expect(() => assertFetchableUrl("no-es-una-url")).toThrow(/URL válida/);
  });
});

describe("resolución de medios", () => {
  it("descarga una URL, la guarda y devuelve su clave", async () => {
    const input = SendMessageInput.parse({ to: "x", image: { url: "https://ejemplo.com/foto.png" }, fileName: "foto.png" });
    const media = await resolveMedia(input, CTX, {
      storage, fetchImpl: fakeFetch(new Uint8Array([137, 80, 78, 71])),
    });
    expect(media!.storageKey).toBe("media/org1/line1/m1.png");
    expect(media!.mimeType).toBe("image/png");
    expect(media!.size).toBe(4);
    // Queda guardado ANTES de encolar: el envío ya no depende de que el
    // servidor ajeno siga en pie dentro de un minuto.
    expect(await storage.exists(media!.storageKey)).toBe(true);
  });

  it("acepta bytes en base64", async () => {
    const input = SendMessageInput.parse({
      to: "x", audio: { base64: Buffer.from("audio falso").toString("base64"), mimeType: "audio/ogg" },
    });
    const media = await resolveMedia(input, CTX, { storage });
    expect(media!.mimeType).toBe("audio/ogg");
    expect(new TextDecoder().decode(media!.bytes)).toBe("audio falso");
  });

  it("reutiliza un objeto ya subido sin volver a copiarlo", async () => {
    await storage.put("media/org1/line1/previo.png", new Uint8Array([1, 2]), { mimeType: "image/png" });
    const input = SendMessageInput.parse({ to: "x", image: { storageKey: "media/org1/line1/previo.png" } });
    const media = await resolveMedia(input, CTX, { storage });
    expect(media!.storageKey).toBe("media/org1/line1/previo.png");
    expect(media!.size).toBe(2);
  });

  it("una clave inexistente es 404, no un envío vacío", async () => {
    const input = SendMessageInput.parse({ to: "x", image: { storageKey: "media/no/existe" } });
    await expect(resolveMedia(input, CTX, { storage })).rejects.toMatchObject({ status: 404 });
  });

  it("un origen que responde mal se informa como fallo aguas arriba", async () => {
    const input = SendMessageInput.parse({ to: "x", image: { url: "https://ejemplo.com/roto.png" } });
    await expect(
      resolveMedia(input, CTX, { storage, fetchImpl: fakeFetch(new Uint8Array(), {}, 503) }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("rechaza por tamaño antes de volcarlo en memoria si el origen lo declara", async () => {
    const input = SendMessageInput.parse({ to: "x", video: { url: "https://ejemplo.com/enorme.mp4" } });
    await expect(
      resolveMedia(input, CTX, {
        storage,
        fetchImpl: fakeFetch(new Uint8Array([1]), { "content-length": String(200 * 1024 * 1024) }),
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("un mensaje de texto no resuelve ningún medio", async () => {
    const input = SendMessageInput.parse({ to: "x", text: "hola" });
    expect(await resolveMedia(input, CTX, { storage })).toBeNull();
  });
});
