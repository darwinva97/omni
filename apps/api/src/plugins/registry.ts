import { and, eq } from "drizzle-orm";
import { OmniError, type EventEnvelope } from "@omni/shared";
import {
  parseManifest, PluginSupervisor,
  type HookPayload, type Manifest, type PluginHostApi,
} from "@omni/plugins";
import { pluginTable, type Database } from "@omni/db";
import type { Bus } from "@omni/platform";

/**
 * Registro de plugins vivos.
 *
 * Mantiene un supervisor por plugin habilitado y les reparte los eventos. Es el
 * puente entre la ingesta —que no sabe nada de plugins— y los procesos aislados.
 */

export interface RegistryDeps {
  readonly db: Database;
  readonly api: (orgId: string) => PluginHostApi;
  readonly hostVersion: string;
  /**
   * Por aquí viajan los cambios de plugins entre nodos.
   *
   * Sin él, habilitar un plugin en un nodo lo deja apagado en los demás: los
   * eventos que ingiera OTRO nodo no lo verían, y el panel diría que está
   * activo. Un plugin a medias es peor que uno apagado.
   */
  readonly bus?: Bus;
  readonly onLog?: (nivel: string, mensaje: string, datos?: unknown) => void;
}

interface Vivo {
  /*
   * Se rellena justo después de construirlo, porque el supervisor necesita un
   * `leerConfig` que apunte a ESTE objeto. Copiarlo con spread al guardarlo
   * dejaría al supervisor leyendo el original y los cambios de configuración
   * no llegarían nunca al plugin.
   */
  supervisor: PluginSupervisor;
  readonly filaId: string;
  readonly orgId: string;
  /**
   * Mutable a propósito: el supervisor la lee en CADA gancho.
   *
   * Cachearla al habilitar es el defecto de OpenWA que este diseño corrige; si
   * el gancho llevara la copia vieja, machacaría en el hijo la que se acaba de
   * notificar y el cambio no entraría nunca.
   */
  config: Record<string, unknown>;
}

const TEMA_CONTROL = "plugins.control";

interface AvisoDeControl {
  readonly filaId: string;
  readonly accion: "config" | "arrancar" | "detener";
  readonly config?: Record<string, unknown>;
  readonly emisor: string;
}

export class PluginRegistry {
  readonly #deps: RegistryDeps;
  readonly #vivos = new Map<string, Vivo>();
  readonly #yo = crypto.randomUUID();
  #desuscribir: (() => Promise<void>) | null = null;

  constructor(deps: RegistryDeps) {
    this.#deps = deps;
  }

  /** Escucha los cambios que hagan los demás nodos. */
  async escuchar(): Promise<void> {
    if (!this.#deps.bus || this.#desuscribir) return;
    this.#desuscribir = await this.#deps.bus.subscribe<AvisoDeControl>(TEMA_CONTROL, async (aviso) => {
      if (aviso.emisor === this.#yo) return; // ya está aplicado aquí
      try {
        if (aviso.accion === "config" && aviso.config) this.#aplicarConfig(aviso.filaId, aviso.config);
        else if (aviso.accion === "arrancar") await this.arrancar(aviso.filaId);
        else if (aviso.accion === "detener") await this.detener(aviso.filaId);
      } catch (err) {
        this.#deps.onLog?.("warn", `no se pudo aplicar ${aviso.accion}: ${(err as Error).message}`);
      }
    });
  }

