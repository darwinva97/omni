import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OmniError } from "@omni/shared";
import { authorize, route as routeOf } from "@omni/core";
import { pluginTable } from "@omni/db";
import { and, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import { PluginRegistry } from "../plugins/registry.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Gestión de plugins.
 *
 * Instalar apunta a un directorio del servidor, no sube un zip: un plugin corre
 * código, así que quien lo instala tiene que poder ponerlo en disco. Aceptar
 * subidas por HTTP convertiría una clave de API en ejecución remota.
 */
const PluginSchema = z.object({
  id: z.string(), pluginId: z.string(), version: z.string(),
  enabled: z.boolean(), status: z.string(),
  lastError: z.string().nullable(),
  permissions: z.array(z.string()), hooks: z.array(z.string()),
}).openapi("Plugin");

const presentar = (f: typeof pluginTable.$inferSelect) => {
  const m = f.manifest as { permissions?: string[]; hooks?: string[] };
  return {
    id: f.id, pluginId: f.pluginId, version: f.version,
    enabled: f.enabled, status: f.status, lastError: f.lastError,
    permissions: m.permissions ?? [], hooks: m.hooks ?? [],
  };
};

export function registerPluginRoutes(
  app: OpenAPIHono<ApiEnv>,
  container: Container,
  registry: PluginRegistry,
  hostVersion: string,
): void {
  const db = container.dbh.db;

  app.openapi(
    createRoute({
      method: "get", path: "/v1/plugins", tags: ["plugins"],
      summary: "Plugins instalados, con sus permisos y su estado",
      responses: { 200: json(z.object({ data: z.array(PluginSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("plugin.manage"));
      const filas = await db.select().from(pluginTable).where(eq(pluginTable.orgId, principal.orgId));
      return c.json({ data: filas.map(presentar) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/plugins", tags: ["plugins"],
      summary: "Instalar un plugin desde un directorio del servidor",
      description:
        "Se apunta a una ruta del disco; NO se sube nada. Un plugin ejecuta " +
        "código, y aceptar un zip por HTTP convertiría una clave de API en " +
        "ejecución remota. Nace APAGADO: instalar no es autorizar.",
      request: { ...body(z.object({ directory: z.string().min(1) })) },
      responses: { 201: json(z.object({ data: PluginSchema }), "instalado"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("plugin.manage"));
      const { directory } = c.req.valid("json");

      const dir = resolve(directory);
      let crudo: unknown;
      try {
        crudo = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
      } catch {
        throw new OmniError("validation_failed", `no se pudo leer ${dir}/manifest.json`);
      }

      // Un manifiesto malo es culpa de quien instala, no del servidor: 422.
      let manifest;
      try {
        manifest = PluginRegistry.validar(crudo, hostVersion);
      } catch (err) {
        throw new OmniError("validation_failed", (err as Error).message);
      }

      const id = `plg-${crypto.randomUUID()}`;
      const creado = await db.insert(pluginTable).values({
        id, orgId: principal.orgId, pluginId: manifest.id, version: manifest.version,
        manifest: manifest as unknown as Record<string, unknown>,
        directory: dir, enabled: false, status: "parado",
        installedBy: principal.kind === "user" ? principal.userId : null,
      }).onConflictDoNothing().returning();

      if (creado.length === 0) {
        throw new OmniError("conflict", `"${manifest.id}" ya está instalado en esta organización`);
      }
      return c.json({ data: presentar(creado[0]!) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/plugins/{pluginId}/enable", tags: ["plugins"],
      summary: "Habilitar o deshabilitar un plugin",
      request: {
        params: z.object({ pluginId: z.string() }),
        ...body(z.object({ enabled: z.boolean() })),
      },
      responses: { 200: json(z.object({ data: PluginSchema }), "hecho"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { pluginId } = c.req.valid("param");
      const { enabled } = c.req.valid("json");
      await authorize(principal, routeOf("plugin.manage"));

      const fila = await registry.buscar(principal.orgId, pluginId);
      if (!fila) throw new OmniError("not_found", "ese plugin no está instalado");

      await db.update(pluginTable)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(pluginTable.id, fila.id));

      // Arrancar puede fallar —permisos, código roto, versión incompatible— y
      // entonces se deja apagado: un plugin marcado como activo que no corre
      // sería una mentira en el panel.
      if (enabled) {
        try {
          await registry.arrancarEnTodos(fila.id);
        } catch (err) {
          await db.update(pluginTable)
            .set({ enabled: false, status: "fallido", lastError: (err as Error).message })
            .where(eq(pluginTable.id, fila.id));
          throw new OmniError("upstream_failed", `no arrancó: ${(err as Error).message}`);
        }
      } else {
        await registry.detenerEnTodos(fila.id);
      }

      const actualizado = await registry.buscar(principal.orgId, pluginId);
      return c.json({ data: presentar(actualizado!) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put", path: "/v1/plugins/{pluginId}/config", tags: ["plugins"],
      summary: "Cambiar la configuración de un plugin",
      description: "El plugin la relee en cada gancho, así que el cambio entra sin reiniciarlo.",
      request: {
        params: z.object({ pluginId: z.string() }),
        ...body(z.object({ config: z.record(z.string(), z.unknown()) })),
      },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "guardada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { pluginId } = c.req.valid("param");
      const { config } = c.req.valid("json");
      await authorize(principal, routeOf("plugin.manage"));

      const fila = await registry.buscar(principal.orgId, pluginId);
      if (!fila) throw new OmniError("not_found", "ese plugin no está instalado");

      await db.update(pluginTable)
        .set({ config, updatedAt: new Date() })
        .where(eq(pluginTable.id, fila.id));
      await registry.recargarConfig(fila.id, config);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/plugins/{pluginId}/health", tags: ["plugins"],
      summary: "Preguntar a un plugin si está bien",
      request: { params: z.object({ pluginId: z.string() }) },
      responses: {
        200: json(z.object({ data: z.object({ ok: z.boolean(), detalle: z.string().optional() }) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { pluginId } = c.req.valid("param");
      await authorize(principal, routeOf("plugin.manage"));
      const fila = await registry.buscar(principal.orgId, pluginId);
      if (!fila) throw new OmniError("not_found", "ese plugin no está instalado");
      return c.json({ data: await registry.salud(fila.id) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/plugins/{pluginId}", tags: ["plugins"],
      summary: "Desinstalar un plugin",
      description: "Lo detiene y olvida su configuración. No borra sus ficheros del disco.",
      request: { params: z.object({ pluginId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "desinstalado"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { pluginId } = c.req.valid("param");
      await authorize(principal, routeOf("plugin.manage"));

      const fila = await registry.buscar(principal.orgId, pluginId);
      if (!fila) throw new OmniError("not_found", "ese plugin no está instalado");
      await registry.detenerEnTodos(fila.id);
      await db.delete(pluginTable)
        .where(and(eq(pluginTable.id, fila.id), eq(pluginTable.orgId, principal.orgId)));
      return c.json({ data: { ok: true } }, 200);
    },
  );
}
