import { describe, it, expect } from "vitest";
import { SendMessageInput, parseAddress, asLineId } from "@omni/shared";
import { toBaileysContent } from "./content.js";
import type { OutboundCommand } from "../port.js";

const cmd = (input: Record<string, unknown>, media?: OutboundCommand["media"]): OutboundCommand => ({
  lineId: asLineId("l1"),
  to: parseAddress("51999000111"),
  clientMessageId: "c1",
  kind: "text",
  input: SendMessageInput.parse({ to: "51999000111", ...input }),
  ...(media ? { media } : {}),
});

const bytes = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };

describe("traducción a contenido de Baileys", () => {
  it("texto, con y sin menciones", () => {
    expect(toBaileysContent(cmd({ text: "hola" }))).toEqual({ text: "hola" });
    const conMenciones = toBaileysContent(cmd({ text: "eh", mentions: ["51999000111"] }));
    expect(conMenciones).toMatchObject({ mentions: ["51999000111@s.whatsapp.net"] });
  });

  it("completa el sufijo de las menciones que llegan como número suelto", () => {
    const r = toBaileysContent(cmd({ text: "x", mentions: ["51999000111", "5199@s.whatsapp.net"] }));
    expect((r as { mentions: string[] }).mentions).toEqual([
      "51999000111@s.whatsapp.net", "5199@s.whatsapp.net",
    ]);
  });

  it("imagen con pie y vista única", () => {
    const r = toBaileysContent(cmd({ image: { url: "https://e.com/a.png" }, caption: "mira", viewOnce: true }, bytes));
    expect(r).toMatchObject({ caption: "mira", viewOnce: true });
  });

  it("distingue una nota de voz de un fichero de audio", () => {
    const nota = toBaileysContent(cmd({ audio: { url: "https://e.com/a.ogg" }, ptt: true }, { ...bytes, mimeType: "audio/ogg" }));
    expect(nota).toMatchObject({ ptt: true });
    const fichero = toBaileysContent(cmd({ audio: { url: "https://e.com/a.ogg" } }, { ...bytes, mimeType: "audio/ogg" }));
    expect(fichero).toMatchObject({ ptt: false });
  });

  it("un OGG va siempre como Opus (si no, WhatsApp no lo entrega)", () => {
    const r = toBaileysContent(cmd({ audio: { url: "https://e.com/a.ogg" }, ptt: true }, { ...bytes, mimeType: "audio/ogg" }));
    expect(r).toMatchObject({ mimetype: "audio/ogg; codecs=opus" });
    const mp3 = toBaileysContent(cmd({ audio: { url: "https://e.com/a.mp3" } }, { ...bytes, mimeType: "audio/mpeg" }));
    expect(mp3).toMatchObject({ mimetype: "audio/mpeg" });
  });

  it("documento con su nombre", () => {
    const r = toBaileysContent(cmd(
      { document: { url: "https://e.com/a.pdf" }, fileName: "factura.pdf" },
      { ...bytes, mimeType: "application/pdf" },
    ));
    expect(r).toMatchObject({ fileName: "factura.pdf", mimetype: "application/pdf" });
  });

  it("ubicación", () => {
    const r = toBaileysContent(cmd({ location: { latitude: -12.04, longitude: -77.04, name: "Lima" } }));
    expect(r).toMatchObject({ location: { degreesLatitude: -12.04, degreesLongitude: -77.04, name: "Lima" } });
  });

  it("tarjeta de contacto en vCard 3.0 con el waid", () => {
    const r = toBaileysContent(cmd({ contact: { fullName: "Ada Lovelace", phone: "+51 999 000 111" } }));
    const vcard = (r as { contacts: { contacts: { vcard: string }[] } }).contacts.contacts[0]!.vcard;
    expect(vcard).toContain("VERSION:3.0");
    expect(vcard).toContain("FN:Ada Lovelace");
    expect(vcard).toContain("waid=51999000111");
  });

  it("encuesta, y el número de opciones elegibles depende de si admite varias", () => {
    const una = toBaileysContent(cmd({ poll: { question: "¿?", options: ["a", "b", "c"] } }));
    expect(una).toMatchObject({ poll: { selectableCount: 1 } });
    const varias = toBaileysContent(cmd({ poll: { question: "¿?", options: ["a", "b", "c"], allowMultipleAnswers: true } }));
    expect(varias).toMatchObject({ poll: { selectableCount: 3 } });
  });

  it("botones y listas se rechazan diciendo POR QUÉ", () => {
    // El núcleo oficial no los envía de forma fiable. Mandar algo que no llega
    // sería peor que decirlo.
    expect(() => toBaileysContent(cmd({ buttons: [{ id: "1", title: "Sí" }] })))
      .toThrow(/fork de Baileys/);
  });

  it("un medio sin bytes resueltos falla en vez de enviar vacío", () => {
    expect(() => toBaileysContent(cmd({ image: { url: "https://e.com/a.png" } })))
      .toThrow(/falta el contenido del medio/);
  });
});
