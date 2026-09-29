import { z } from "zod";

/**
 * Direcciones de conversación.
 *
 * El error que rompe integraciones reales contra WhatsApp es tratar el
 * identificador de una conversación como si fuera siempre un número de teléfono.
 * Desde el sistema LID no lo es: `remoteJid` llega a menudo como un identificador
 * de privacidad (`46274715893950@lid`) y el teléfono, cuando WhatsApp lo da,
 * viaja aparte.
 *
 * Regla dura, heredada de lo que OpenWA documenta y lo que nos ahorra un fallo
 * de aislamiento: **los dígitos de un LID nunca son un teléfono**. `555000111@lid`
 * y `555000111@s.whatsapp.net` son dos personas distintas mientras la tabla de
 * mapeo no diga lo contrario, y un LID sin mapear se RECHAZA, no se adivina.
 */
/**
 * `telegram` es su propio tipo y no `handle` a propósito. Un identificador de
 * chat de Telegram es un número, igual que un teléfono, y meterlos en el mismo
 * saco haría que dos conversaciones de redes distintas pudieran parecer la
 * misma. Es la misma regla que separa `pn` de `lid`.
 */
export const AddressKind = z.enum([
  "pn", "lid", "group", "newsletter", "broadcast", "email", "handle", "telegram",
]);
export type AddressKind = z.infer<typeof AddressKind>;

export interface Address {
  readonly kind: AddressKind;
  /** La parte local, sin sufijo. Para `pn`, dígitos en E.164 sin el `+`. */
  readonly local: string;
  /** Representación canónica que se persiste y se expone: `local@suffix`. */
  readonly value: string;
}

const SUFFIX: Record<AddressKind, string> = {
  pn: "s.whatsapp.net",
  lid: "lid",
  group: "g.us",
  newsletter: "newsletter",
  broadcast: "broadcast",
  email: "email",
  handle: "handle",
  telegram: "telegram",
};

/** `@c.us` es la forma de whatsapp-web.js para un individuo; equivale a `@s.whatsapp.net`. */
const PARSE: Record<string, AddressKind> = {
  "s.whatsapp.net": "pn",
  "c.us": "pn",
  "lid": "lid",
  "g.us": "group",
  "newsletter": "newsletter",
  "broadcast": "broadcast",
  "email": "email",
  "handle": "handle",
  "telegram": "telegram",
};

export class AddressError extends Error {}

const make = (kind: AddressKind, local: string): Address => ({
  kind,
  local,
  // Un correo ya es su propia forma canónica; añadirle sufijo lo duplicaría.
  value: kind === "email" ? local : `${local}@${SUFFIX[kind]}`,
});

/** Normaliza cualquier forma conocida a una `Address`. Lanza si es irreconocible. */
export function parseAddress(raw: string): Address {
  const input = raw.trim();
  if (input.length === 0) throw new AddressError("dirección vacía");

  const at = input.lastIndexOf("@");
  if (at === -1) {
    // Sin sufijo solo aceptamos un teléfono: es la única lectura sin ambigüedad.
    const digits = input.replace(/[\s()+-]/g, "");
    if (!/^\d{5,20}$/.test(digits)) {
      throw new AddressError(
        `"${raw}" no lleva sufijo y no es un teléfono; usa una dirección explícita como 51999888777@s.whatsapp.net`,
      );
    }
    return make("pn", digits);
  }

  const local = input.slice(0, at);
  const suffix = input.slice(at + 1).toLowerCase();

  if (suffix.includes(".") && PARSE[suffix] === undefined && /^[^@]+@[^@]+\.[^@]+$/.test(input)) {
    return make("email", input.toLowerCase());
  }

  const kind = PARSE[suffix];
  if (kind === undefined) throw new AddressError(`sufijo de dirección desconocido: "@${suffix}"`);

  if (kind === "pn") {
    // Baileys añade sufijos de dispositivo (`:12`) que no forman parte de la identidad.
    const digits = local.split(":")[0]!.replace(/[^\d]/g, "");
    if (digits.length < 5) throw new AddressError(`teléfono inválido en "${raw}"`);
    return make("pn", digits);
  }
  if (kind === "email") return make("email", `${local.toLowerCase()}@${suffix}`);
  return make(kind, local.split(":")[0]!);
}

export function tryParseAddress(raw: string): Address | null {
  try {
    return parseAddress(raw);
  } catch {
    return null;
  }
}

export const isGroup = (a: Address): boolean => a.kind === "group";
export const isIndividual = (a: Address): boolean => a.kind === "pn" || a.kind === "lid";

/**
 * Igualdad de direcciones. Deliberadamente NO cruza tipos: un `pn` y un `lid`
 * con los mismos dígitos no son iguales. Para saber si dos direcciones son la
 * misma persona hay que resolver el mapeo LID↔PN, que vive en la base de datos.
 */
export const sameAddress = (a: Address, b: Address): boolean =>
  a.kind === b.kind && a.local === b.local;

/** Par resuelto de identidad: lo que se entrega en los webhooks. */
export interface ResolvedIdentity {
  readonly primary: Address;
  /** El teléfono, cuando el mapeo lo conoce. `null` significa "no lo sabemos", no "no tiene". */
  readonly phone: Address | null;
}
