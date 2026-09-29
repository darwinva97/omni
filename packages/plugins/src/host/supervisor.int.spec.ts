import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../manifest.js";
import { PluginSupervisor } from "./supervisor.js";
import type { PluginHostApi } from "./context.js";

/**
 * El supervisor con un plugin REAL en disco y un proceso REAL.
 *
 * Es la única forma de comprobar que el aislamiento existe: con un doble se
 * comprueba la lógica, no la frontera.
 */

const ARRANQUE = resolve(
  fileURLToPath(new URL("../../dist/plugin-host.mjs", import.meta.url)),
);

const supervisores: PluginSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisores.splice(0).map((s) => s.detener().catch(() => {})));
});

interface Registro { nivel: string; mensaje: string }

async function montar(
  codigo: string,
  manifiesto: Record<string, unknown> = {},
  api: Partial<PluginHostApi> = {},
): Promise<{ sup: PluginSupervisor; registros: Registro[]; fatales: string[]; llamadas: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "omni-plugin-"));
  await mkdir(join(dir, "dist"), { recursive: true });
  // El plugin trae su propio `package.json`: sin él Node sube por el árbol
  // buscándolo, y cada nivel sería una lectura más que habría que permitir.
  await writeFile(join(dir, "package.json"), '{"type":"module"}', "utf8");
  await writeFile(join(dir, "dist", "index.js"), codigo, "utf8");

  const registros: Registro[] = [];
  const fatales: string[] = [];
  const llamadas: string[] = [];

  const manifest = parseManifest(
    { id: "prueba", name: "Prueba", version: "1.0.0", main: "dist/index.js", ...manifiesto },
    "1.0.0",
  );

  const completo: PluginHostApi = {
    enviarMensaje: async (l, t, x) => { llamadas.push(`enviar:${l}:${t}:${x}`); return { messageId: "m1" }; },
    leerMensajes: async () => { llamadas.push("leer"); return [{ body: "hola" }]; },
    listarChats: async () => [{ address: "x@s.whatsapp.net" }],
    listarLineas: async () => [{ id: "l1" }],
    etiquetarChat: async () => { llamadas.push("etiquetar"); },
    kvGet: async (k) => { llamadas.push(`kvGet:${k}`); return null; },
    kvSet: async (k) => { llamadas.push(`kvSet:${k}`); },
    fetchImpl: (async () => new Response("ok", { status: 200 })) as typeof fetch,
    log: () => {},
    ...api,
  };

  const sup = new PluginSupervisor({
    manifest,
    directorio: dir,
    api: completo,
    leerConfig: () => ({ saludo: "hola" }),
    onLog: (nivel, mensaje) => registros.push({ nivel, mensaje }),
    onFatal: (e) => fatales.push(e),
    bootstrapPath: ARRANQUE,
    hookTimeoutMs: 1500,
  });
  supervisores.push(sup);
  return { sup, registros, fatales, llamadas };
}

const gancho = (event: string, data: unknown = {}) => ({
  event: event as never, lineId: "l1", orgId: "o1", timestamp: Date.now(), data,
});

