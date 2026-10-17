/**
 * Los contactos que alguien comparte en un mensaje, leídos.
 *
 * WhatsApp manda una tarjeta vCard tal cual la tenía el teléfono de quien la
 * compartió: puede traer varios números con su etiqueta, correos, empresa,
 * cargo, dirección, web, cumpleaños o una nota. Guardar el mensaje y enseñar
 * solo «Contacto» era tirar todo eso; aquí se lee una vez, igual para todos
 * los transportes, y el panel recibe los datos ya separados.
 */

export interface TelefonoCompartido {
  /** Como venía en la tarjeta: «+51 956 745 854». */
  number: string;
  /**
   * El número de WhatsApp, solo cifras, si la tarjeta dice que lo tiene.
   *
   * WhatsApp lo pone en `waid` al compartir a alguien que usa WhatsApp; un
   * número sin él puede no tenerlo. No se deduce de `number`: un fijo con el
   * mismo aspecto no es una cuenta.
   */
  waId: string | null;
  /** «Móvil», «Trabajo» o la etiqueta que le puso quien lo guardó. */
  label: string | null;
}

export interface ContactoCompartido {
  name: string;
  nickname: string | null;
  phones: TelefonoCompartido[];
  emails: { address: string; label: string | null }[];
  /** Empresa y departamento, juntos: «Coliseo · Torneos». */
  organization: string | null;
  title: string | null;
  urls: string[];
  addresses: { text: string; label: string | null }[];
  /** `AAAA-MM-DD`, o `--MM-DD` si la tarjeta no trae el año. */
  birthday: string | null;
  note: string | null;
  /** Si es una cuenta de empresa de WhatsApp, su nombre y su descripción. */
  business: { name: string | null; description: string | null } | null;
  /** La foto que viaja DENTRO de la tarjeta, como `data:`; casi nunca la trae. */
  photo: string | null;
  /** La tarjeta original, para guardarla como `.vcf`. `null` si no la hubo. */
  vcard: string | null;
}

/** Hasta cuánto pesa una foto incrustada que se devuelve; más es un mensaje que no carga. */
const FOTO_MAXIMA = 150_000;

const ETIQUETAS: Record<string, string> = {
  CELL: "Móvil", MOBILE: "Móvil", IPHONE: "iPhone", WORK: "Trabajo", HOME: "Casa",
  MAIN: "Principal", FAX: "Fax", PAGER: "Buscapersonas", OTHER: "Otro",
};
/** Los tipos que no dicen nada a quien lo lee: «voz» lo es casi todo número. */
const SIN_ETIQUETA = new Set(["VOICE", "PREF", "INTERNET", "X400", "MSG", "TEXT", "UNKNOWN"]);

interface Linea {
  grupo: string | null;
  nombre: string;
  parametros: Map<string, string[]>;
  valor: string;
}

/**
 * Una tarjeta vCard (2.1, 3.0 o 4.0), leída.
 *
 * `respaldo` es el nombre a usar si la tarjeta no trae ninguno: WhatsApp lo
 * manda aparte, en `displayName`.
 */
export function leerVCard(texto: string, respaldo?: string | null): ContactoCompartido {
  const lineas = desplegar(texto).map(partir).filter((l): l is Linea => l !== null);

  // Las etiquetas propias van en otra línea, unida por el grupo:
  // `item1.TEL:…` y `item1.X-ABLabel:Coliseo`. Así las guarda el iPhone.
  const propias = new Map<string, string>();
  for (const l of lineas) {
    if (l.grupo && l.nombre === "X-ABLABEL" && l.valor) {
      propias.set(l.grupo, l.valor.replace(/^_\$!<(.*)>!\$_$/, "$1"));
    }
  }
  const etiqueta = (l: Linea): string | null => {
    const propia = l.grupo ? propias.get(l.grupo) : undefined;
    if (propia) return ETIQUETAS[propia.toUpperCase()] ?? propia;
    for (const t of tiposDe(l)) {
      if (ETIQUETAS[t]) return ETIQUETAS[t]!;
    }
    const otra = tiposDe(l).find((t) => !SIN_ETIQUETA.has(t) && !t.startsWith("X-"));
    return otra ? otra.charAt(0) + otra.slice(1).toLowerCase() : null;
  };

  const primero = (nombre: string): Linea | undefined => lineas.find((l) => l.nombre === nombre);
  const valorDe = (nombre: string): string | null => {
    const v = primero(nombre)?.valor;
    return v ? texto1(v) : null;
  };

  const nombre = valorDe("FN") ?? nombreDeN(primero("N")?.valor) ?? respaldo?.trim() ?? "";
  const org = primero("ORG")?.valor;
  const negocio = valorDe("X-WA-BIZ-NAME");
  const descripcion = valorDe("X-WA-BIZ-DESCRIPTION");

  return {
    name: nombre || "Sin nombre",
    nickname: valorDe("NICKNAME"),
    phones: lineas.filter((l) => l.nombre === "TEL" && l.valor).map((l) => {
      const waid = l.parametros.get("WAID")?.[0]?.replace(/\D/g, "") || null;
      return { number: texto1(l.valor.replace(/^tel:/i, "")), waId: waid, label: etiqueta(l) };
    }),
    emails: lineas.filter((l) => l.nombre === "EMAIL" && l.valor)
      .map((l) => ({ address: texto1(l.valor), label: etiqueta(l) })),
    organization: org ? partes(org).filter(Boolean).join(" · ") || null : null,
    title: valorDe("TITLE") ?? valorDe("ROLE"),
    urls: lineas.filter((l) => l.nombre === "URL" && l.valor).map((l) => texto1(l.valor)),
    addresses: lineas.filter((l) => l.nombre === "ADR").flatMap((l) => {
      // Apartado, extendida, calle, ciudad, región, código postal, país.
      const t = partes(l.valor).map((p) => p.trim()).filter(Boolean).join(", ");
      return t ? [{ text: t, label: etiqueta(l) }] : [];
    }),
    birthday: cumpleanos(valorDe("BDAY")),
    note: valorDe("NOTE"),
    business: negocio || descripcion ? { name: negocio, description: descripcion } : null,
    photo: foto(primero("PHOTO")),
    vcard: texto.trim(),
  };
}

