import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabase, migrate, type DbHandle } from "@omni/db";
import { loadConfig } from "../../api/src/config.js";
import { buildContainer, type Container } from "../../api/src/container.js";
import { createApp } from "../../api/src/app.js";
import { COMMANDS } from "./commands.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

let dbh: DbHandle;
let container: Container;
let spec: { paths: Record<string, Record<string, unknown>> };

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "a".repeat(64),
      SANDBOX_ENABLED: "true",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  const res = await createApp(container).request("/openapi.json");
  spec = (await res.json()) as typeof spec;
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

/**
 * Cobertura de la CLI.
 *
 * La idea es de crafter y es buena: si una operación de la API no tiene
 * comando, el hueco se ve en CI y no el día que alguien lo necesita desde un
 * script. Lo que se excluye se excluye a mano y con motivo escrito.
 */
const SIN_COMANDO = new Map<string, string>([
  // Se sube un fichero con multipart; un comando útil necesita leer del disco
  // y aún no está hecho.
  ["POST /v1/media", "pendiente: subida de ficheros desde el disco"],
  // Se descarga por URL firmada, que ya devuelve la API. Un comando sería un
  // envoltorio de `curl` sin valor añadido.
  ["GET /v1/media/{key}", "se accede por la URL firmada que ya devuelve la API; un comando sería un envoltorio de curl"],
  // La identidad de personas va por cookie de sesión y navegador. Una CLI que
  // guardara sesiones necesita su propio almacén de credenciales, y eso es una
  // decisión aparte: de momento la CLI usa claves de API.
  ["POST /v1/auth/register", "alta por navegador; la CLI usa claves de API"],
  ["POST /v1/auth/login", "sesión por cookie; la CLI usa claves de API"],
  ["POST /v1/auth/logout", "sesión por cookie; la CLI usa claves de API"],
  ["GET /v1/auth/me", "describe una sesión de persona, no una clave"],
  ["POST /v1/invitations/accept", "se acepta desde el enlace, en el navegador"],
  // Las llama META, no una persona: la URL se pega en el panel de Meta y se
  // autentica con la firma del cuerpo, no con una credencial nuestra.
  ["GET /v1/channels/cloud/{lineId}/webhook", "la llama Meta para verificar la URL"],
  ["POST /v1/channels/cloud/{lineId}/webhook", "la llama Meta para empujar eventos"],
  // El billete solo sirve para abrir un socket, y una CLI de un disparo no
  // tiene dónde mantenerlo abierto. Un comando `omni escuchar` tendría sentido,
  // pero es otra forma de programa.
  ["POST /v1/realtime/ticket", "solo sirve para abrir un WebSocket"],
]);

run("cobertura de la CLI sobre la API", () => {
  const operaciones = (): string[] => {
    const out: string[] = [];
    for (const [ruta, metodos] of Object.entries(spec.paths)) {
      for (const metodo of Object.keys(metodos)) {
        if (["get", "post", "patch", "put", "delete"].includes(metodo)) {
          out.push(`${metodo.toUpperCase()} ${ruta}`);
        }
      }
    }
    return out.sort();
  };

  it("toda operación tiene comando, o una exclusión escrita", () => {
    const cubiertas = new Set(COMMANDS.map((c) => c.operation));
    const huerfanas = operaciones().filter((op) => !cubiertas.has(op) && !SIN_COMANDO.has(op));
    expect(
      huerfanas,
      `operaciones sin comando ni exclusión:\n  ${huerfanas.join("\n  ")}\n` +
        "Añade un comando en commands.ts, o una exclusión con su motivo.",
    ).toEqual([]);
  });

  it("ningún comando apunta a una operación que ya no existe", () => {
    // El otro lado del guard: quitar un endpoint debe romper su comando.
    const existentes = new Set(operaciones());
    const rotos = COMMANDS.filter((c) => !existentes.has(c.operation)).map((c) => `${c.name} → ${c.operation}`);
    expect(rotos, `comandos que apuntan a operaciones inexistentes:\n  ${rotos.join("\n  ")}`).toEqual([]);
  });

  it("ninguna exclusión sobra", () => {
    const existentes = new Set(operaciones());
    const sobrantes = [...SIN_COMANDO.keys()].filter((op) => !existentes.has(op));
    expect(sobrantes, "exclusiones de operaciones que ya no existen").toEqual([]);
  });
});
