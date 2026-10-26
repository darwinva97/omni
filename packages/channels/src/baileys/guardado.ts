/**
 * Guardar la sesión de WhatsApp sin reescribirla en cada mensaje.
 *
 * Cada mensaje descifrado cambia alguna clave, y antes cada cambio serializaba
 * la sesión ENTERA, la cifraba y la escribía en la base, sin esperar: en un
 * número con muchos grupos son cientos de KB por mensaje, y una escritura vieja
 * podía terminar después de una nueva y pisarla. Ahora los cambios se agrupan
 * (como mucho uno cada `ms`) y se guardan de uno en uno, siempre lo último.
 * `vaciar` guarda ya lo pendiente (al desconectar).
 */
export function guardadoAgrupado(
  serializar: () => Uint8Array,
  guardar: (b: Uint8Array) => Promise<void>,
  ms = 1000,
): { cambio: () => void; vaciar: () => Promise<void> } {
  let pendiente = false;
  let temporizador: ReturnType<typeof setTimeout> | null = null;
  let enCurso: Promise<void> = Promise.resolve();

  const escribir = (): Promise<void> => {
    temporizador = null;
    if (!pendiente) return enCurso;
    pendiente = false;
    // Se serializa al escribir, no al cambiar: así va siempre lo último.
    enCurso = enCurso.then(() => guardar(serializar())).catch(() => {});
    return enCurso;
  };

  return {
    cambio() {
      pendiente = true;
      if (!temporizador) temporizador = setTimeout(() => void escribir(), ms);
    },
    async vaciar() {
      if (temporizador) clearTimeout(temporizador);
      await escribir();
    },
  };
}
