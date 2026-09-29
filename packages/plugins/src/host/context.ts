import { OmniError, type EventEnvelope } from "@omni/shared";
import type { Manifest } from "../manifest.js";
import { checkUrl, requireCapability } from "./capabilities.js";

/**
 * Lo que un plugin puede hacer.
 *
 * Es la superficie ENTERA: un plugin no tiene acceso a la base de datos, ni al
 * driver, ni al contenedor. Todo pasa por aquí, y todo comprueba su capacidad.
 */
export interface PluginHostApi {
  enviarMensaje(lineId: string, to: string, text: string, opts?: { replyTo?: string }): Promise<{ messageId: string }>;
  leerMensajes(lineId: string, chat: string, limite: number): Promise<unknown[]>;
  listarChats(lineId: string, limite: number): Promise<unknown[]>;
  listarLineas(): Promise<unknown[]>;
  etiquetarChat(lineId: string, chat: string, labelIds: string[]): Promise<void>;
  kvGet(clave: string): Promise<string | null>;
  kvSet(clave: string, valor: string, ttlSegundos?: number): Promise<void>;
  fetchImpl: typeof fetch;
  log(nivel: "debug" | "info" | "warn" | "error", mensaje: string, datos?: unknown): void;
}

/** Lo que recibe un gancho. */
export interface HookPayload {
  readonly event: EventEnvelope["event"];
  readonly lineId: string;
  readonly orgId: string;
  readonly timestamp: number;
  readonly data: unknown;
}

/** Lo que un gancho puede devolver. */
export interface HookResult {
  /** `false` detiene la cadena: los ganchos siguientes no se ejecutan. */
  readonly continue?: boolean;
}

export interface PluginContext {
  readonly pluginId: string;
  /**
   * La configuración se LEE en cada acceso, no se congela al habilitar.
   *
   * OpenWA documenta que sus plugins solo ven los cambios si releen
   * `ctx.config` dentro del gancho, y que varios de los suyos no lo hacen. Aquí
   * es una propiedad de acceso: no hay forma de cachearla sin querer.
   */
  readonly config: Record<string, unknown>;
  readonly api: PluginHostApi;
}

export interface Plugin {
  onLoad?(ctx: PluginContext): Promise<void> | void;
  onUnload?(ctx: PluginContext): Promise<void> | void;
  onConfigChange?(ctx: PluginContext, nueva: Record<string, unknown>): Promise<void> | void;
  onHook?(ctx: PluginContext, payload: HookPayload): Promise<HookResult | void> | HookResult | void;
  healthCheck?(ctx: PluginContext): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Construye el contexto que ve un plugin.
 *
 * Cada método comprueba su capacidad ANTES de hacer nada, y `net.fetch`
 * comprueba además el dominio contra la lista del manifiesto.
 */
export function buildContext(
  manifest: Manifest,
  leerConfig: () => Record<string, unknown>,
  api: PluginHostApi,
  registrar: (nivel: string, mensaje: string, datos?: unknown) => void,
): PluginContext {
  const permitido = <T extends unknown[], R>(
    capacidad: Parameters<typeof requireCapability>[1],
    fn: (...args: T) => R,
  ) => (...args: T): R => {
    requireCapability(manifest, capacidad);
    return fn(...args);
  };

  const envuelto: PluginHostApi = {
    enviarMensaje: permitido("messages:send", api.enviarMensaje),
    leerMensajes: permitido("messages:read", api.leerMensajes),
    listarChats: permitido("chats:read", api.listarChats),
    listarLineas: permitido("lines:read", api.listarLineas),
    etiquetarChat: permitido("labels:manage", api.etiquetarChat),
    kvGet: permitido("kv:use", api.kvGet),
    kvSet: permitido("kv:use", api.kvSet),

    fetchImpl: (async (entrada: string | URL | Request, init?: RequestInit) => {
      requireCapability(manifest, "net:fetch");
      const destino = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
      const url = checkUrl(manifest, destino);
      // Un plugin no puede dejar colgada una petición para siempre.
      return api.fetchImpl(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15000) });
    }) as typeof fetch,

    log: (nivel, mensaje, datos) => registrar(nivel, mensaje, datos),
  };

  return {
    pluginId: manifest.id,
    // Propiedad de acceso: leerla siempre devuelve lo vigente.
    get config(): Record<string, unknown> {
      return leerConfig();
    },
    api: envuelto,
  };
}

export class PluginError extends OmniError {
  constructor(pluginId: string, causa: unknown) {
    const detalle = causa instanceof Error ? causa.message : String(causa);
    super("internal", `el plugin "${pluginId}" falló: ${detalle}`, { pluginId });
    this.name = "PluginError";
  }
}
