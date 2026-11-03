/**
 * Cómo va una llamada, tal como se enseña en el hilo.
 *
 * El transporte avisa de cada paso suelto —oferta, timbre, aceptada, colgada—
 * y lo que importa a quien lee es en qué quedó: «perdida», «rechazada»,
 * «atendida». Esto reduce la secuencia a ese estado, siempre igual en el
 * motor, la API y el panel.
 */
export const callStates = ["ringing", "answered", "ended", "missed", "rejected"] as const;
export type CallState = (typeof callStates)[number];

export interface CallRecord {
  readonly id: string;
  /** Quien llama. En un grupo, quien la empezó. */
  readonly from: string;
  readonly isVideo: boolean;
  readonly isGroup: boolean;
  readonly state: CallState;
  readonly startedAt: number;
  readonly answeredAt: number | null;
  readonly endedAt: number | null;
}

/** Lo que tarda WhatsApp en dar por perdida una llamada que nadie coge, con margen. */
export const TIMBRE_MAXIMO_MS = 75_000;

const FINALES: ReadonlySet<CallState> = new Set(["ended", "missed", "rejected"]);

/**
 * El estado tras un paso del transporte.
 *
 * Un estado final no se mueve: los avisos llegan desordenados, y un `terminate`
 * que llegue después de un rechazo no lo convierte en perdida. `offline` es una
 * oferta que llegó al reconectar, cuando ya no sonaba: nació perdida. Sin
 * `status` —el sandbox, whatsapp-web.js— es una oferta.
 */
export function siguienteEstadoDeLlamada(
  previo: CallState | undefined, status: string | undefined, offline = false,
): CallState {
  if (previo && FINALES.has(previo)) return previo;
  switch (status) {
    case "accept": return "answered";
    case "reject": return "rejected";
    case "timeout": return "missed";
    case "terminate": return previo === "answered" ? "ended" : "missed";
    default:
      if (offline && !previo) return "missed";
      return previo ?? "ringing";
  }
}

/** Si el estado ya no va a cambiar. */
export function llamadaTerminada(state: CallState): boolean {
  return FINALES.has(state);
}

/**
 * Cómo se lee en el hilo y en el adelanto de la lista: «Llamada de voz
 * perdida». Una que sigue sonando se dice como tal; quien la mira puede colgarla.
 */
export function textoDeLlamada(
  call: Pick<CallRecord, "isVideo" | "state" | "startedAt">, ahora = Date.now(),
): string {
  const tipo = call.isVideo ? "Videollamada" : "Llamada de voz";
  switch (call.state) {
    // Si el aviso de cómo acabó no llegó nunca, pasado el timbre fue perdida.
    case "ringing": return ahora - call.startedAt < TIMBRE_MAXIMO_MS ? `${tipo} entrante` : `${tipo} perdida`;
    case "missed": return `${tipo} perdida`;
    case "rejected": return `${tipo} rechazada`;
    case "answered":
    case "ended": return tipo;
  }
}
