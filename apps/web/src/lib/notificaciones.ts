"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Avisos de mensaje nuevo.
 *
 * Tres decisiones que no son de estilo:
 *
 * 1. **Los ajustes viven en el navegador, no en el servidor.** Querer sonido
 *    en el portátil y silencio en el móvil del trabajo es lo normal, y es como
 *    se comporta WhatsApp de escritorio: cada instalación tiene los suyos.
 *    Guardarlos en la cuenta obligaría a elegir uno para todos los sitios.
 * 2. **El sonido se sintetiza.** Un fichero de audio es un archivo más que
 *    cargar y que mantener, y el de WhatsApp no es nuestro. Dos notas cortas
 *    con la API de audio del navegador pesan cero y suenan igual en todas
 *    partes.
 * 3. **El silencio de una conversación manda sobre todo esto.** Es el de la
 *    cuenta de WhatsApp —el mismo que se ve en el teléfono—, así que lo que
 *    silencias allí no suena aquí, y al revés.
 */

export interface Preferencias {
  /** Que suene al llegar algo. */
  sonido: boolean;
  /** Aviso del sistema, fuera de la pestaña. Necesita permiso del navegador. */
  escritorio: boolean;
  /**
   * Enseñar el texto en el aviso.
   *
   * Apagarlo deja «Mensaje nuevo» a secas. No es un capricho: el aviso aparece
   * encima de lo que haya en la pantalla, y en una reunión compartida eso es
   * enseñar una conversación privada a la sala.
   */
  vistaPrevia: boolean;
  /** El número de pendientes en el título de la pestaña. */
  contadorEnTitulo: boolean;
}

export const PREFERENCIAS_POR_DEFECTO: Preferencias = {
  // Suena, pero no interrumpe: el aviso del sistema se pide, no se impone.
  // Un permiso pedido sin que nadie lo haya buscado se deniega casi siempre, y
  // una vez denegado hay que ir a los ajustes del navegador para volver atrás.
  sonido: true,
  escritorio: false,
  vistaPrevia: true,
  contadorEnTitulo: true,
};

const CLAVE = "omni.notificaciones";

function leer(): Preferencias {
  if (typeof window === "undefined") return PREFERENCIAS_POR_DEFECTO;
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    if (!crudo) return PREFERENCIAS_POR_DEFECTO;
    // Se mezcla con los valores por defecto: así añadir un ajuste nuevo no
    // deja a quien ya tenía preferencias guardadas con el campo sin definir.
    return { ...PREFERENCIAS_POR_DEFECTO, ...JSON.parse(crudo) as Partial<Preferencias> };
  } catch {
    return PREFERENCIAS_POR_DEFECTO;
  }
}

/** Qué dice el navegador sobre los avisos del sistema. */
export type Permiso = "concedido" | "denegado" | "sin-pedir" | "no-disponible";

export function permisoActual(): Permiso {
  if (typeof window === "undefined" || !("Notification" in window)) return "no-disponible";
  const p = Notification.permission;
  return p === "granted" ? "concedido" : p === "denied" ? "denegado" : "sin-pedir";
}

/*
 * Un solo juego de preferencias para toda la página.
 *
 * El panel de ajustes y la lista de conversaciones son dos componentes
 * distintos que necesitan lo MISMO: con un `useState` en cada uno, apagar el
 * sonido en el panel no llegaba a quien lo hace sonar, y el ajuste parecía no
 * funcionar hasta recargar.
 *
 * El `storage` del navegador avisa además a las demás pestañas, que es lo que
 * uno espera al tener el panel abierto dos veces.
 */
let cache: Preferencias | null = null;
const oyentes = new Set<() => void>();

function instantanea(): Preferencias {
  cache ??= leer();
  return cache;
}

function suscribirse(avisar: () => void): () => void {
  oyentes.add(avisar);
  const deOtraPestana = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== CLAVE) return;
    cache = leer();
    for (const o of oyentes) o();
  };
  window.addEventListener("storage", deOtraPestana);
  return () => {
    oyentes.delete(avisar);
    window.removeEventListener("storage", deOtraPestana);
  };
}

function guardar(siguiente: Preferencias): void {
  cache = siguiente;
  try {
    window.localStorage.setItem(CLAVE, JSON.stringify(siguiente));
  } catch { /* modo privado sin almacenamiento: vale para esta sesión */ }
  for (const o of oyentes) o();
}

/**
 * Las preferencias, vivas.
 *
 * En el servidor devuelve las de por defecto: allí no hay `localStorage`, y
 * pintar otra cosa haría que el HTML del servidor y el del navegador no
 * coincidan.
 */
