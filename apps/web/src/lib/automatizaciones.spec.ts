import { describe, it, expect } from "vitest";
import { describirRegla, problemasDe, type Regla } from "./automatizaciones";

const dic = {
  lineas: [{ id: "l1", name: "Ventas" }],
  listas: [{ id: "lst-1", name: "Facturas", lineId: "l1" }],
  miembros: [{ userId: "u1", name: "Ana" }],
};

const regla = (p: Partial<Regla> = {}): Regla => ({
  id: "r", name: "Facturas", trigger: "message.received",
  conditions: [{ field: "text", op: "contains", value: "factura" }],
  actions: [
    { type: "send_message", text: "te paso con administración", asReply: true },
    { type: "add_label", labelId: "lst-1" },
  ],
  priority: 100, enabled: false, lineId: "l1", ...p,
});

describe("una regla, en llano", () => {
  it("dice cuándo, con qué condiciones y qué hace", () => {
    const d = describirRegla(regla(), dic);
    expect(d.cuando).toBe("Cuando llegue un mensaje, si el mensaje contiene «factura»");
    expect(d.entonces).toBe("responder citando «te paso con administración» y poner el chat en la lista «Facturas»");
  });

  it("los días y las horas se leen como se dicen", () => {
    const d = describirRegla(regla({
      conditions: [
        { field: "hour", op: "gte", value: 9 },
        { field: "weekday", op: "in", value: ["6", "0"] },
      ],
      actions: [{ type: "assign", userId: "u1" }, { type: "stop" }],
    }), dic);
    expect(d.cuando).toBe("Cuando llegue un mensaje, si la hora es desde las 09:00 y el día es sábado o domingo");
    expect(d.entonces).toBe("asignarlo a Ana y no seguir con las reglas de después");
  });

  it("un disparador que existe pero nadie emite se dice, no se inventa", () => {
    expect(describirRegla(regla({ trigger: "label.added", conditions: [] }), dic).cuando)
      .toBe("Cuando se ponga un chat en una lista");
  });
});

describe("antes de guardar", () => {
  it("las listas piden una línea, porque son de una línea", () => {
    expect(problemasDe(regla({ lineId: null }))).toContain(
      "Las listas son de una línea: elige en qué línea actúa la regla para usarlas.");
  });

  it("sin acciones, sin nombre o con una expresión rota, no se guarda", () => {
    const p = problemasDe(regla({
      name: " ", actions: [{ type: "stop" }],
      conditions: [{ field: "text", op: "matches", value: "(" }],
    }));
    expect(p).toEqual(expect.arrayContaining([
      "Ponle un nombre a la regla.", "Añade al menos una cosa que hacer.",
      "La expresión regular no es válida.",
    ]));
  });

  it("con la línea cayéndose no hay a quién responder", () => {
    expect(problemasDe(regla({ trigger: "line.disconnected", conditions: [], lineId: null,
      actions: [{ type: "send_message", text: "hola" }] })))
      .toContain("Cuando cambia la línea no hay chat al que contestar: lo único que se puede hacer es avisar a una dirección web.");
    expect(problemasDe(regla({ trigger: "line.disconnected", conditions: [],
      actions: [{ type: "webhook", url: "https://avisos.test/linea" }] }))).toEqual([]);
  });

  it("una regla completa no tiene problemas", () => {
    expect(problemasDe(regla())).toEqual([]);
  });
});
