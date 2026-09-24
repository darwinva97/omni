import { z } from "zod";

/**
 * Configuración por entorno. Una sola variable decide la infraestructura:
 * con `REDIS_URL` se usan colas y bus distribuidos; sin ella, todo sobre
 * Postgres, que es lo que hace posible el perfil de coste cero.
 */
/**
 * Booleano desde una variable de entorno.
 *
 * `z.coerce.boolean()` NO vale aquí: aplica la veracidad de JavaScript, y la
 * cadena "false" es veraz. Con ella, `SANDBOX_ENABLED=false` dejaba el sandbox
 * encendido y `MCP_READONLY=false` no era el problema —lo era `=true`— pero
 * sobre todo apagar algo por configuración simplemente no funcionaba. Un ajuste
 * de seguridad que se ignora en silencio es peor que no tenerlo.
 */
const envBoolean = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v, ctx) => {
      if (typeof v === "boolean") return v;
      const normal = v.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on", "si", "sí"].includes(normal)) return true;
      if (["false", "0", "no", "n", "off", ""].includes(normal)) return false;
      ctx.addIssue({ code: "custom", message: `"${v}" no es un booleano reconocible` });
      return z.NEVER;
    });

export const Config = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  /**
   * Clave maestra de las credenciales de línea. PERDERLA SIGNIFICA PERDER TODAS
   * LAS SESIONES: 64 caracteres hex, o una frase de 32 o más.
   */
  OMNI_MASTER_KEY: z.string().min(32),
  /** Base pública, para construir URLs absolutas en la documentación. */
  PUBLIC_URL: z.string().default("http://127.0.0.1:4000"),
  /** Habilita el sandbox. En producción suele quedarse encendido: no toca nada real. */
  SANDBOX_ENABLED: envBoolean(true),
  BILLING_ENABLED: envBoolean(false),
  /**
   * Servidor MCP. Apagado por defecto: expone el gateway a agentes, y eso
   * quiere una decisión explícita.
   */
  /**
   * Entregar webhooks dentro de la API.
   *
   * Cómodo para un despliegue de un solo proceso. Con tráfico conviene
   * apagarlo y levantar `@omni/worker` aparte: una ráfaga de reintentos
   * competiría por el mismo bucle de eventos que los usuarios.
   *
   * NO afecta al envío de mensajes: esa cola la consume siempre el motor, que
   * es quien tiene los sockets, y ningún otro proceso puede sustituirlo.
   */
  RUN_WORKERS_IN_API: envBoolean(true),
  /** Transporte Baileys. Cliente NO oficial: ver el aviso del README. */
  WHATSAPP_BAILEYS_ENABLED: envBoolean(true),
  MCP_ENABLED: envBoolean(false),
  /** Con `true` (el defecto) solo se ofrecen herramientas de lectura. */
  MCP_READONLY: envBoolean(true),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /**
   * Almacén de medios. Sin `S3_BUCKET` se usa el disco, en un directorio propio
   * que NO debe estar bajo ninguna carpeta servida estáticamente.
   */
  MEDIA_DIR: z.string().default("./.data/media"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Config.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`configuración inválida:\n${issues}`);
  }
  return parsed.data;
}