/**
 * Los contactos de un mensaje guardado, venga del transporte que venga.
 *
 * Cada uno los deja en un sitio distinto: Baileys en `contactMessage.vcard`
 * o en `contactsArrayMessage.contacts[].vcard`; whatsapp-web.js en el cuerpo
 * o en `vCards`; la API oficial, ya separados en `contacts`. En vez de saberse
 * cada ruta, se busca cualquier tarjeta en el mensaje.
 *
 * Lo que va dentro de una cita NO cuenta: un mensaje que responde a un
 * contacto lleva una copia de esa tarjeta, y no es él quien la comparte.
 */
export function contactosDe(crudo: unknown): ContactoCompartido[] {
  const vistas = new Set<string>();
  const encontrados: ContactoCompartido[] = [];

  const tarjetas = (texto: string, respaldo: string | null): void => {
    for (const t of texto.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) ?? []) {
      if (vistas.has(t)) continue;
      vistas.add(t);
      encontrados.push(leerVCard(t, respaldo));
    }
  };

  const recorrer = (nodo: unknown, profundidad: number): void => {
    if (profundidad > 12 || nodo === null || typeof nodo !== "object") {
      if (typeof nodo === "string" && /^\s*BEGIN:VCARD/i.test(nodo)) tarjetas(nodo, null);
      return;
    }
    if (Array.isArray(nodo)) {
      for (const x of nodo) recorrer(x, profundidad + 1);
      return;
    }
    const o = nodo as Record<string, unknown>;
    if (typeof o["vcard"] === "string") {
      tarjetas(o["vcard"], typeof o["displayName"] === "string" ? o["displayName"] : null);
      return;
    }
    const oficial = deLaApiOficial(o);
    if (oficial) {
      encontrados.push(oficial);
      return;
    }
    for (const [clave, valor] of Object.entries(o)) {
      if (CITAS.has(clave)) continue;
      recorrer(valor, profundidad + 1);
    }
  };

  recorrer(crudo, 0);
  return encontrados;
}

/** Dónde viaja la copia de lo citado, en cada transporte. */
const CITAS = new Set(["contextInfo", "quotedMessage", "replyTo", "_data", "context"]);

/** Un contacto de la API oficial de Meta, que ya viene separado y sin vCard. */
function deLaApiOficial(o: Record<string, unknown>): ContactoCompartido | null {
  const n = o["name"] as { formatted_name?: unknown; first_name?: unknown; last_name?: unknown } | undefined;
  if (!n || typeof n !== "object" || typeof n.formatted_name !== "string") return null;
  const lista = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
  const etiqueta = (t: unknown): string | null => {
    if (typeof t !== "string" || !t) return null;
    return ETIQUETAS[t.toUpperCase()] ?? t;
  };
  const org = o["org"] as { company?: string; department?: string; title?: string } | undefined;
  return {
    name: n.formatted_name || "Sin nombre",
    nickname: null,
    phones: lista<{ phone?: string; wa_id?: string; type?: string }>(o["phones"])
      .filter((p) => p.phone || p.wa_id)
      .map((p) => ({
        number: p.phone ?? `+${p.wa_id}`,
        waId: p.wa_id?.replace(/\D/g, "") || null,
        label: etiqueta(p.type),
      })),
    emails: lista<{ email?: string; type?: string }>(o["emails"])
      .filter((e) => e.email).map((e) => ({ address: e.email!, label: etiqueta(e.type) })),
    organization: [org?.company, org?.department].filter(Boolean).join(" · ") || null,
    title: org?.title || null,
    urls: lista<{ url?: string }>(o["urls"]).map((u) => u.url).filter((u): u is string => !!u),
    addresses: lista<Record<string, string | undefined>>(o["addresses"]).flatMap((a) => {
      const t = [a["street"], a["city"], a["state"], a["zip"], a["country"]].filter(Boolean).join(", ");
      return t ? [{ text: t, label: etiqueta(a["type"]) }] : [];
    }),
    birthday: cumpleanos(typeof o["birthday"] === "string" ? o["birthday"] : null),
    note: null,
    business: null,
    photo: null,
    vcard: null,
  };
}

