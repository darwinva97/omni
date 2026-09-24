import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { OmniApiError, OmniClient, parseWebhook, verifyWebhook } from "./index.js";

const respuesta = (cuerpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

interface Espia {
  readonly llamadas: { url: string; method: string; body: unknown; headers: Record<string, string> }[];
  readonly fetchImpl: typeof fetch;
}

const espia = (responder: (n: number) => Response): Espia => {
  const llamadas: Espia["llamadas"] = [];
  let n = 0;
  return {
    llamadas,
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      llamadas.push({
        url: String(url), method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return responder(++n);
    }) as unknown as typeof fetch,
  };
};

const cliente = (e: Espia, maxRetries = 0) =>
  new OmniClient({ baseUrl: "https://api.test", apiKey: "omni_abc_secreto", fetchImpl: e.fetchImpl, maxRetries });

describe("cliente", () => {
  it("desenvuelve `data` para que quien integra no lo haga a mano", async () => {
    const e = espia(() => respuesta({ data: [{ id: "l1", name: "Línea" }] }));
    expect(await cliente(e).listLines()).toEqual([{ id: "l1", name: "Línea" }]);
  });

  it("manda la credencial y el tipo de contenido", async () => {
    const e = espia(() => respuesta({ data: { clientMessageId: "c1" } }));
    await cliente(e).send("l1", { to: "51988777666", text: "hola" });
    const l = e.llamadas[0]!;
    expect(l.headers["authorization"]).toBe("Bearer omni_abc_secreto");
    expect(l.headers["content-type"]).toBe("application/json");
    expect(l.body).toMatchObject({ to: "51988777666", text: "hola" });
  });

  it("escapa los identificadores en la ruta", async () => {
    // Una dirección lleva `@`: sin escapar, la ruta se parte donde no debe.
    const e = espia(() => respuesta({ data: [] }));
    await cliente(e).listMessages("l1", "51988777666@s.whatsapp.net");
    expect(e.llamadas[0]!.url).toContain("51988777666%40s.whatsapp.net");
  });

  it("un error trae el detalle desmenuzado, no 'HTTP 422'", async () => {
    const e = espia(() => respuesta({
      type: "https://docs.omni.dev/errors/capability_unsupported",
      title: "capability unsupported", status: 422,
      detail: 'el transporte "whatsapp.cloud" no soporta "send.poll"',
      capability: "send.poll",
    }, 422));

    const err = await cliente(e).send("l1", { to: "x", text: "y" })
      .then(() => null, (x: unknown) => x as OmniApiError);
    expect(err).toBeInstanceOf(OmniApiError);
    expect(err!.code).toBe("capability_unsupported");
    expect(err!.missingCapability).toBe("send.poll");
    expect(err!.message).toContain("send.poll");
  });

  it("reintenta lo pasajero y NO lo que no lo es", async () => {
    // Repetir un 403 no lo arregla y solo multiplica el ruido.
    const pasajero = espia((n) => (n < 3 ? respuesta({ detail: "ocupado" }, 503) : respuesta({ data: [] })));
    await cliente(pasajero, 3).listLines();
    expect(pasajero.llamadas).toHaveLength(3);

    const permanente = espia(() => respuesta({ detail: "prohibido", status: 403 }, 403));
    await cliente(permanente, 3).listLines().catch(() => {});
    expect(permanente.llamadas).toHaveLength(1);
  });

  it("consulta si un transporte sabe algo antes de intentarlo", async () => {
    const e = espia(() => respuesta({ data: [
      { kind: "whatsapp.cloud", capabilities: ["send.text"] },
      { kind: "whatsapp.baileys", capabilities: ["send.text", "send.poll"] },
    ] }));
    const c = cliente(e);
    expect(await c.supports("whatsapp.baileys", "send.poll")).toBe(true);
    expect(await c.supports("whatsapp.cloud", "send.poll")).toBe(false);
    expect(await c.supports("no.existe", "send.text")).toBe(false);
  });

  it("recorre el historial por páginas sin cargarlo entero", async () => {
    const pagina = (desde: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `m${desde + i}`, providerMessageId: null, fromMe: false,
        kind: "text", body: `mensaje ${desde + i}`, state: "delivered",
        timestamp: new Date(1_800_000_000_000 - (desde + i) * 1000).toISOString(),
      }));
    const e = espia((n) => respuesta({ data: n === 1 ? pagina(0, 100) : pagina(100, 30) }));

    const vistos: string[] = [];
    for await (const m of cliente(e).iterateMessages("l1", "chat@s.whatsapp.net")) {
      vistos.push(m.id);
    }
    expect(vistos).toHaveLength(130);
    // La segunda página pide lo anterior a la última marca de la primera.
    expect(e.llamadas[1]!.url).toContain("before=");
  });
});

describe("verificación de webhooks", () => {
  const secreto = "secreto-de-webhook";
  const cuerpo = JSON.stringify({ event: "message.received", lineId: "l1", data: { text: "hola" } });
  const ahora = 1_800_000_000_000;
  const firmar = (t: number, s = secreto, b = cuerpo): string =>
    `t=${t},v1=${createHmac("sha256", s).update(`${t}.${b}`).digest("hex")}`;

  it("acepta una firma válida y reciente", () => {
    const sig = firmar(Math.floor(ahora / 1000));
    expect(verifyWebhook(cuerpo, sig, secreto, { now: () => ahora })).toEqual({ ok: true });
  });

  it("rechaza otro secreto y otro cuerpo", () => {
    const t = Math.floor(ahora / 1000);
    expect(verifyWebhook(cuerpo, firmar(t, "otro"), secreto, { now: () => ahora }).ok).toBe(false);
    expect(verifyWebhook(cuerpo + " ", firmar(t), secreto, { now: () => ahora }).ok).toBe(false);
  });

  it("rechaza una entrega reproducida fuera de la ventana", () => {
    // La marca va dentro del hash justo para esto.
    const sig = firmar(Math.floor(ahora / 1000));
    const res = verifyWebhook(cuerpo, sig, secreto, { now: () => ahora + 10 * 60 * 1000 });
    expect(res).toEqual({ ok: false, reason: "marca de tiempo fuera de ventana" });
  });

  it("rechaza cabeceras ausentes o malformadas", () => {
    expect(verifyWebhook(cuerpo, undefined, secreto).ok).toBe(false);
    expect(verifyWebhook(cuerpo, "basura", secreto).ok).toBe(false);
    expect(verifyWebhook(cuerpo, "t=abc,v1=", secreto).ok).toBe(false);
  });

  it("parseWebhook verifica antes de parsear y da el evento tipado", () => {
    const sig = firmar(Math.floor(ahora / 1000));
    const ev = parseWebhook<{ text: string }>(cuerpo, sig, secreto, { now: () => ahora });
    expect(ev.event).toBe("message.received");
    expect(ev.data.text).toBe("hola");
    expect(() => parseWebhook(cuerpo, "mala", secreto)).toThrow(/webhook rechazado/);
  });
});
