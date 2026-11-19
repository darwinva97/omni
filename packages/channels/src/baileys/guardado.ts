/**
 * Guarda las credenciales de una línea DE UNA EN UNA y agrupando las ráfagas.
 *
 * Baileys toca el almacén de claves varias veces por cada mensaje que descifra
 * —identidad, sesión, pre-clave usada—, y cada toque avisaba de un cambio. El
 * aviso serializaba el almacén ENTERO (unos megas: todas las sesiones de
 * Signal), lo cifraba y lanzaba un UPSERT sin esperar al anterior.
 *
 * Con un goteo de mensajes no se nota. Con una ráfaga —un grupo grande que se
 * despierta, la cola de mensajes pendientes al reconectar— salían cientos de
 * guardados a la vez, cada uno con varias copias del almacén en memoria y
 * esperando turno en el pool de Postgres: el proceso pasaba de 200 MB a más de
 * 2 GB en segundos y el kernel lo mataba (OOMKilled). Mientras tanto el pool,
 * ocupado con esas escrituras, dejaba sin responder a `/health`.
 *
 * Además, varias escrituras en vuelo pueden terminar en cualquier orden, y una
 * foto vieja del almacén podía pisar a una nueva: sesiones que se pierden al
 * reiniciar y que WhatsApp tiene que volver a negociar.
 *
 * Aquí hay como mucho UN guardado en curso y, como mucho, otro pendiente. El
 * pendiente no lleva datos: se serializa en el momento de guardar, así que
 * siempre es la foto más reciente y cien avisos seguidos acaban en una sola
 * escritura.
 */
export class GuardadoAgrupado {
  readonly #guardar: () => Promise<void>;
  readonly #esperaMs: number;
  readonly #alFallar: (error: unknown) => void;

  #sucio = false;
  #enCurso: Promise<void> | null = null;
  #temporizador: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param guardar  serializa el estado ACTUAL y lo persiste.
   * @param esperaMs cuánto se espera a que la ráfaga termine antes de guardar.
   * @param alFallar se avisa del fallo; el cambio sigue pendiente y se reintenta.
   */
  constructor(guardar: () => Promise<void>, esperaMs: number, alFallar: (error: unknown) => void) {
    this.#guardar = guardar;
    this.#esperaMs = esperaMs;
    this.#alFallar = alFallar;
  }

  /** Hay un cambio sin guardar. Barato: se puede llamar en cada toque. */
  marcar(): void {
    this.#sucio = true;
    this.#programar();
  }

  /** Guarda YA lo pendiente y espera a que esté en la base. */
  async vaciar(): Promise<void> {
    this.#cancelarTemporizador();
    // Lo que esté en curso puede ser una foto anterior al último cambio.
    if (this.#enCurso) await this.#enCurso;
    // Si falla, queda pendiente con su reintento programado, como siempre.
    if (this.#sucio) await this.#ciclo();
  }

  #programar(): void {
    // En curso: al terminar mira si quedó sucio y se reprograma él solo.
    if (this.#temporizador || this.#enCurso) return;
    this.#temporizador = setTimeout(() => {
      this.#temporizador = null;
      void this.#ciclo();
    }, this.#esperaMs);
  }

  #cancelarTemporizador(): void {
    if (this.#temporizador) clearTimeout(this.#temporizador);
    this.#temporizador = null;
  }

  #ciclo(): Promise<void> {
    if (this.#enCurso) return this.#enCurso;
    this.#sucio = false;
    this.#enCurso = this.#guardar()
      .catch((error: unknown) => {
        // No se pierde: queda pendiente y se reintenta con el siguiente plazo.
        this.#sucio = true;
        this.#alFallar(error);
      })
      .finally(() => {
        this.#enCurso = null;
        if (this.#sucio) this.#programar();
      });
    return this.#enCurso;
  }
}
