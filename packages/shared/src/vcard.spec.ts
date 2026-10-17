import { describe, it, expect } from "vitest";
import { contactosDe, leerVCard } from "./vcard.js";

// Tal cual llega de WhatsApp al compartir a alguien desde un Android.
const DE_WHATSAPP = "BEGIN:VCARD\nVERSION:3.0\nN:;Takagi;;;\nFN:Takagi\n"
  + "TEL;type=CELL;type=VOICE;waid=51956745854:+51 956 745 854\nEND:VCARD";

// Lo que comparte un iPhone: etiquetas propias por grupo, y de todo.
const DE_IPHONE = [
  "BEGIN:VCARD", "VERSION:3.0",
  "N:Quintana;Daniel;José;Dr.;", "FN:Daniel Quintana",
  "NICKNAME:Dani",
  "ORG:Coliseo;Torneos", "TITLE:Capitán",
  "item1.TEL;waid=51903489903:+51 903 489 903", "item1.X-ABLabel:Coliseo",
  "TEL;type=WORK;type=VOICE:+51 1 234 5678",
  "item2.TEL:+34 600 000 000", "item2.X-ABLabel:_$!<Mobile>!$_",
  "EMAIL;type=INTERNET;type=HOME:dani@ejemplo.com",
  "item3.ADR;type=HOME:;;Av. Larco 123\\, piso 2;Miraflores;Lima;15074;Perú",
  "URL:https://coliseo.pe",
  "BDAY:1994-05-12",
  "NOTE:Juega los sábados\\npor la tarde",
  "X-WA-BIZ-NAME:Coliseo Gaming", "X-WA-BIZ-DESCRIPTION:Torneos de fútbol",
  "END:VCARD",
].join("\r\n");

describe("leer una tarjeta de contacto", () => {
  it("la de WhatsApp: nombre y número, con su WhatsApp", () => {
    const c = leerVCard(DE_WHATSAPP);
    expect(c.name).toBe("Takagi");
    expect(c.phones).toEqual([{ number: "+51 956 745 854", waId: "51956745854", label: "Móvil" }]);
    expect(c.emails).toEqual([]);
    expect(c.vcard).toBe(DE_WHATSAPP);
  });

  it("todo lo que trae una completa, con las etiquetas que le puso quien la guardó", () => {
    const c = leerVCard(DE_IPHONE);
    expect(c.name).toBe("Daniel Quintana");
    expect(c.nickname).toBe("Dani");
    expect(c.organization).toBe("Coliseo · Torneos");
    expect(c.title).toBe("Capitán");
    expect(c.phones).toEqual([
      { number: "+51 903 489 903", waId: "51903489903", label: "Coliseo" },
      // «Voz» no es una etiqueta: lo es casi cualquier número.
      { number: "+51 1 234 5678", waId: null, label: "Trabajo" },
      { number: "+34 600 000 000", waId: null, label: "Móvil" },
    ]);
    expect(c.emails).toEqual([{ address: "dani@ejemplo.com", label: "Casa" }]);
    expect(c.addresses).toEqual([
      { text: "Av. Larco 123, piso 2, Miraflores, Lima, 15074, Perú", label: "Casa" },
    ]);
    expect(c.urls).toEqual(["https://coliseo.pe"]);
    expect(c.birthday).toBe("1994-05-12");
    expect(c.note).toBe("Juega los sábados\npor la tarde");
    expect(c.business).toEqual({ name: "Coliseo Gaming", description: "Torneos de fútbol" });
  });

  it("sin FN, el nombre sale de N en el orden en que se dice", () => {
    expect(leerVCard("BEGIN:VCARD\nN:Quintana;Daniel;;Dr.;\nEND:VCARD").name)
      .toBe("Dr. Daniel Quintana");
  });

  it("sin ningún nombre, el que WhatsApp manda aparte", () => {
    expect(leerVCard("BEGIN:VCARD\nTEL:+51 1\nEND:VCARD", "Mamá").name).toBe("Mamá");
    expect(leerVCard("BEGIN:VCARD\nEND:VCARD").name).toBe("Sin nombre");
  });

  it("la 2.1 de Android: tipos sueltos, quoted-printable y líneas partidas", () => {
    const c = leerVCard([
      "BEGIN:VCARD", "VERSION:2.1",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Mar=C3=ADa Jos=C3=A9 Pe=",
      "=C3=B1a",
      "TEL;CELL;PREF:987654321",
      "NOTE:una nota muy",
      "  larga",
      "END:VCARD",
    ].join("\n"));
    expect(c.name).toBe("María José Peña");
    expect(c.phones).toEqual([{ number: "987654321", waId: null, label: "Móvil" }]);
    expect(c.note).toBe("una nota muy larga");
  });

  it("un cumpleaños sin año, y la foto incrustada", () => {
    const c = leerVCard("BEGIN:VCARD\nBDAY:--0512\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ\nEND:VCARD");
    expect(c.birthday).toBe("--05-12");
    expect(c.photo).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });
});

describe("los contactos de un mensaje guardado", () => {
  it("Baileys, uno: contactMessage", () => {
    const crudo = {
      key: { id: "A" }, kind: "contact", text: null,
      raw: { message: { contactMessage: { vcard: DE_WHATSAPP, displayName: "Takagi" } } },
    };
    expect(contactosDe(crudo).map((c) => c.name)).toEqual(["Takagi"]);
  });

  it("Baileys, varios: contactsArrayMessage, en orden", () => {
    const crudo = {
      raw: { message: { contactsArrayMessage: { displayName: "2 contactos", contacts: [
        { displayName: "Takagi", vcard: DE_WHATSAPP },
        { displayName: "Dani", vcard: DE_IPHONE },
      ] } } },
    };
    expect(contactosDe(crudo).map((c) => c.name)).toEqual(["Takagi", "Daniel Quintana"]);
  });

  it("whatsapp-web.js: la tarjeta en el cuerpo y en vCards cuenta una vez", () => {
    const crudo = { text: DE_WHATSAPP, raw: { body: DE_WHATSAPP, vCards: [DE_WHATSAPP] } };
    expect(contactosDe(crudo)).toHaveLength(1);
  });

  it("la API oficial: ya viene separado", () => {
    const crudo = { raw: { type: "contacts", contacts: [{
      name: { formatted_name: "Ana Ruiz", first_name: "Ana" },
      phones: [{ phone: "+51 999 888 777", wa_id: "51999888777", type: "CELL" }],
      emails: [{ email: "ana@ejemplo.com", type: "WORK" }],
      org: { company: "Coliseo", title: "Árbitra" },
      birthday: "1990-01-31",
    }] } };
    const [c] = contactosDe(crudo);
    expect(c).toMatchObject({
      name: "Ana Ruiz", organization: "Coliseo", title: "Árbitra", birthday: "1990-01-31",
      phones: [{ number: "+51 999 888 777", waId: "51999888777", label: "Móvil" }],
      emails: [{ address: "ana@ejemplo.com", label: "Trabajo" }],
    });
  });

  it("la tarjeta de lo que se CITA no es de este mensaje", () => {
    const crudo = { raw: { message: { extendedTextMessage: {
      text: "¿este es su número?",
      contextInfo: { quotedMessage: { contactMessage: { vcard: DE_WHATSAPP } } },
    } } } };
    expect(contactosDe(crudo)).toEqual([]);
  });

  it("sin nada que leer, ninguno", () => {
    expect(contactosDe(null)).toEqual([]);
    expect(contactosDe({ raw: { message: { conversation: "hola" } } })).toEqual([]);
  });
});