export function usePreferencias(): {
  prefs: Preferencias;
  permiso: Permiso;
  cambiar: (parche: Partial<Preferencias>) => Promise<void>;
} {
  const prefs = useSyncExternalStore(
    suscribirse, instantanea, () => PREFERENCIAS_POR_DEFECTO,
  );
  const [permiso, setPermiso] = useState<Permiso>("no-disponible");

  useEffect(() => { setPermiso(permisoActual()); }, []);

  const cambiar = useCallback(async (parche: Partial<Preferencias>): Promise<void> => {
    let siguiente = { ...instantanea(), ...parche };

    /*
     * Encender el aviso del sistema PIDE el permiso en el mismo gesto.
     *
     * El navegador solo lo concede si la petición nace de un clic, así que
     * tiene que ser aquí. Y si lo deniegan, el ajuste se queda apagado: dejar
     * el interruptor encendido sobre un permiso denegado es prometer avisos
     * que no van a llegar nunca.
     */
    if (parche.escritorio === true && "Notification" in window) {
      const respuesta = Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
      setPermiso(respuesta === "granted" ? "concedido"
        : respuesta === "denied" ? "denegado" : "sin-pedir");
      if (respuesta !== "granted") siguiente = { ...siguiente, escritorio: false };
    }

    guardar(siguiente);
  }, []);

  return { prefs, permiso, cambiar };
}

// ------------------------------------------------------------------- sonido

let contexto: AudioContext | null = null;

/**
 * El contexto de audio, creado tarde y a la primera ocasión.
 *
 * Los navegadores no dejan sonar nada hasta que la persona ha interactuado con
 * la página. Crearlo al cargar lo deja suspendido para siempre; crearlo en el
 * primer clic —cualquiera— lo deja listo para cuando llegue un mensaje, que es
 * justo cuando no hay ningún gesto que aprovechar.
 */
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Constructor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return null;
  contexto ??= new Constructor();
  if (contexto.state === "suspended") void contexto.resume();
  return contexto;
}

export function prepararSonido(): () => void {
  if (typeof window === "undefined") return () => {};
  const una = (): void => {
    audio();
    window.removeEventListener("pointerdown", una);
    window.removeEventListener("keydown", una);
  };
  window.addEventListener("pointerdown", una, { once: true });
  window.addEventListener("keydown", una, { once: true });
  // Devuelve la limpieza, no el oyente: encadenarlo a un `useEffect` llamaría
  // al oyente al desmontar y crearía el contexto de audio justo al irse.
  return () => {
    window.removeEventListener("pointerdown", una);
    window.removeEventListener("keydown", una);
  };
}

/**
 * Dos notas cortas, una subiendo a la otra.
 *
 * Breve y en volumen bajo a propósito: un aviso que suena cincuenta veces al
 * día y dura medio segundo acaba apagado por quien lo oye. El ataque y la
 * caída son suaves porque una onda que empieza y acaba de golpe chasquea.
 */
export function sonar(): void {
  const ctx = audio();
  if (!ctx) return;
  const ahora = ctx.currentTime;
  for (const [i, frecuencia] of [660, 880].entries()) {
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frecuencia;
    const desde = ahora + i * 0.09;
    vol.gain.setValueAtTime(0.0001, desde);
    vol.gain.exponentialRampToValueAtTime(0.09, desde + 0.012);
    vol.gain.exponentialRampToValueAtTime(0.0001, desde + 0.16);
    osc.connect(vol).connect(ctx.destination);
    osc.start(desde);
    osc.stop(desde + 0.18);
  }
}

// ------------------------------------------------------------------- avisos

/** `true` si esa conversación está silenciada AHORA. */
export function silenciado(mutedUntil: string | null | undefined): boolean {
  if (!mutedUntil) return false;
  return new Date(mutedUntil).getTime() > Date.now();
}

export function avisar(
  prefs: Preferencias,
  { titulo, cuerpo, etiqueta, alPulsar }: {
    titulo: string;
    cuerpo: string | null;
    /** Agrupa: un segundo aviso de la misma conversación sustituye al primero. */
    etiqueta: string;
    alPulsar: () => void;
  },
): void {
  if (prefs.sonido) sonar();

  if (!prefs.escritorio || permisoActual() !== "concedido") return;
  /*
   * No se avisa de lo que ya se está viendo.
   *
   * Con la pestaña delante, la conversación sube sola en la lista y el aviso
   * del sistema taparía justo eso. El sonido sí suena: dice que ha llegado
   * algo sin obligar a mirar dónde.
   */
  if (document.visibilityState === "visible") return;

  try {
    const aviso = new Notification(titulo, {
      body: prefs.vistaPrevia ? cuerpo ?? "Mensaje nuevo" : "Mensaje nuevo",
      tag: etiqueta,
      icon: "/icono-192.png",
      silent: true, // El sonido lo ponemos nosotros; dos a la vez es un eco.
    });
    aviso.onclick = () => {
      window.focus();
      alPulsar();
      aviso.close();
    };
  } catch { /* algunos navegadores exigen el service worker: se queda en sonido */ }
}

// ------------------------------------------------------------------- título

/**
 * El número de pendientes en el título de la pestaña.
 *
 * Es el único aviso que se ve con la pestaña de fondo sin pedir permiso a
 * nadie, y el que menos molesta: está ahí si miras y no interrumpe si no.
 */
export function useTituloConPendientes(pendientes: number, activo: boolean): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = activo && pendientes > 0 ? `(${pendientes}) ${base}` : base;
    return () => { document.title = base; };
  }, [pendientes, activo]);
}
