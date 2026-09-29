import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OmniError } from "@omni/shared";
import type { Manifest } from "../manifest.js";
import { LectorDeLineas, MensajeDelPlugin, serializar } from "../runtime/protocolo.js";
import { checkUrl, requireCapability } from "./capabilities.js";
import type { HookPayload, PluginHostApi } from "./context.js";

/**
 * Supervisor de un plugin.
 *
 * Lo corre en un PROCESO APARTE con el modelo de permisos de Node activado, no
 * en un hilo. Node avisa explícitamente de que `--allow-worker` invalida el
 * modelo de permisos, así que un hilo no es una frontera: es una separación de
 * código, no de privilegios. Un proceso con `--permission` sí lo es, y el coste
 * —unos megas y un arranque— se paga una vez por plugin, no por mensaje.
 *
 * Es la diferencia con el diseño de OpenWA, cuya propia documentación dice que
 * su aislamiento es parcial porque «el worker sigue teniendo APIs de Node».
 */

/**
 * El arranque empaquetado vive junto al código compilado del paquete.
 *
 * Se buscan dos sitios porque en las pruebas este fichero se carga desde
 * `src/` con un alias, y desde ahí el hermano `dist/` es el que tiene el
 * paquete. Buscar mal aquí da un fallo de arranque sin causa aparente.
 */
const RUTA_ARRANQUE = ((): string => {
  const aqui = dirname(fileURLToPath(import.meta.url));
  const candidatos = [
    resolve(aqui, "..", "plugin-host.mjs"),
    resolve(aqui, "..", "..", "dist", "plugin-host.mjs"),
  ];
  return candidatos.find((c) => existsSync(c)) ?? candidatos[0]!;
})();

export interface SupervisorOptions {
  readonly manifest: Manifest;
  /** Directorio del plugin. Es lo ÚNICO que podrá leer. */
  readonly directorio: string;
  readonly api: PluginHostApi;
  readonly leerConfig: () => Record<string, unknown>;
  readonly onLog?: (nivel: string, mensaje: string, datos?: unknown) => void;
  readonly onFatal?: (error: string) => void;
  /** Tiempo máximo de un gancho. Uno colgado no puede frenar la ingesta. */
  readonly hookTimeoutMs?: number;
  readonly spawnImpl?: typeof spawn;
  readonly bootstrapPath?: string;
}

interface Pendiente {
  resolver: (v: { continuar: boolean }) => void;
  rechazar: (e: Error) => void;
  temporizador: NodeJS.Timeout;
}

export type EstadoPlugin = "parado" | "arrancando" | "listo" | "fallido";

export class PluginSupervisor {
  readonly manifest: Manifest;
  #proceso: ChildProcess | null = null;
  #estado: EstadoPlugin = "parado";
  #siguienteId = 1;
  readonly #pendientes = new Map<number, Pendiente>();
  readonly #saludes = new Map<number, (r: { ok: boolean; detalle?: string }) => void>();
  readonly #opts: SupervisorOptions;
  readonly #lector = new LectorDeLineas();
  #resolverListo: (() => void) | null = null;

  constructor(opts: SupervisorOptions) {
    this.#opts = opts;
    this.manifest = opts.manifest;
  }

  get estado(): EstadoPlugin {
    return this.#estado;
  }

