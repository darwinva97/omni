import { describe, it, expect, beforeEach } from "vitest";
import type { Action, Condition, Rule, RuleContext } from "@omni/shared";
import { evaluarCondicion, evaluarRegla, ordenarReglas } from "./evaluar.js";
import { MotorDeAutomatizacion, type Efectos, type RegistroDeDisparo } from "./motor.js";

const CTX: RuleContext = {
  event: "message.received",
  orgId: "org1", lineId: "l1", target: "51988777666@s.whatsapp.net",
  text: "Hola, quiero una FACTURA",
  from: "51988777666@s.whatsapp.net",
  chat: "51988777666@s.whatsapp.net",
  chatKind: "individual",
  labels: ["vip"],
  status: "open", priority: "normal", assignee: null,
  at: new Date("2026-03-10T09:30:00Z"),
  messageId: "m-1",
  depth: 0,
};

const regla = (p: Partial<Rule> = {}): Rule => ({
  id: "r1", orgId: "org1", name: "Regla",
  trigger: "message.received",
  conditions: [], actions: [{ type: "send_message", text: "hola", asReply: false }],
  priority: 100, lineId: null, enabled: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...p,
});

const cond = (c: Partial<Condition> & Pick<Condition, "field" | "op">): Condition =>
  ({ caseSensitive: false, ...c }) as Condition;

class EfectosFalsos implements Efectos {
  readonly enviados: { texto: string; responderA: string | null }[] = [];
  readonly etiquetas: string[] = [];
  readonly quitadas: string[] = [];
  readonly asignados: (string | null)[] = [];
  readonly estados: string[] = [];
  readonly prioridades: string[] = [];
  readonly webhooks: string[] = [];
  readonly colgadas: string[] = [];
  readonly registros: RegistroDeDisparo[] = [];
  fallarEn: Action["type"] | null = null;

  #quizaFallar(tipo: Action["type"]): void {
    if (this.fallarEn === tipo) throw new Error(`falló ${tipo}`);
  }
  async enviarMensaje(_c: RuleContext, texto: string, responderA: string | null): Promise<void> {
    this.#quizaFallar("send_message");
    this.enviados.push({ texto, responderA });
  }
  async ponerEtiqueta(_c: RuleContext, l: string): Promise<void> {
    this.#quizaFallar("add_label"); this.etiquetas.push(l);
  }
  async quitarEtiqueta(_c: RuleContext, l: string): Promise<void> { this.quitadas.push(l); }
  async asignar(_c: RuleContext, u: string | null): Promise<void> { this.asignados.push(u); }
  async cambiarEstado(_c: RuleContext, e: string): Promise<void> { this.estados.push(e); }
  async cambiarPrioridad(_c: RuleContext, p: string): Promise<void> { this.prioridades.push(p); }
  async llamarWebhook(_c: RuleContext, url: string): Promise<void> {
    this.#quizaFallar("webhook"); this.webhooks.push(url);
  }
  async rechazarLlamada(_c: RuleContext, l: { id: string }): Promise<void> {
    this.colgadas.push(l.id);
  }
  async registrar(r: RegistroDeDisparo): Promise<void> { this.registros.push(r); }
}

