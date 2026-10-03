import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversor, necesitaConversion } from "./index.js";

const ejecutar = promisify(execFile);
const FFMPEG = process.env["OMNI_FFMPEG"] ?? `${process.env["HOME"]}/.local/bin/ffmpeg`;

let hay = false;
const conversor = new Conversor({ ffmpegPath: FFMPEG });

beforeAll(async () => { hay = await conversor.disponible(); });

/** Fabrica un fichero de prueba con ffmpeg, para no meter binarios en el repo. */
async function fabricar(args: string[], nombre: string): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "omni-fix-"));
  const destino = join(dir, nombre);
  try {
    await ejecutar(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, destino]);
    return new Uint8Array(await readFile(destino));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("qué hace falta convertir", () => {
  it("un audio de navegador sí, uno ya en ogg no", () => {
    // Chrome graba `audio/webm;codecs=opus`: el flujo es bueno, el envoltorio no.
    expect(necesitaConversion("audio", "audio/webm;codecs=opus")).toBe(true);
    expect(necesitaConversion("audio", "audio/ogg")).toBe(false);
  });

  it("un vídeo webm sí, un mp4 no", () => {
    expect(necesitaConversion("video", "video/webm")).toBe(true);
    expect(necesitaConversion("video", "video/mp4")).toBe(false);
  });

  it("una imagen que no es webp sí, para un sticker", () => {
    expect(necesitaConversion("sticker", "image/png")).toBe(true);
    expect(necesitaConversion("sticker", "image/webp")).toBe(false);
  });

  it("del texto y de un documento no se convierte nada", () => {
    expect(necesitaConversion("text", "text/plain")).toBe(false);
    expect(necesitaConversion("document", "application/pdf")).toBe(false);
  });
});

describe("conversión con ffmpeg de verdad", () => {
  it("un audio webm/opus pasa a ogg SIN recodificar", async () => {
    if (!hay) return;
    const webm = await fabricar(
      ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-f", "webm"],
      "x.webm",
    );
    const r = await conversor.convertir("audio", webm, "audio/webm;codecs=opus");
    expect(r.mimeType).toBe("audio/ogg");

    // El contenedor es OGG de verdad: empieza por "OggS".
    expect(Buffer.from(r.bytes.slice(0, 4)).toString()).toBe("OggS");

    // Y el flujo sigue siendo Opus, no se ha recodificado.
    const dir = await mkdtemp(join(tmpdir(), "omni-chk-"));
    const f = join(dir, "y.ogg");
    await (await import("node:fs/promises")).writeFile(f, r.bytes);
    const { stdout } = await ejecutar(
      FFMPEG.replace(/ffmpeg$/, "ffprobe"),
      ["-hide_banner", "-loglevel", "error", "-show_entries", "stream=codec_name",
       "-of", "default=nw=1:nk=1", f],
    );
    expect(stdout.trim()).toBe("opus");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("un vídeo webm pasa a mp4 con H.264 y el índice delante", async () => {
    if (!hay) return;
    const webm = await fabricar(
      ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1",
       "-c:v", "libvpx", "-f", "webm"],
      "x.webm",
    );
    const r = await conversor.convertir("video", webm, "video/webm");
    expect(r.mimeType).toBe("video/mp4");
    // `ftyp` en los primeros bytes es la marca de un MP4 con faststart.
    expect(Buffer.from(r.bytes.slice(4, 8)).toString()).toBe("ftyp");
  }, 120_000);

  it("una imagen cualquiera pasa a sticker de 512×512", async () => {
    if (!hay) return;
    // Una imagen ANCHA a propósito: así se comprueba que se rellena en vez de
    // recortarse o estirarse.
    const png = await fabricar(
      ["-f", "lavfi", "-i", "testsrc=size=800x200:rate=1:duration=1", "-frames:v", "1"],
      "x.png",
    );
    const r = await conversor.convertir("sticker", png, "image/png");
    expect(r.mimeType).toBe("image/webp");
    expect(Buffer.from(r.bytes.slice(0, 4)).toString()).toBe("RIFF");
    expect(Buffer.from(r.bytes.slice(8, 12)).toString()).toBe("WEBP");

    const dir = await mkdtemp(join(tmpdir(), "omni-chk-"));
    const f = join(dir, "y.webp");
    await (await import("node:fs/promises")).writeFile(f, r.bytes);
    const { stdout } = await ejecutar(
      FFMPEG.replace(/ffmpeg$/, "ffprobe"),
      ["-hide_banner", "-loglevel", "error", "-show_entries", "stream=width,height",
       "-of", "csv=p=0", f],
    );
    expect(stdout.trim()).toBe("512,512");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("un fichero que no es un medio da 422, no un 500", async () => {
    if (!hay) return;
    const basura = new TextEncoder().encode("esto no es un vídeo");
    const err = await conversor.convertir("video", basura, "video/webm")
      .then(() => null).catch((e: { status: number; detail?: string }) => e);
    expect(err?.status).toBe(422);
  }, 60_000);

  it("dice si el binario no está, en vez de fallar al usarlo", async () => {
    const sin = new Conversor({ ffmpegPath: "/no/existe/ffmpeg" });
    expect(await sin.disponible()).toBe(false);
  });
});
