import { z } from "zod";
import { OmniError } from "@omni/shared";
import type { Principal } from "@omni/core";
import type { Container } from "../container.js";
import { TOOLS, toolError, toolResult, type ToolDef } from "./tools.js";
import { exigirLineaDeLaOrganizacion } from "../middleware/auth.js";

/**
 * Servidor MCP sobre HTTP, sin estado.
 *
 * Se implementa el JSON-RPC directamente en vez de montar el transporte del
 * SDK: para un servidor de solo herramientas el protocolo es pequeño, y el
 * puente entre la petición `fetch` de Hono y el `http` de Node consumía el
 * cuerpo antes de tiempo y devolvía 400 sin decir por qué. Prefiero algo que
 * pueda probar de punta a punta.
 *
 * Sin estado significa que cada petición trae su credencial y construye su
 * propia vista: dos agentes con alcances distintos no pueden verse nunca a
 * través de una sesión compartida.
 */

export const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS =
  "Pasarela multicanal de mensajería. Consulta `capacidades` antes de intentar " +
  "algo poco común: cada transporte soporta cosas distintas y lo no soportado se " +
  "rechaza con un error claro. Los envíos quedan ENCOLADOS, no entregados. Las " +
  "líneas de sandbox son simuladas: úsalas para probar sin arriesgar ninguna " +
  "cuenta real de WhatsApp.";

export interface McpOptions {
  readonly readOnly: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const fail = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0" as const, id, error: { code, message },
});

function describe(tool: ToolDef): Record<string, unknown> {
  const shape = Object.keys(tool.schema).length > 0 ? z.object(tool.schema) : z.object({});
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(shape, { io: "input" }),
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: true },
  };
}

export function visibleTools(opts: McpOptions): readonly ToolDef[] {
  return opts.readOnly ? TOOLS.filter((t) => t.readOnly) : TOOLS;
}

/** Atiende una petición JSON-RPC. Devuelve `null` para las notificaciones. */
export async function handleMcp(
  container: Container,
  principal: Principal,
  opts: McpOptions,
  body: unknown,
): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = await Promise.all(body.map((b) => handleMcp(container, principal, opts, b)));
    const answers = out.filter((o) => o !== null);
    return answers.length > 0 ? answers : null;
  }

  const req = body as JsonRpcRequest;
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return fail(null, -32600, "petición JSON-RPC inválida");
  }
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "omni", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });

    // Las notificaciones no llevan respuesta.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return reply(id, {});

    case "tools/list":
      return reply(id, { tools: visibleTools(opts).map(describe) });

    case "tools/call": {
      const name = String(req.params?.["name"] ?? "");
      const args = (req.params?.["arguments"] ?? {}) as Record<string, unknown>;
      const tool = visibleTools(opts).find((t) => t.name === name);
      if (!tool) return fail(id, -32602, `herramienta desconocida: "${name}"`);
      try {
        const shape = Object.keys(tool.schema).length > 0 ? z.object(tool.schema) : z.object({});
        const parsed = shape.parse(args) as Record<string, unknown>;
        /*
         * El guardián se aplica AQUÍ, dentro de cada herramienta y en cada
         * llamada. Comprobar solo al autenticar la petición dejaría a un agente
         * acotado alcanzando por MCP lo que no alcanza por HTTP: una superficie
         * fuera del guard REST no hereda sus permisos.
         */
        // Igual que en REST: la línea tiene que ser de la organización de la clave.
        if (typeof parsed["lineId"] === "string") {
          await exigirLineaDeLaOrganizacion(container.dbh.db, principal.orgId, parsed["lineId"]);
        }
        return reply(id, toolResult(await tool.run({ container, principal }, parsed)));
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply(id, toolError(new OmniError("validation_failed", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))));
        }
        return reply(id, toolError(err));
      }
    }

    default:
      return fail(id, -32601, `método no soportado: "${req.method}"`);
  }
}