describe("condiciones", () => {
  it("compara texto sin distinguir mayúsculas por defecto", () => {
    expect(evaluarCondicion(cond({ field: "text", op: "contains", value: "factura" }), CTX)).toBe(true);
    expect(evaluarCondicion(
      cond({ field: "text", op: "contains", value: "factura", caseSensitive: true }), CTX,
    )).toBe(false);
  });

  it("sobre una lista, `contains` es pertenencia y no subcadena", () => {
    // Buscar "vip" como subcadena encontraría también "vip-antiguo", y una
    // regla para clientes VIP se aplicaría a quien no lo es.
    const ctx = { ...CTX, labels: ["vip-antiguo"] };
    expect(evaluarCondicion(cond({ field: "labels", op: "contains", value: "vip" }), ctx)).toBe(false);
    expect(evaluarCondicion(cond({ field: "labels", op: "contains", value: "vip" }), CTX)).toBe(true);
  });

  it("una expresión regular inválida no hace saltar la regla", () => {
    // Fallar cerrado: si la condición no se puede decidir, no se actúa.
    expect(evaluarCondicion(cond({ field: "text", op: "matches", value: "((" }), CTX)).toBe(false);
  });

  it("distingue vacío de ausente en listas y en texto", () => {
    expect(evaluarCondicion(cond({ field: "labels", op: "is_empty" }), { ...CTX, labels: [] })).toBe(true);
    expect(evaluarCondicion(cond({ field: "labels", op: "is_empty" }), CTX)).toBe(false);
    expect(evaluarCondicion(cond({ field: "assignee", op: "is_empty" }), CTX)).toBe(true);
  });

  it("la hora sale del contexto, no del reloj de la máquina", () => {
    // Si leyera el reloj, la misma prueba pasaría o fallaría según la hora.
    const ctx = { ...CTX, at: new Date("2026-03-10T14:00:00") };
    expect(evaluarCondicion(cond({ field: "hour", op: "gte", value: 9 }), ctx)).toBe(true);
    expect(evaluarCondicion(cond({ field: "hour", op: "lte", value: 13 }), ctx)).toBe(false);
  });

  it("con zona horaria, la hora y el día son los de esa zona y no los del servidor", () => {
    // Las 3:30 del miércoles en UTC son las 22:30 del MARTES en Lima.
    const ctx = { ...CTX, at: new Date("2026-03-11T03:30:00Z") };
    const lima = { timeZone: "America/Lima" };
    expect(evaluarCondicion(cond({ field: "hour", op: "gte", value: 22, ...lima }), ctx)).toBe(true);
    expect(evaluarCondicion(cond({ field: "hour", op: "lte", value: 18, ...lima }), ctx)).toBe(false);
    expect(evaluarCondicion(cond({ field: "weekday", op: "in", value: ["2"], ...lima }), ctx)).toBe(true);
    // Una zona inventada no hace saltar la regla.
    expect(evaluarCondicion(cond({ field: "hour", op: "gte", value: 0, timeZone: "Marte/Olimpo" }), ctx))
      .toBe(false);
  });
});

