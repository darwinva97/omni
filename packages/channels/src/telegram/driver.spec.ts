import { describe, it, expect, beforeEach } from "vitest";
import { asLineId, parseAddress, type EventEnvelope } from "@omni/shared";
import { TelegramDriver, telegramKind } from "./driver.js";
import { createFakeTelegram, type FakeTelegram } from "./fake-api.js";

const LINE = asLineId("l-tg");

async function conectado(): Promise<{ d: TelegramDriver; api: FakeTelegram; eventos: EventEnvelope[] }> {
  const api = createFakeTelegram();
  const d = new TelegramDriver({ fetchImpl: api.fetchImpl, autoPoll: false });
  const eventos: EventEnvelope[] = [];
  d.subscribe((e) => { eventos.push(e); });
  await d.connect({
    lineId: LINE, credentials: null, saveCredentials: async () => {},
    config: { orgId: "org1", botToken: "123:FALSO" },
  });
  return { d, api, eventos };
}

describe("driver de Telegram", () => {
  let d: TelegramDriver;
  let api: FakeTelegram;
  let eventos: EventEnvelope[];
  beforeEach(async () => { ({ d, api, eventos } = await conectado()); });

  it("se identifica con getMe y usa el id del bot como dirección propia", async () => {
    const estado = d.status(LINE);
    expect(estado.state).toBe("connected");
    if (estado.state !== "connected") return;
    expect(estado.self.value).toBe("777000@telegram");
    expect(estado.self.kind).toBe("telegram");
  });

  it("sin token no se conecta, y lo dice antes de intentar nada", async () => {
    const otro = new TelegramDriver({ fetchImpl: api.fetchImpl, autoPoll: false });
    await expect(otro.connect({
      lineId: asLineId("l2"), credentials: null, saveCredentials: async () => {}, config: {},
    })).rejects.toThrow(/botToken/);
  });

  it("un token rechazado es error de configuración, no caída del proveedor", async () => {
    // La diferencia importa: un 502 se reintenta eternamente, un 422 no.
    api.fallarCon = { error_code: 401, description: "Unauthorized" };
    const otro = new TelegramDriver({ fetchImpl: api.fetchImpl, autoPoll: false });
    const err = await otro.connect({
      lineId: asLineId("l3"), credentials: null, saveCredentials: async () => {},
      config: { botToken: "malo" },
    }).then(() => null).catch((e: { status: number }) => e);
    expect(err?.status).toBe(422);
  });

  it("elige sendVoice para una nota de voz y sendAudio para música", async () => {
    await d.send({
      lineId: LINE, to: parseAddress("55501@telegram"), clientMessageId: "a1",
      kind: "audio", input: { to: "55501@telegram", audio: { url: "https://x.test/a.ogg" }, ptt: true },
    });
    expect(api.llamadas.at(-1)?.metodo).toBe("sendVoice");

    await d.send({
      lineId: LINE, to: parseAddress("55501@telegram"), clientMessageId: "a2",
      kind: "audio", input: { to: "55501@telegram", audio: { url: "https://x.test/a.mp3" } },
    });
    expect(api.llamadas.at(-1)?.metodo).toBe("sendAudio");
  });

  it("los botones son un adorno del texto, no un tipo de mensaje", async () => {
    await d.send({
      lineId: LINE, to: parseAddress("55501@telegram"), clientMessageId: "b1",
      kind: "buttons",
      input: {
        to: "55501@telegram", bodyText: "¿Confirmas?",
        buttons: [{ id: "si", title: "Sí" }, { id: "no", title: "No" }],
      },
    });
    const ultima = api.llamadas.at(-1)!;
    expect(ultima.metodo).toBe("sendMessage");
    const markup = ultima.cuerpo["reply_markup"] as { inline_keyboard: { text: string }[][] };
    expect(markup.inline_keyboard).toHaveLength(2);
    expect(markup.inline_keyboard[0]![0]!.text).toBe("Sí");
  });

  it("un envío queda en `sent` y no avanza solo", async () => {
    // Telegram no da acuses a un bot. Avanzar a `delivered` sería inventarlo.
    const receipt = await d.send({
      lineId: LINE, to: parseAddress("55501@telegram"), clientMessageId: "s1",
      kind: "text", input: { to: "55501@telegram", text: "hola" },
    });
    expect(receipt.state).toBe("sent");
  });

  it("ingiere lo entrante y avanza el desplazamiento para no repetirlo", async () => {
    api.entrante(55501, "hola bot");
    const cuantos = await d.pollOnce(LINE);
    expect(cuantos).toBe(1);

    const recibido = eventos.find((e) => e.event === "message.received");
    expect(recibido).toBeDefined();
    const data = recibido!.data as { text: string; key: { remoteJid: string } };
    expect(data.text).toBe("hola bot");
    expect(data.key.remoteJid).toBe("55501@telegram");

    // La segunda vuelta pide a partir del siguiente, no desde el principio.
    await d.pollOnce(LINE);
    const ultima = api.llamadas.filter((l) => l.metodo === "getUpdates").at(-1)!;
    expect(Number(ultima.cuerpo["offset"])).toBeGreaterThan(0);
  });

  it("un chat de grupo llega marcado como tal, con su identificador negativo", async () => {
    api.entrante(55501, "en el grupo", { chat: -100123 });
    await d.pollOnce(LINE);
    const data = eventos.find((e) => e.event === "message.received")!.data as
      { key: { remoteJid: string }; isGroup?: boolean; from: string };
    expect(data.key.remoteJid).toBe("-100123@telegram");
    expect(data.isGroup).toBe(true);
    // Quién escribe no es el chat: en un grupo son distintos.
    expect(data.from).toBe("55501@telegram");
  });

  it("da el tamaño del grupo aunque no pueda enumerar a sus miembros", async () => {
    const meta = await d.groupMetadata(LINE, parseAddress("-100123@telegram"));
    expect(meta.subject).toBe("Grupo falso");
    expect(meta.size).toBe(42);
    // Vacío a propósito: Telegram solo enumera administradores, y una lista
    // parcial haciéndose pasar por completa es peor que ninguna.
    expect(meta.participants).toHaveLength(0);
  });

  it("clasifica lo entrante por su contenido", () => {
    expect(telegramKind({ message_id: 1, date: 0, chat: { id: 1 }, photo: [] })).toBe("image");
    expect(telegramKind({ message_id: 1, date: 0, chat: { id: 1 }, voice: {} })).toBe("audio");
    expect(telegramKind({ message_id: 1, date: 0, chat: { id: 1 }, text: "x" })).toBe("text");
    expect(telegramKind({ message_id: 1, date: 0, chat: { id: 1 } })).toBe("unknown");
  });
});
