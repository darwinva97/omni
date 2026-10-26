import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "./local.js";

async function* trozos(...partes: string[]) {
  for (const p of partes) yield new TextEncoder().encode(p);
}

describe("guardar un medio por trozos", () => {
  it("queda igual que guardándolo entero (tamaño y huella), sin restos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-trozos-"));
    const s = new LocalStorage({ directory: dir, signingSecret: "x" });
    const a = await s.putStream("o/l/m1.bin", trozos("hola ", "mundo"), { mimeType: "text/plain" });
    const b = await s.put("o/l/m2.bin", new TextEncoder().encode("hola mundo"), { mimeType: "text/plain" });
    expect(a.size).toBe(10);
    expect(a.checksum).toBe(b.checksum);
    expect(await readFile(join(dir, "o/l/m1.bin"), "utf8")).toBe("hola mundo");
    expect((await readdir(join(dir, "o/l"))).filter((f) => f.includes(".part"))).toEqual([]);
  });

  it("si pasa del máximo, falla y no deja nada a medias", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-trozos-"));
    const s = new LocalStorage({ directory: dir, signingSecret: "x" });
    await expect(s.putStream("o/l/grande.bin", trozos("12345", "67890"), { mimeType: "x/y", max: 8 })).rejects.toThrow(
      /máximo/,
    );
    expect(await readdir(join(dir, "o/l"))).toEqual([]);
  });
});