describe("aislamiento del proceso de un plugin", () => {
  it("un plugin NO puede leer el disco fuera de su directorio", async () => {
    // Es la diferencia con un hilo de trabajo: Node avisa de que
    // `--allow-worker` invalida el modelo de permisos, así que un hilo separa
    // código pero no privilegios. Un proceso con `--permission` sí.
    const { sup, registros } = await montar(`
      import { readFileSync } from "node:fs";
      export default {
        onHook(ctx) {
          try {
            readFileSync("/etc/passwd");
            ctx.api.log("error", "LEYÓ /etc/passwd");
          } catch (e) {
            ctx.api.log("info", "bloqueado: " + e.code);
          }
        },
      };
    `, { hooks: ["message.received"] });

    await sup.iniciar();
    await sup.ejecutarGancho(gancho("message.received"));
    await new Promise((r) => setTimeout(r, 200));

    const dicho = registros.map((r) => r.mensaje).join(" ");
    expect(dicho, "el plugin leyó un fichero del sistema").not.toContain("LEYÓ");
    expect(dicho).toContain("ERR_ACCESS_DENIED");
  });

  it("un plugin NO puede lanzar otro proceso para escaparse", async () => {
    const { sup, registros } = await montar(`
      export default {
        async onHook(ctx) {
          try {
            const { execSync } = await import("node:child_process");
            execSync("cat /etc/passwd");
            ctx.api.log("error", "EJECUTÓ un proceso");
          } catch (e) {
            ctx.api.log("info", "bloqueado: " + (e.code ?? e.message).toString().slice(0, 40));
          }
        },
      };
    `, { hooks: ["message.received"] });

    await sup.iniciar();
    await sup.ejecutarGancho(gancho("message.received"));
    await new Promise((r) => setTimeout(r, 300));
    expect(registros.map((r) => r.mensaje).join(" ")).not.toContain("EJECUTÓ");
  });

  it("el entorno del plugin NO lleva los secretos del anfitrión", async () => {
    // El entorno del proceso principal tiene DATABASE_URL y la clave maestra.
    const { sup, registros } = await montar(`
      export default {
        onHook(ctx) {
          const claves = Object.keys(process.env).sort().join(",");
          ctx.api.log("info", "entorno: " + claves);
        },
      };
    `, { hooks: ["message.received"] });

    await sup.iniciar();
    await sup.ejecutarGancho(gancho("message.received"));
    await new Promise((r) => setTimeout(r, 200));

    const entorno = registros.find((r) => r.mensaje.includes("entorno:"))?.mensaje ?? "";
    expect(entorno).not.toContain("DATABASE_URL");
    expect(entorno).not.toContain("OMNI_MASTER_KEY");
    expect(entorno).toContain("OMNI_PLUGIN_ID");
  });
});

describe("capacidades en ejecución", () => {
  it("una capacidad declarada funciona", async () => {
    const { sup, llamadas } = await montar(`
      export default {
        async onHook(ctx) {
          await ctx.api.enviarMensaje("l1", "51999000111", "desde el plugin");
        },
      };
    `, { hooks: ["message.received"], permissions: ["messages:send"] });

    await sup.iniciar();
    await sup.ejecutarGancho(gancho("message.received"));
    await new Promise((r) => setTimeout(r, 200));
    expect(llamadas).toContain("enviar:l1:51999000111:desde el plugin");
  });

  it("una NO declarada falla al usarla, con su nombre", async () => {
    const { sup, registros, llamadas } = await montar(`
      export default {
        async onHook(ctx) {
          try { await ctx.api.enviarMensaje("l1", "x", "y"); }
          catch (e) { ctx.api.log("info", "denegado: " + e.message); }
        },
      };
    `, { hooks: ["message.received"], permissions: ["messages:read"] });

    await sup.iniciar();
    await sup.ejecutarGancho(gancho("message.received"));
    await new Promise((r) => setTimeout(r, 200));
    expect(llamadas).not.toContain("enviar:l1:x:y");
    expect(registros.map((r) => r.mensaje).join(" ")).toContain("messages:send");
  });

  it("el KV lleva prefijo por plugin: uno no pisa al otro", async () => {
    const { sup, llamadas } = await montar(`
      export default {
        async onHook(ctx) { await ctx.api.kvSet("estado", "activo"); },
      };
    `, { hooks: ["message.received"], permissions: ["kv:use"] });

    await sup.iniciar();
    await sup.ejecutarGancho(gancho("message.received"));
    await new Promise((r) => setTimeout(r, 200));
    expect(llamadas).toContain("kvSet:plugin:prueba:estado");
  });
});

