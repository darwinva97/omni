import { OmniClient } from "./client.js";
import { COMMANDS, findCommand, type Command } from "./commands.js";
import { formatTable } from "./format.js";
import { parseArgs } from "./parse.js";

/**
 * Códigos de salida con significado, para poder usarla en un script:
 *   0 correcto · 1 error de uso · 2 error del servicio · 3 falta configuración
 */
export const EXIT = { ok: 0, uso: 1, servicio: 2, configuracion: 3 } as const;

export function help(): string {
  const ancho = Math.max(...COMMANDS.map((c) => c.name.length));
  const grupos = new Map<string, Command[]>();
  for (const c of COMMANDS) {
    const grupo = c.name.includes(":") ? c.name.split(":")[0]! : "general";
    grupos.set(grupo, [...(grupos.get(grupo) ?? []), c]);
  }
  const lineas = [
    "omni — pasarela multicanal de mensajería",
    "",
    "  omni <comando> [argumentos] [--opciones]",
    "",
    "Configuración por entorno:",
    "  OMNI_URL       base de la API (por defecto http://127.0.0.1:4000)",
    "  OMNI_API_KEY   credencial, con formato omni_<prefijo>_<secreto>",
    "",
    "Opciones comunes:",
    "  --json         salida en JSON, para encadenar con jq",
    "  --yes          confirmar un comando destructivo",
    "",
  ];
  for (const [grupo, comandos] of grupos) {
    lineas.push(`${grupo}:`);
    for (const c of comandos) {
      const destructivo = c.destructive ? "  (destructivo)" : "";
      lineas.push(`  ${c.name.padEnd(ancho)}  ${c.summary}${destructivo}`);
    }
    lineas.push("");
  }
  return lineas.join("\n");
}

export function usage(command: Command): string {
  const args = command.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
  const lineas = [
    command.summary,
    "",
    `  omni ${command.name} ${args}`.trimEnd(),
    "",
    ...(command.args.length > 0
      ? ["Argumentos:", ...command.args.map((a) => `  ${a.name.padEnd(14)}  ${a.description}`), ""]
      : []),
    ...(command.flags?.length
      ? ["Opciones:", ...command.flags.map((f) => `  --${f.name.padEnd(12)}  ${f.description}`), ""]
      : []),
    `Cubre: ${command.operation}`,
  ];
  return lineas.join("\n");
}

export interface RunDeps {
  readonly env: Record<string, string | undefined>;
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly fetchImpl?: typeof fetch;
}

export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const [nombre, ...resto] = argv;

  if (!nombre || nombre === "--help" || nombre === "-h" || nombre === "ayuda") {
    deps.out(help());
    return EXIT.ok;
  }

  const command = findCommand(nombre);
  if (!command) {
    deps.err(`comando desconocido: "${nombre}"\n\nPrueba: omni ayuda`);
    return EXIT.uso;
  }

  const args = parseArgs(resto);
  if (args.flags["help"] === true) {
    deps.out(usage(command));
    return EXIT.ok;
  }

  const obligatorios = command.args.filter((a) => a.required).length;
  if (args.positional.length < obligatorios) {
    deps.err(`faltan argumentos\n\n${usage(command)}`);
    return EXIT.uso;
  }

  // Un comando destructivo NO adivina la intención: o se confirma, o no corre.
  if (command.destructive && args.flags["yes"] !== true) {
    deps.err(`"${command.name}" es destructivo. Añade --yes para confirmarlo.`);
    return EXIT.uso;
  }

  const apiKey = deps.env["OMNI_API_KEY"];
  if (!apiKey) {
    deps.err("falta OMNI_API_KEY en el entorno");
    return EXIT.configuracion;
  }

  const client = new OmniClient({
    baseUrl: deps.env["OMNI_URL"] ?? "http://127.0.0.1:4000",
    apiKey,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  try {
    const res = (await command.run(client, args)) as { data?: unknown };
    const payload = res?.data ?? res;
    deps.out(args.flags["json"] === true ? JSON.stringify(payload, null, 2) : formatTable(payload));
    return EXIT.ok;
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return EXIT.servicio;
  }
}
