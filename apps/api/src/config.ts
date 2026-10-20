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
  /**
   * Dirección en la que escucha. Por defecto solo local: detrás de un proxy en
   * la misma máquina, nadie de la red tiene por qué llegar a la API sin pasar
   * por él. En un contenedor el proxy está fuera, y hace falta `0.0.0.0`.
   */
  HOST: z.string().default("127.0.0.1"),
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
  /** Transporte oficial de Meta. Sin riesgo de baneo y sin coste por línea. */
  WHATSAPP_CLOUD_ENABLED: envBoolean(true),
  /**
   * Transporte por navegador. Menor riesgo de baneo que Baileys —el tráfico es
   * de un Chromium real— a cambio de unos 400 MB por línea. Apagado por defecto.
   */
  WHATSAPP_WEB_ENABLED: envBoolean(false),
  /**
   * Telegram. Encendido: no mantiene sesión de cifrado, no arriesga baneo y
   * una línea solo lo usa si su configuración trae el token del bot.
   */
  TELEGRAM_ENABLED: envBoolean(true),
  /**
   * Correo. Encendido: no arriesga nada y una línea solo lo usa si su
   * configuración trae servidor y credenciales.
   */
  EMAIL_ENABLED: envBoolean(true),
  /**
   * Ruta de ffmpeg. Sin él, lo que graba un navegador no se puede convertir a
   * lo que WhatsApp reproduce, y el envío se rechaza en vez de mandar algo que
   * no suena.
   */
  FFMPEG_PATH: z.string().default("ffmpeg"),
  /** Cada cuánto se revisa el buzón IMAP, en segundos. */
  EMAIL_POLL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  CHROMIUM_PATH: z.string().optional(),
  /**
   * Plugins. Apagados por defecto: ejecutan código de terceros, aunque sea en
   * un proceso con permisos recortados, y eso quiere una decisión explícita.
   */
  PLUGINS_ENABLED: envBoolean(false),
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
  /**
   * Host público contra el que se firman las URLs de descarga, cuando la API
   * habla con el almacén por una dirección interna (`S3_ENDPOINT`) que desde
   * fuera no existe. Sin él se firma contra `S3_ENDPOINT`.
   */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * Entrada con OpenID Connect (p. ej. Keycloak). Se activa con emisor, cliente
   * y secreto; sin ellos el panel solo ofrece correo y contraseña. Solo entra
   * quien ya tiene cuenta en Omni con el mismo correo, verificado en el
   * proveedor: el proveedor dice quién es, Omni decide a qué tiene acceso.
   */
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_DISPLAY_NAME: z.string().default("Keycloak"),
  /** Grupos del proveedor con acceso, separados por comas. Vacío: cualquiera con cuenta en Omni. */
  OIDC_ALLOWED_GROUPS: z.string().default(""),
  OIDC_GROUPS_CLAIM: z.string().default("groups"),
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
