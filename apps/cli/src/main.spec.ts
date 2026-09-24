import { describe, it, expect } from "vitest";
import { COMMANDS, findCommand } from "./commands.js";
import { formatTable } from "./format.js";
import { parseArgs } from "./parse.js";
import { EXIT, help, run, usage } from "./main.js";

const captura = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

const fakeFetch = (respuesta: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(respuesta), {
    status, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

const ENV = { OMNI_API_KEY: "omni_abc123_secreto", OMNI_URL: "http://api.test" };

describe("lectura de argumentos", () => {
  it("separa posicionales de opciones", () => {
    const a = parseArgs(["linea1", "--limite", "10", "--json"]);
    expect(a.positional).toEqual(["linea1"]);
    expect(a.flags).toEqual({ limite: "10", json: true });
  });

  it("acepta la forma --clave=valor", () => {
    expect(parseArgs(["--ritmo=30"]).flags).toEqual({ ritmo: "30" });
  });

  it("una opción seguida de otra es una bandera, no toma su nombre", () => {
    expect(parseArgs(["--json", "--limite", "5"]).flags).toEqual({ json: true, limite: "5" });
  });
});

describe("salida en tabla", () => {
  it("alinea las columnas de una lista de objetos", () => {
    const t = formatTable([{ id: "a", estado: "ok" }, { id: "bbbb", estado: "no" }]);
    const lineas = t.split("\n");
    expect(lineas[0]).toContain("id");
    expect(lineas[1]).toMatch(/─/);
    expect(lineas).toHaveLength(4);
  });

  it("muestra un guion donde no hay valor, no 'undefined'", () => {
    expect(formatTable([{ a: null }])).toContain("—");
  });

  it("una lista vacía lo dice en vez de no imprimir nada", () => {
    expect(formatTable([])).toBe("(vacío)");
  });

  it("recorta una celda larga y dice cómo ver el dato entero", () => {
    // Cuarenta capacidades en una celda hacen ilegible la tabla completa.
    const capacidades = Array.from({ length: 40 }, (_, i) => `capacidad.numero${i}`);
    const t = formatTable([{ kind: "sandbox", capabilities: capacidades }]);
    expect(t).toContain("--json");
    expect(Math.max(...t.split("\n").map((l) => l.length))).toBeLessThan(120);
  });

  it("--json no recorta nada", () => {
    const capacidades = Array.from({ length: 40 }, (_, i) => `c${i}`);
    expect(JSON.stringify([{ capabilities: capacidades }])).toContain("c39");
  });
});

describe("ejecución", () => {
  it("sin comando enseña la ayuda y sale con 0", async () => {
    const c = captura();
    expect(await run([], { env: ENV, ...c.deps })).toBe(EXIT.ok);
    expect(c.out.join()).toContain("omni <comando>");
  });

  it("un comando desconocido sale con error de uso y sugiere la ayuda", async () => {
    const c = captura();
    expect(await run(["inventado"], { env: ENV, ...c.deps })).toBe(EXIT.uso);
    expect(c.err.join()).toContain("omni ayuda");
  });

  it("faltar un argumento enseña cómo se usa, no un error críptico", async () => {
    const c = captura();
    expect(await run(["enviar", "linea1"], { env: ENV, ...c.deps })).toBe(EXIT.uso);
    expect(c.err.join()).toContain("omni enviar <linea> <destino> <texto>");
  });

  it("sin credencial lo dice y usa su propio código de salida", async () => {
    const c = captura();
    expect(await run(["lineas"], { env: {}, ...c.deps })).toBe(EXIT.configuracion);
    expect(c.err.join()).toContain("OMNI_API_KEY");
  });

  it("un comando destructivo NO corre sin confirmación explícita", async () => {
    // Adivinar la intención en un borrado es exactamente lo que no debe hacer.
    const c = captura();
    let llamado = false;
    const code = await run(["linea:borrar", "l1"], {
      env: ENV, ...c.deps,
      fetchImpl: (async () => { llamado = true; return new Response("{}"); }) as unknown as typeof fetch,
    });
    expect(code).toBe(EXIT.uso);
    expect(llamado, "llegó a llamar a la API sin confirmación").toBe(false);
    expect(c.err.join()).toContain("--yes");
  });

  it("con --yes sí corre", async () => {
    const c = captura();
    const code = await run(["linea:borrar", "l1", "--yes"], {
      env: ENV, ...c.deps, fetchImpl: fakeFetch({ data: { ok: true } }),
    });
    expect(code).toBe(EXIT.ok);
  });

  it("--json imprime JSON encadenable", async () => {
    const c = captura();
    await run(["lineas", "--json"], {
      env: ENV, ...c.deps, fetchImpl: fakeFetch({ data: [{ id: "l1" }] }),
    });
    expect(JSON.parse(c.out.join("\n"))).toEqual([{ id: "l1" }]);
  });

  it("un error del servicio enseña el detalle del problema, no el código a secas", async () => {
    const c = captura();
    const code = await run(["lineas"], {
      env: ENV, ...c.deps,
      fetchImpl: fakeFetch({ status: 403, detail: "el chat está fuera del alcance de la clave" }, 403),
    });
    expect(code).toBe(EXIT.servicio);
    expect(c.err.join()).toContain("fuera del alcance");
  });

  it("--help de un comando explica sus argumentos y qué operación cubre", async () => {
    const c = captura();
    expect(await run(["enviar", "--help"], { env: ENV, ...c.deps })).toBe(EXIT.ok);
    expect(c.out.join()).toContain("POST /v1/lines/{lineId}/messages");
  });
});

describe("coherencia del catálogo de comandos", () => {
  it("ningún nombre se repite", () => {
    const nombres = COMMANDS.map((c) => c.name);
    expect(new Set(nombres).size).toBe(nombres.length);
  });

  it("cada comando declara qué operación cubre", () => {
    for (const c of COMMANDS) {
      expect(c.operation, c.name).toMatch(/^(GET|POST|PATCH|PUT|DELETE) \//);
      expect(c.summary.length, c.name).toBeGreaterThan(10);
    }
  });

  it("cada comando tiene ayuda utilizable", () => {
    for (const c of COMMANDS) {
      expect(usage(c)).toContain(c.operation);
      expect(help()).toContain(c.name);
    }
  });

  it("los comandos destructivos están marcados", () => {
    const borrados = COMMANDS.filter((c) => c.operation.startsWith("DELETE"));
    for (const c of borrados) {
      expect(c.destructive, `${c.name} borra y no está marcado como destructivo`).toBe(true);
    }
  });

  it("findCommand encuentra lo que hay y nada más", () => {
    expect(findCommand("enviar")?.name).toBe("enviar");
    expect(findCommand("no-existe")).toBeUndefined();
  });
});