  async #avisar(aviso: Omit<AvisoDeControl, "emisor">): Promise<void> {
    await this.#deps.bus?.publish<AvisoDeControl>(TEMA_CONTROL, { ...aviso, emisor: this.#yo })
      .catch(() => {});
  }

  get vivos(): number {
    return this.#vivos.size;
  }

  /** Arranca los plugins habilitados. Se llama al levantar el proceso. */
  async arrancarTodos(): Promise<{ arrancados: string[]; fallidos: { id: string; razon: string }[] }> {
    const filas = await this.#deps.db.select().from(pluginTable).where(eq(pluginTable.enabled, true));
    const arrancados: string[] = [];
    const fallidos: { id: string; razon: string }[] = [];

    for (const fila of filas) {
      try {
        await this.arrancar(fila.id);
        arrancados.push(fila.pluginId);
      } catch (err) {
        // Un plugin que no arranca no puede impedir que arranquen los demás ni
        // que el servicio atienda peticiones.
        const razon = err instanceof Error ? err.message : String(err);
        fallidos.push({ id: fila.pluginId, razon });
        await this.#marcar(fila.id, "fallido", razon);
      }
    }
    return { arrancados, fallidos };
  }

  async arrancar(filaId: string): Promise<void> {
    if (this.#vivos.has(filaId)) return;

    const filas = await this.#deps.db.select().from(pluginTable).where(eq(pluginTable.id, filaId)).limit(1);
    const fila = filas[0];
    if (!fila) throw new OmniError("not_found", "ese plugin no está instalado");

    // Se valida OTRA VEZ contra la versión del anfitrión: entre la instalación
    // y ahora puede haber habido un despliegue que cambiara la API.
    const manifest = parseManifest(fila.manifest, this.#deps.hostVersion);

    const vivo = {
      supervisor: null as unknown as PluginSupervisor,
      filaId, orgId: fila.orgId,
      config: (fila.config ?? {}) as Record<string, unknown>,
    } satisfies Vivo;

    const supervisor = new PluginSupervisor({
      manifest,
      directorio: fila.directory,
      api: this.#deps.api(fila.orgId),
      leerConfig: () => vivo.config,
      onLog: (nivel, mensaje, datos) => this.#deps.onLog?.(nivel, mensaje, datos),
      onFatal: (error) => {
        this.#vivos.delete(filaId);
        void this.#marcar(filaId, "fallido", error);
        this.#deps.onLog?.("error", `[${manifest.id}] murió: ${error}`);
      },
    });

    await supervisor.iniciar();
    vivo.supervisor = supervisor;
    this.#vivos.set(filaId, vivo);
    await this.#marcar(filaId, "listo", null);
  }

  /** Como `arrancar`, pero además lo pide a los demás nodos. */
  async arrancarEnTodos(filaId: string): Promise<void> {
    await this.arrancar(filaId);
    await this.#avisar({ filaId, accion: "arrancar" });
  }

  async detenerEnTodos(filaId: string): Promise<void> {
    await this.detener(filaId);
    await this.#avisar({ filaId, accion: "detener" });
  }

  async detener(filaId: string): Promise<void> {
    const vivo = this.#vivos.get(filaId);
    if (!vivo) return;
    this.#vivos.delete(filaId);
    await vivo.supervisor.detener();
    await this.#marcar(filaId, "parado", null);
  }

  async detenerTodos(): Promise<void> {
    await this.#desuscribir?.().catch(() => {});
    this.#desuscribir = null;
    await Promise.all([...this.#vivos.keys()].map((id) => this.detener(id).catch(() => {})));
  }

  async recargarConfig(filaId: string, config: Record<string, unknown>): Promise<void> {
    this.#aplicarConfig(filaId, config);
    await this.#avisar({ filaId, accion: "config", config });
  }

  #aplicarConfig(filaId: string, config: Record<string, unknown>): void {
    const vivo = this.#vivos.get(filaId);
    if (!vivo) return;
    // Los dos: lo que ve el gancho siguiente y lo que ve el plugin ahora mismo.
    vivo.config = config;
    vivo.supervisor.notificarConfig(config);
  }

  async salud(filaId: string): Promise<{ ok: boolean; detalle?: string }> {
    const vivo = this.#vivos.get(filaId);
    if (!vivo) return { ok: false, detalle: "no está corriendo" };
    return vivo.supervisor.comprobarSalud();
  }

  /**
   * Reparte un evento a los plugins de esa organización.
   *
   * Si uno pide detener la cadena, los siguientes no lo ven. El orden es el de
   * arranque: determinista, aunque no configurable todavía.
   */
  async despachar(envelope: EventEnvelope): Promise<void> {
    const payload: HookPayload = {
      event: envelope.event,
      lineId: envelope.lineId,
      orgId: envelope.orgId,
      timestamp: envelope.timestamp,
      data: envelope.data,
    };

    for (const vivo of this.#vivos.values()) {
      if (vivo.orgId !== envelope.orgId) continue;
      const r = await vivo.supervisor.ejecutarGancho(payload);
      if (!r.continuar) return;
    }
  }

  async #marcar(filaId: string, estado: string, error: string | null): Promise<void> {
    await this.#deps.db
      .update(pluginTable)
      .set({ status: estado, lastError: error, updatedAt: new Date() })
      .where(eq(pluginTable.id, filaId))
      .catch(() => {});
  }

  /** Comprueba un manifiesto antes de guardarlo. */
  static validar(crudo: unknown, hostVersion: string): Manifest {
    return parseManifest(crudo, hostVersion);
  }

  async buscar(orgId: string, pluginId: string): Promise<typeof pluginTable.$inferSelect | null> {
    const filas = await this.#deps.db
      .select().from(pluginTable)
      .where(and(eq(pluginTable.orgId, orgId), eq(pluginTable.pluginId, pluginId)))
      .limit(1);
    return filas[0] ?? null;
  }
}
