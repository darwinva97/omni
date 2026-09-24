import { z } from "zod";

/**
 * Configuración por entorno. Una sola variable decide la infraestructura:
 * con `REDIS_URL` se usan colas y bus distribuidos; sin ella, todo sobre
 * Postgres, que es lo que hace posible el perfil de coste cero.
 */
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
  SANDBOX_ENABLED: z.coerce.boolean().default(true),
  BILLING_ENABLED: z.coerce.boolean().default(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
