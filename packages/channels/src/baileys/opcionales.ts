/**
 * Paquetes que Baileys declara como PARES OPCIONALES y de los que depende de
 * verdad para que ciertos mensajes se vean.
 *
 * Son opcionales para npm, no para WhatsApp. Sin `audio-decode`, Baileys no
 * puede generar la onda de una nota de voz: el mensaje se sube, se cifra, se
 * manda a todos los dispositivos... y no aparece en ningún cliente. El único
 * rastro es una línea de registro en nivel `debug` que dice «Failed to
 * generate waveform», y en `info` no se ve nada.
 *
 * Por eso se comprueban al arrancar y se avisa: un fallo invisible que cuesta
 * una tarde encontrar no puede depender de que alguien mire los registros.
 */

export interface PeerOpcional {
  readonly paquete: string;
  readonly para: string;
}

export const PARES_OPCIONALES: readonly PeerOpcional[] = [
  { paquete: "audio-decode", para: "la onda de las notas de voz; sin ella no se ven" },
  { paquete: "sharp", para: "las miniaturas de imágenes y vídeos" },
];

export interface FaltaOpcional extends PeerOpcional {
  readonly motivo: string;
}

/** Devuelve los que NO se pueden cargar, con el motivo. */
export async function comprobarOpcionales(
  importar: (p: string) => Promise<unknown> = (p) => import(p),
): Promise<FaltaOpcional[]> {
  const faltan: FaltaOpcional[] = [];
  for (const par of PARES_OPCIONALES) {
    try {
      await importar(par.paquete);
    } catch (err) {
      faltan.push({ ...par, motivo: (err as Error).message.split("\n")[0]! });
    }
  }
  return faltan;
}
