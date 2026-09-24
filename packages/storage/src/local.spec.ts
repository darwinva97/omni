import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "./local.js";
import { mediaKey } from "./port.js";

let dir: string;
let now = 1_800_000_000_000;
const make = () => new LocalStorage(
  { directory: dir, signingSecret: "secreto-de-firma-largo" },
  { now: () => now },
);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omni-local-"));
  now = 1_800_000_000_000;
});

describe("almacén local", () => {
  it("no deja escapar una clave con ../ fuera del directorio", async () => {
    // Sin esta comprobación, una clave manipulada lee o pisa cualquier fichero.
    const s = make();
    await expect(
      s.put("../../../etc/atacado", new Uint8Array([1]), { mimeType: "text/plain" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(s.get("../../../etc/passwd")).rejects.toMatchObject({ status: 422 });
  });

  it("la firma caduca", async () => {
    const s = make();
    const url = await s.signedUrl("media/o/l/m.txt", 300);
    const params = new URL(url, "http://x").searchParams;
    const expires = Number(params.get("expires"));
    const sig = params.get("signature")!;

    expect(s.verify("media/o/l/m.txt", expires, sig)).toEqual({ ok: true });
    now += 301_000;
    expect(s.verify("media/o/l/m.txt", expires, sig)).toEqual({ ok: false, reason: "el enlace ha caducado" });
  });

  it("una firma de otra clave no sirve", async () => {
    const s = make();
    const url = await s.signedUrl("media/o/l/mia.txt", 300);
    const params = new URL(url, "http://x").searchParams;
    const res = s.verify("media/o/l/ajena.txt", Number(params.get("expires")), params.get("signature")!);
    expect(res.ok).toBe(false);
  });

  it("los objetos van a un directorio propio, no a uno servido estáticamente", async () => {
    const s = make();
    await s.put("media/org1/line1/m1.png", new Uint8Array([1, 2, 3]), { mimeType: "image/png" });
    expect(await readdir(dir)).toEqual(["media"]);
  });
});

describe("construcción de claves", () => {
  it("empieza por organización y línea, para que un prefijo delimite un inquilino", () => {
    const k = mediaKey({ orgId: "org1", lineId: "line1", messageId: "m1", fileName: "foto.PNG" });
    expect(k).toBe("media/org1/line1/m1.png");
  });

  it("neutraliza caracteres peligrosos en cada tramo", () => {
    const k = mediaKey({ orgId: "../org", lineId: "l/1", messageId: "m 1", fileName: "x.jpg" });
    expect(k).not.toContain("..");
    expect(k.split("/")).toHaveLength(4);
  });

  it("sin nombre de fichero no inventa extensión", () => {
    expect(mediaKey({ orgId: "o", lineId: "l", messageId: "m" })).toBe("media/o/l/m");
  });
});