/**
 * Las líneas lógicas de la tarjeta.
 *
 * Una línea larga se parte en varias empezando por un espacio, y en la 2.1 de
 * Android un valor en quoted-printable sigue en la siguiente si acaba en `=`.
 */
function desplegar(texto: string): string[] {
  const fisicas = texto.replace(/\r\n?/g, "\n").split("\n");
  const logicas: string[] = [];
  for (const f of fisicas) {
    const anterior = logicas.length - 1;
    if (anterior >= 0 && /^[ \t]/.test(f)) {
      logicas[anterior] += f.slice(1);
    } else if (anterior >= 0 && /QUOTED-PRINTABLE/i.test(logicas[anterior]!.split(":")[0]!)
      && logicas[anterior]!.endsWith("=")) {
      logicas[anterior] = logicas[anterior]!.slice(0, -1) + f;
    } else {
      logicas.push(f);
    }
  }
  return logicas;
}

function partir(linea: string): Linea | null {
  // Los dos puntos de un parámetro entre comillas no separan el valor.
  let i = -1;
  let comillas = false;
  for (let k = 0; k < linea.length; k++) {
    if (linea[k] === "\"") comillas = !comillas;
    else if (linea[k] === ":" && !comillas) { i = k; break; }
  }
  if (i < 0) return null;
  const [cabeza = "", ...params] = linea.slice(0, i).split(";");
  const punto = cabeza.lastIndexOf(".");
  const parametros = new Map<string, string[]>();
  for (const p of params) {
    const igual = p.indexOf("=");
    // En la 2.1 un tipo va suelto: `TEL;CELL:…`.
    const clave = (igual < 0 ? "TYPE" : p.slice(0, igual)).toUpperCase();
    const valores = (igual < 0 ? p : p.slice(igual + 1)).replace(/^"|"$/g, "").split(",");
    parametros.set(clave, [...(parametros.get(clave) ?? []), ...valores]);
  }
  let valor = linea.slice(i + 1);
  if (parametros.get("ENCODING")?.some((e) => /^quoted-printable$/i.test(e))) {
    valor = deQuotedPrintable(valor, parametros.get("CHARSET")?.[0]);
  }
  return {
    grupo: punto >= 0 ? cabeza.slice(0, punto) : null,
    nombre: cabeza.slice(punto + 1).toUpperCase(),
    parametros,
    valor: valor.trim(),
  };
}

function tiposDe(l: Linea): string[] {
  return (l.parametros.get("TYPE") ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean);
}

function deQuotedPrintable(valor: string, charset = "utf-8"): string {
  const bytes: number[] = [];
  for (let k = 0; k < valor.length; k++) {
    const hex = valor.slice(k + 1, k + 3);
    if (valor[k] === "=" && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      k += 2;
    } else {
      bytes.push(...new TextEncoder().encode(valor[k]!));
    }
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
}

/** Los componentes de un valor compuesto (`N`, `ORG`, `ADR`), separados por `;`. */
function partes(valor: string): string[] {
  return valor.split(/(?<!\\);/).map(texto1);
}

/** Un valor con sus escapes quitados: `\,` `\;` `\n` `\\`. */
function texto1(valor: string): string {
  return valor.replace(/\\([\\,;nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();
}

/** `N:Apellido;Nombre;Segundo;Prefijo;Sufijo`, en el orden en que se dice. */
function nombreDeN(valor: string | undefined): string | null {
  if (!valor) return null;
  const [apellido, nombre, segundo, prefijo, sufijo] = partes(valor);
  const t = [prefijo, nombre, segundo, apellido, sufijo].filter(Boolean).join(" ").trim();
  return t || null;
}

function cumpleanos(valor: string | null): string | null {
  if (!valor) return null;
  const v = valor.trim();
  const completa = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v);
  if (completa) return `${completa[1]}-${completa[2]}-${completa[3]}`;
  const sinAno = /^--(\d{2})-?(\d{2})/.exec(v);
  if (sinAno) return `--${sinAno[1]}-${sinAno[2]}`;
  return null;
}

function foto(l: Linea | undefined): string | null {
  if (!l?.valor) return null;
  if (/^data:image\//i.test(l.valor)) return l.valor.length <= FOTO_MAXIMA ? l.valor : null;
  const codificacion = l.parametros.get("ENCODING")?.[0]?.toUpperCase();
  if (codificacion !== "B" && codificacion !== "BASE64") return null;
  const base64 = l.valor.replace(/\s/g, "");
  if (base64.length > FOTO_MAXIMA || !/^[A-Za-z0-9+/]+=*$/.test(base64)) return null;
  const tipo = (tiposDe(l)[0] ?? "JPEG").toLowerCase().replace("jpg", "jpeg");
  return `data:image/${tipo};base64,${base64}`;
}