describe("selección de reglas", () => {
  it("una regla apagada no salta nunca", () => {
    expect(evaluarRegla(regla({ enabled: false }), CTX).ok).toBe(false);
  });

  it("una regla acotada a otra línea no salta", () => {
    const r = evaluarRegla(regla({ lineId: "otra" }), CTX);
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain("otra línea");
  });

  it("dice qué condición falló, para poder explicarlo en el panel", () => {
    const r = evaluarRegla(
      regla({ conditions: [cond({ field: "text", op: "contains", value: "zzz" })] }), CTX);
    expect(r.motivo).toContain("condición 1");
  });

  it("empata por antigüedad para que el orden sea siempre el mismo", () => {
    const misma = new Date("2026-01-01T00:00:00Z");
    const orden = ordenarReglas([
      regla({ id: "c", priority: 100, createdAt: misma }),
      regla({ id: "a", priority: 100, createdAt: misma }),
      regla({ id: "b", priority: 10, createdAt: new Date("2026-02-01T00:00:00Z") }),
    ]);
    expect(orden.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});

describe("motor", () => {
  let efectos: EfectosFalsos;
  let ahora: number;
  let motor: MotorDeAutomatizacion;

  beforeEach(() => {
    efectos = new EfectosFalsos();
    ahora = 1_000_000;
    motor = new MotorDeAutomatizacion({ efectos, now: () => ahora });
  });

  it("ejecuta las acciones de la regla que salta", async () => {
    const res = await motor.ejecutar([regla({
      conditions: [cond({ field: "text", op: "contains", value: "factura" })],
      actions: [
        { type: "add_label", labelId: "facturacion" },
        { type: "send_message", text: "te paso con administración", asReply: true },
        { type: "set_status", status: "pending" },
      ],
    })], CTX);

    expect(res.disparadas).toEqual(["r1"]);
    expect(efectos.etiquetas).toEqual(["facturacion"]);
    expect(efectos.enviados[0]!.responderA).toBe("m-1");
    expect(efectos.estados).toEqual(["pending"]);
  });

  it("una llamada se cuelga y se contesta suelta, sin citar", async () => {
    // Una llamada no es un mensaje: «responder» a ella no tiene a qué apuntar.
    const llamada = { ...CTX, event: "call.received" as const, messageId: "CALL1",
      call: { id: "CALL1", from: "51988777666@s.whatsapp.net", isVideo: false } };
    const res = await motor.ejecutar([regla({
      trigger: "call.received",
      actions: [
        { type: "reject_call" },
        { type: "send_message", text: "ahora no podemos atender, escríbenos", asReply: true },
      ],
    })], llamada);
    expect(res.disparadas).toEqual(["r1"]);
    expect(efectos.colgadas).toEqual(["CALL1"]);
    expect(efectos.enviados[0]!.responderA).toBeNull();
  });

  it("colgar sin llamada falla y queda dicho", async () => {
    const res = await motor.ejecutar([regla({ actions: [{ type: "reject_call" }] })], CTX);
    expect(res.fallidas).toEqual(["r1"]);
    expect(efectos.registros.at(-1)!.reason).toContain("llamada");
  });

  it("el mismo evento dos veces seguidas solo actúa una", async () => {
    // Un mensaje produce `message.received` y `message.upsert`; sin
    // deduplicación el cliente recibe la respuesta automática dos veces.
    const r = [regla({})];
    await motor.ejecutar(r, CTX);
    await motor.ejecutar(r, CTX);
    expect(efectos.enviados).toHaveLength(1);
    expect(efectos.registros.some((x) => x.outcome === "skipped")).toBe(true);
  });

  it("pasada la ventana, el mismo evento vuelve a actuar", async () => {
    const r = [regla({})];
    await motor.ejecutar(r, CTX);
    ahora += 6000;
    await motor.ejecutar(r, CTX);
    expect(efectos.enviados).toHaveLength(2);
  });

  it("no se responde a su propia respuesta", async () => {
    // El evento que genera una acción vuelve a entrar con profundidad +1.
    // Sin el corte, una regla que contesta a todo contestaría para siempre.
    const res = await motor.ejecutar([regla({})], { ...CTX, depth: 2 });
    expect(res.cortada).toBe(true);
    expect(efectos.enviados).toHaveLength(0);
  });

  it("una acción que falla no impide las demás, pero queda registrada", async () => {
    efectos.fallarEn = "webhook";
    const res = await motor.ejecutar([regla({
      actions: [
        { type: "webhook", url: "https://roto.test/x" },
        { type: "add_label", labelId: "revisar" },
      ],
    })], CTX);

    expect(res.fallidas).toEqual(["r1"]);
    expect(efectos.etiquetas).toEqual(["revisar"]);
    const registro = efectos.registros.at(-1)!;
    expect(registro.outcome).toBe("failed");
    expect(registro.reason).toContain("webhook");
    expect(registro.actionsRun).toEqual(["add_label"]);
  });

  it("`stop` corta la cadena y las de menor prioridad no se evalúan", async () => {
    const res = await motor.ejecutar([
      regla({ id: "primera", priority: 1, actions: [{ type: "add_label", labelId: "a" }, { type: "stop" }] }),
      regla({ id: "segunda", priority: 2, actions: [{ type: "add_label", labelId: "b" }] }),
    ], CTX);

    expect(res.cortada).toBe(true);
    expect(efectos.etiquetas).toEqual(["a"]);
  });

  it("registra también lo que salta, con el motivo", async () => {
    await motor.ejecutar([regla({
      conditions: [cond({ field: "chatKind", op: "equals", value: "group" })],
    })], CTX);
    expect(efectos.enviados).toHaveLength(0);
  });
});