describe("robustez del anfitrión", () => {
  it("un gancho que revienta NO detiene la cadena", async () => {
    const { sup, registros } = await montar(`
      export default { onHook() { throw new Error("me rompí"); } };
    `, { hooks: ["message.received"] });

    await sup.iniciar();
    const r = await sup.ejecutarGancho(gancho("message.received"));
    // Podría ser el plugin de otro inquilino: el resto no paga por este.
    expect(r.continuar).toBe(true);
    expect(registros.some((x) => x.mensaje.includes("me rompí"))).toBe(true);
  });

  it("un gancho COLGADO no frena la ingesta", async () => {
    const { sup } = await montar(`
      export default { onHook() { return new Promise(() => {}); } };
    `, { hooks: ["message.received"] });

    await sup.iniciar();
    const inicio = Date.now();
    const r = await sup.ejecutarGancho(gancho("message.received"));
    // Se rinde por tiempo y sigue: bloquear todo por uno lento sería peor.
    expect(r.continuar).toBe(true);
    expect(Date.now() - inicio).toBeLessThan(3000);
  });

  it("un plugin puede detener la cadena a propósito", async () => {
    const { sup } = await montar(`
      export default { onHook() { return { continue: false }; } };
    `, { hooks: ["message.received"] });
    await sup.iniciar();
    expect((await sup.ejecutarGancho(gancho("message.received"))).continuar).toBe(false);
  });

  it("solo recibe los ganchos que declaró", async () => {
    const { sup, llamadas } = await montar(`
      export default {
        async onHook(ctx, p) { await ctx.api.kvSet("visto", p.event); },
      };
    `, { hooks: ["message.received"], permissions: ["kv:use"] });

    await sup.iniciar();
    await sup.ejecutarGancho(gancho("session.connected"));
    await new Promise((r) => setTimeout(r, 200));
    expect(llamadas).toHaveLength(0);
  });

  it("la configuración se RELEE en cada gancho, no se congela", async () => {
    // OpenWA documenta que varios de sus plugins cachean `ctx.config` al
    // habilitar y no ven los cambios. Aquí es una propiedad de acceso.
    const dir = await mkdtemp(join(tmpdir(), "omni-plugin-cfg-"));
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), '{"type":"module"}', "utf8");
    await writeFile(join(dir, "dist", "index.js"), `
      export default {
        async onHook(ctx) { await ctx.api.kvSet("saludo", String(ctx.config.saludo)); },
      };
    `, "utf8");

    let config: Record<string, unknown> = { saludo: "primero" };
    const llamadas: string[] = [];
    const sup = new PluginSupervisor({
      manifest: parseManifest(
        { id: "cfg", name: "C", version: "1.0.0", main: "dist/index.js",
          hooks: ["message.received"], permissions: ["kv:use"] }, "1.0.0"),
      directorio: dir,
      api: {
        enviarMensaje: async () => ({ messageId: "" }), leerMensajes: async () => [],
        listarChats: async () => [], listarLineas: async () => [],
        etiquetarChat: async () => {},
        kvGet: async () => null,
        kvSet: async (k, v) => { llamadas.push(`${k}=${v}`); },
        fetchImpl: (async () => new Response("")) as typeof fetch, log: () => {},
      },
      leerConfig: () => config,
      bootstrapPath: ARRANQUE,
    });
    supervisores.push(sup);

    await sup.iniciar();
    await sup.ejecutarGancho(gancho("message.received"));
    config = { saludo: "cambiado" };
    await sup.ejecutarGancho(gancho("message.received"));
    await new Promise((r) => setTimeout(r, 300));

    expect(llamadas).toEqual([
      "plugin:cfg:saludo=primero",
      "plugin:cfg:saludo=cambiado",
    ]);
  });

  it("un plugin que no exporta nada se informa y no arranca", async () => {
    const { sup, fatales } = await montar(`export const algo = 1;`);
    await expect(sup.iniciar()).rejects.toThrow();
    expect(fatales.join(" ")).toContain("no exporta");
  });
});
