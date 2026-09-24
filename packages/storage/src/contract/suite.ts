import { describe, it, expect } from "vitest";
import type { Storage } from "../port.js";

/**
 * Contrato del almacén. Lo cumplen por igual el disco local y S3, para que
 * cambiar de uno a otro sea configuración y no una sorpresa en producción.
 */
export function runStorageContract(name: string, make: () => Promise<Storage>): void {
  describe(`contrato de almacén: ${name}`, () => {
    const bytes = new TextEncoder().encode("contenido de prueba");

    it("guarda y recupera los mismos bytes", async () => {
      const s = await make();
      const put = await s.put("media/o/l/m1.txt", bytes, { mimeType: "text/plain" });
      expect(put.size).toBe(bytes.byteLength);
      expect(put.checksum).toHaveLength(64);

      const got = await s.get("media/o/l/m1.txt");
      expect(got).not.toBeNull();
      expect(new TextDecoder().decode(got!.bytes)).toBe("contenido de prueba");
      expect(got!.mimeType).toBe("text/plain");
    });

    it("lo que no existe devuelve null en vez de lanzar", async () => {
      const s = await make();
      expect(await s.get("media/o/l/no-existe")).toBeNull();
      expect(await s.exists("media/o/l/no-existe")).toBe(false);
    });

    it("borra y el borrado es idempotente", async () => {
      const s = await make();
      await s.put("media/o/l/m2.txt", bytes, { mimeType: "text/plain" });
      expect(await s.exists("media/o/l/m2.txt")).toBe(true);
      await s.delete("media/o/l/m2.txt");
      expect(await s.exists("media/o/l/m2.txt")).toBe(false);
      await expect(s.delete("media/o/l/m2.txt")).resolves.not.toThrow();
    });

    it("la URL firmada lleva caducidad y no es una ruta desnuda", async () => {
      const s = await make();
      await s.put("media/o/l/m3.txt", bytes, { mimeType: "text/plain" });
      const url = await s.signedUrl("media/o/l/m3.txt", 300);
      expect(url).toMatch(/[?&](expires|X-Amz-Expires)=/i);
      expect(url).toMatch(/signature|X-Amz-Signature/i);
    });

    it("rechaza un objeto mayor que el máximo", async () => {
      const s = await make();
      const enorme = new Uint8Array(101 * 1024 * 1024);
      await expect(s.put("media/o/l/enorme", enorme, { mimeType: "application/octet-stream" }))
        .rejects.toMatchObject({ status: 422 });
    });
  });
}