  async iniciar(): Promise<void> {
    if (this.#proceso) return;
    this.#estado = "arrancando";

    const directorio = resolve(this.#opts.directorio);
    /*
     * El arranque es un fichero EMPAQUETADO, sin imports relativos.
     *
     * Con módulos sueltos, Node tiene que leer los `package.json` del árbol
     * para resolver cada uno, y cada lectura hay que permitirla: al final se
     * abre medio repositorio al plugin. Un solo fichero autónomo deja la lista
     * de lectura en dos rutas —él mismo y el directorio del plugin— y eso sí es
     * una frontera que se puede razonar.
     */
    const bootstrap = this.#opts.bootstrapPath ?? RUTA_ARRANQUE;

    /*
     * Los permisos son la frontera, y son mínimos a propósito:
     *
     * - lectura limitada al directorio del plugin y al arranque; nada más del
     *   disco existe para él.
     * - sin escritura: un plugin que necesite guardar algo usa `storage:use` o
     *   `kv:use`, que pasan por el anfitrión y quedan registrados.
     * - sin `--allow-child-process` ni `--allow-worker`: no puede escaparse
     *   creando otro proceso, y Node avisa de que el segundo invalidaría todo.
     */
    const argumentos = [
      "--permission",
      `--allow-fs-read=${directorio}`,
      `--allow-fs-read=${bootstrap}`,
      bootstrap,
    ];

    const lanzar = this.#opts.spawnImpl ?? spawn;
    const hijo = lanzar(process.execPath, argumentos, {
      cwd: directorio,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        // Entorno DESNUDO: el del anfitrión lleva credenciales de base de
        // datos y claves maestras, y un plugin no tiene por qué verlas.
        PATH: "/usr/bin:/bin",
        OMNI_PLUGIN_ID: this.manifest.id,
        OMNI_PLUGIN_MAIN: resolve(directorio, this.manifest.main),
      },
    });
    this.#proceso = hijo;

    hijo.stdout?.setEncoding("utf8");
    hijo.stdout?.on("data", (trozo: string) => {
      for (const linea of this.#lector.empujar(trozo)) this.#atender(linea);
    });
    hijo.stderr?.setEncoding("utf8");
    hijo.stderr?.on("data", (trozo: string) => {
      // Lo que el plugin escriba en stderr es suyo, pero se etiqueta: si no,
      // aparece en los registros del anfitrión como si fuera nuestro.
      this.#opts.onLog?.("warn", `[${this.manifest.id}] ${String(trozo).trimEnd()}`);
    });
    hijo.on("exit", (codigo) => {
      this.#proceso = null;
      if (this.#estado !== "parado") {
        this.#estado = "fallido";
        this.#opts.onFatal?.(`el proceso terminó con código ${String(codigo)}`);
      }
      for (const p of this.#pendientes.values()) {
        clearTimeout(p.temporizador);
        p.rechazar(new Error("el plugin terminó mientras atendía un gancho"));
      }
      this.#pendientes.clear();
    });

    const listo = new Promise<void>((res) => { this.#resolverListo = res; });
    this.#enviar({ tipo: "cargar", config: this.#opts.leerConfig() });

    const limite = new Promise<never>((_, rechazar) =>
      setTimeout(() => rechazar(new OmniError("upstream_failed", `el plugin "${this.manifest.id}" no arrancó a tiempo`)), 10000),
    );
    await Promise.race([listo, limite]);
    this.#estado = "listo";
  }

  async detener(): Promise<void> {
    this.#estado = "parado";
    if (!this.#proceso) return;
    this.#enviar({ tipo: "terminar" });
    const proceso = this.#proceso;
    await new Promise<void>((res) => {
      const plazo = setTimeout(() => {
        // Un plugin que no se va por las buenas se va por las malas: si no, un
        // `onUnload` colgado deja el proceso vivo para siempre.
        proceso.kill("SIGKILL");
        res();
      }, 3000);
      proceso.once("exit", () => { clearTimeout(plazo); res(); });
    });
    this.#proceso = null;
  }

  /** Ejecuta un gancho. Devuelve si la cadena debe continuar. */
  async ejecutarGancho(payload: HookPayload): Promise<{ continuar: boolean }> {
    if (this.#estado !== "listo") return { continuar: true };
    if (!this.manifest.hooks.includes(payload.event as never)) return { continuar: true };

    const id = this.#siguienteId++;
    return new Promise((resolver, rechazar) => {
      const temporizador = setTimeout(() => {
        this.#pendientes.delete(id);
        // Un gancho colgado NO detiene la cadena: el resto de plugins y la
        // ingesta siguen. Bloquear todo por uno lento sería peor que el fallo.
        resolver({ continuar: true });
        this.#opts.onLog?.("warn", `[${this.manifest.id}] el gancho tardó demasiado y se ignoró`);
      }, this.#opts.hookTimeoutMs ?? 5000);

      this.#pendientes.set(id, { resolver, rechazar, temporizador });
      this.#enviar({ tipo: "gancho", id, payload, config: this.#opts.leerConfig() });
    });
  }

  async comprobarSalud(): Promise<{ ok: boolean; detalle?: string }> {
    if (this.#estado !== "listo") return { ok: false, detalle: `estado: ${this.#estado}` };
    const id = this.#siguienteId++;
    return new Promise((resolver) => {
      const plazo = setTimeout(() => {
        this.#saludes.delete(id);
        resolver({ ok: false, detalle: "no respondió a tiempo" });
      }, 3000);
      this.#saludes.set(id, (r) => { clearTimeout(plazo); resolver(r); });
      this.#enviar({ tipo: "salud", id });
    });
  }

  notificarConfig(config: Record<string, unknown>): void {
    this.#enviar({ tipo: "configuracion", config });
  }

  #enviar(m: unknown): void {
    this.#proceso?.stdin?.write(serializar(m));
  }

  #atender(linea: string): void {
    let leido;
    try {
      leido = MensajeDelPlugin.safeParse(JSON.parse(linea));
    } catch {
      return;
    }
    if (!leido.success) return;
    const m = leido.data;

    switch (m.tipo) {
      case "listo":
        this.#resolverListo?.();
        return;
      case "gancho-hecho": {
        const p = this.#pendientes.get(m.id);
        if (!p) return;
        clearTimeout(p.temporizador);
        this.#pendientes.delete(m.id);
        p.resolver({ continuar: m.continuar });
        return;
      }
      case "gancho-falló": {
        const p = this.#pendientes.get(m.id);
        if (!p) return;
        clearTimeout(p.temporizador);
        this.#pendientes.delete(m.id);
        this.#opts.onLog?.("error", `[${this.manifest.id}] el gancho falló: ${m.error}`);
        // Un gancho que revienta no detiene la cadena. Podría ser de otro
        // inquilino y no tiene por qué pagar por este.
        p.resolver({ continuar: true });
        return;
      }
      case "salud-hecha":
        this.#saludes.get(m.id)?.({ ok: m.ok, ...(m.detalle ? { detalle: m.detalle } : {}) });
        this.#saludes.delete(m.id);
        return;
      case "registro":
        this.#opts.onLog?.(m.nivel, `[${this.manifest.id}] ${m.mensaje}`, m.datos);
        return;
      case "error-fatal":
        this.#estado = "fallido";
        this.#opts.onFatal?.(m.error);
        return;
      case "llamada-api":
        void this.#atenderLlamada(m.id, m.metodo, m.args);
        return;
    }
  }

  async #atenderLlamada(id: number, metodo: string, args: unknown[]): Promise<void> {
    try {
      const valor = await this.#despachar(metodo, args);
      this.#enviar({ tipo: "respuesta-api", id, ok: true, valor });
    } catch (err) {
      this.#enviar({ tipo: "respuesta-api", id, ok: false, error: (err as Error).message });
    }
  }

  async #despachar(metodo: string, args: unknown[]): Promise<unknown> {
    const api = this.#opts.api;
    const m = this.manifest;

    switch (metodo) {
      case "enviarMensaje":
        requireCapability(m, "messages:send");
        return api.enviarMensaje(String(args[0]), String(args[1]), String(args[2]), args[3] as never);
      case "leerMensajes":
        requireCapability(m, "messages:read");
        return api.leerMensajes(String(args[0]), String(args[1]), Number(args[2] ?? 50));
      case "listarChats":
        requireCapability(m, "chats:read");
        return api.listarChats(String(args[0]), Number(args[1] ?? 50));
      case "listarLineas":
        requireCapability(m, "lines:read");
        return api.listarLineas();
      case "etiquetarChat":
        requireCapability(m, "labels:manage");
        return api.etiquetarChat(String(args[0]), String(args[1]), args[2] as string[]);
      case "kvGet":
        requireCapability(m, "kv:use");
        // El KV va con prefijo por plugin: uno no puede leer ni pisar el del otro.
        return api.kvGet(`plugin:${m.id}:${String(args[0])}`);
      case "kvSet":
        requireCapability(m, "kv:use");
        return api.kvSet(`plugin:${m.id}:${String(args[0])}`, String(args[1]), args[2] as number | undefined);
      case "fetch": {
        requireCapability(m, "net:fetch");
        const url = checkUrl(m, String(args[0]));
        const init = (args[1] ?? {}) as RequestInit;
        const res = await api.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
        const cuerpo = await res.text();
        return {
          status: res.status,
          body: cuerpo.slice(0, 1_000_000),
          headers: Object.fromEntries(res.headers),
        };
      }
      default:
        throw new OmniError("validation_failed", `método desconocido: "${metodo}"`);
    }
  }
}
