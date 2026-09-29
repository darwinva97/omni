/**
 * Arranque del proceso de un plugin.
 *
 * Corre con el modelo de permisos de Node activado: sin acceso al sistema de
 * ficheros más allá de su propio directorio, sin poder crear procesos ni hilos.
 * Node avisa de que `--allow-worker` invalidaría el modelo, así que no se usa.
 *
 * Todo lo que el plugin quiere hacer sale por la salida estándar y vuelve por
 * la entrada. No hay otra vía.
 */
import { LectorDeLineas, MensajeDelAnfitrion, serializar } from "./protocolo.js";
import type { HookPayload, Plugin, PluginContext, PluginHostApi } from "../host/context.js";

const enviar = (m: unknown): void => {
  process.stdout.write(serializar(m));
};

let plugin: Plugin | null = null;
let configVigente: Record<string, unknown> = {};
let siguienteLlamada = 1;
const pendientes = new Map<number, { resolver: (v: unknown) => void; rechazar: (e: Error) => void }>();

/** Cada método del API es una ida y vuelta por el canal. */
function llamar(metodo: string, ...args: unknown[]): Promise<unknown> {
  const id = siguienteLlamada++;
  return new Promise((resolver, rechazar) => {
    pendientes.set(id, { resolver, rechazar });
    enviar({ tipo: "llamada-api", id, metodo, args });
  });
}

const api = new Proxy({} as PluginHostApi, {
  get(_destino, propiedad: string) {
    if (propiedad === "log") {
      return (nivel: string, mensaje: string, datos?: unknown) =>
        enviar({ tipo: "registro", nivel, mensaje, datos });
    }
    if (propiedad === "fetchImpl") {
      return async (entrada: unknown, init?: unknown) => {
        const r = (await llamar("fetch", String(entrada), init)) as {
          status: number; body: string; headers: Record<string, string>;
        };
        return new Response(r.body, { status: r.status, headers: r.headers });
      };
    }
    return (...args: unknown[]) => llamar(propiedad, ...args);
  },
});

const contexto: PluginContext = {
  pluginId: process.env["OMNI_PLUGIN_ID"] ?? "",
  // Propiedad de acceso: el plugin no puede congelarla sin querer.
  get config(): Record<string, unknown> {
    return configVigente;
  },
  api,
};

const lector = new LectorDeLineas();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (trozo: string) => {
  for (const linea of lector.empujar(trozo)) void atender(linea);
});

async function atender(linea: string): Promise<void> {
  const leido = MensajeDelAnfitrion.safeParse(JSON.parse(linea));
  if (!leido.success) return;
  const m = leido.data;

  try {
    switch (m.tipo) {
      case "cargar": {
        configVigente = m.config;
        const ruta = process.env["OMNI_PLUGIN_MAIN"] ?? "";
        const modulo = (await import(ruta)) as { default?: Plugin };
        plugin = modulo.default ?? null;
        if (!plugin) throw new Error("el módulo no exporta un plugin por defecto");
        await plugin.onLoad?.(contexto);
        enviar({ tipo: "listo" });
        return;
      }
      case "configuracion": {
        const anterior = configVigente;
        configVigente = m.config;
        await plugin?.onConfigChange?.(contexto, m.config);
        void anterior;
        return;
      }
      case "gancho": {
        configVigente = m.config;
        try {
          const r = await plugin?.onHook?.(contexto, m.payload as HookPayload);
          enviar({ tipo: "gancho-hecho", id: m.id, continuar: r?.continue !== false });
        } catch (err) {
          enviar({ tipo: "gancho-falló", id: m.id, error: (err as Error).message });
        }
        return;
      }
      case "salud": {
        const r = (await plugin?.healthCheck?.(contexto)) ?? { ok: true };
        enviar({ tipo: "salud-hecha", id: m.id, ok: r.ok, detalle: r.detail });
        return;
      }
      case "respuesta-api": {
        const pendiente = pendientes.get(m.id);
        if (!pendiente) return;
        pendientes.delete(m.id);
        if (m.ok) pendiente.resolver(m.valor);
        else pendiente.rechazar(new Error(m.error ?? "la llamada falló"));
        return;
      }
      case "terminar": {
        await plugin?.onUnload?.(contexto);
        process.exit(0);
      }
    }
  } catch (err) {
    enviar({ tipo: "error-fatal", error: (err as Error).message });
    process.exit(1);
  }
}

// Un fallo sin capturar no puede dejar el proceso vivo y mudo: se informa y se
// sale, para que el anfitrión lo vea y decida.
process.on("uncaughtException", (err: Error) => {
  enviar({ tipo: "error-fatal", error: err.message });
  process.exit(1);
});
process.on("unhandledRejection", (razon: unknown) => {
  enviar({ tipo: "error-fatal", error: String(razon) });
  process.exit(1);
});
