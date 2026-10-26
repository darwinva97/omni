import { describe, it, expect } from "vitest";
import { S3Storage } from "./s3.js";

// Firmar una URL es local: no hace falta un servidor S3 para estas pruebas.
const base = { bucket: "medios", region: "us-east-1", accessKeyId: "clave", secretAccessKey: "secreto-de-prueba" };

describe("almacén S3", () => {
  it("firma contra el endpoint cuando no hay uno público", async () => {
    const s = new S3Storage({ ...base, endpoint: "http://almacen.interno:9000" });
    const url = new URL(await s.signedUrl("media/a.jpg", 60));
    expect(url.origin).toBe("http://almacen.interno:9000");
    expect(url.pathname).toBe("/medios/media/a.jpg");
  });

  it("con endpoint público, la URL firmada sale con ese host y no con el interno", async () => {
    // Una URL firmada contra la dirección interna no la abre nadie de fuera, y
    // reescribir el host después rompe la firma: hay que firmar contra el público.
    const s = new S3Storage({
      ...base, endpoint: "http://almacen.interno:9000", publicEndpoint: "https://s3.ejemplo.com",
    });
    const url = new URL(await s.signedUrl("media/a.jpg", 60));
    expect(url.origin).toBe("https://s3.ejemplo.com");
    expect(url.pathname).toBe("/medios/media/a.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("con carpeta, todo va dentro de ella (el bucket se comparte con otras cosas)", async () => {
    const s = new S3Storage({ ...base, endpoint: "http://almacen.interno:9000", prefix: "/whatsapp/" });
    const url = new URL(await s.signedUrl("org/linea/m1", 60));
    expect(url.pathname).toBe("/medios/whatsapp/org/linea/m1");
  });
});
