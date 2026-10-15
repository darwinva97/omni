/**
 * Iconos del panel.
 *
 * Dibujados, no emojis: un emoji lo pinta cada sistema a su manera, cambia de
 * tamaño y de peso entre Windows y macOS, y no hereda el color del texto. Para
 * algo que acompaña a una etiqueta cincuenta veces por pantalla eso se nota.
 *
 * Todos sobre una rejilla de 24, trazo 1.75, extremos y uniones redondeados, y
 * `currentColor`: así un icono dentro de un botón apagado se apaga con él sin
 * que haya que acordarse.
 *
 * Los acuses son la excepción de peso: se dibujan más finos y se ven a 16px
 * dentro de una burbuja, donde 1.75 los convertiría en un borrón.
 */

type Props = { className?: string; titulo?: string };

function Base({
  children, className = "size-5", titulo, trazo = 1.75,
}: Props & { children: React.ReactNode; trazo?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={trazo}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={titulo ? undefined : true}
      role={titulo ? "img" : undefined}
    >
      {titulo && <title>{titulo}</title>}
      {children}
    </svg>
  );
}

export const IconoBuscar = (p: Props) => (
  <Base {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Base>
);

export const IconoAdjuntar = (p: Props) => (
  <Base {...p}>
    <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3l8-8" />
  </Base>
);

export const IconoMicrofono = (p: Props) => (
  <Base {...p}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
  </Base>
);

export const IconoCamara = (p: Props) => (
  <Base {...p}>
    <rect x="2" y="6" width="13" height="12" rx="2.5" />
    <path d="m15 11 6-3.5v9L15 13z" />
  </Base>
);

export const IconoEnviar = (p: Props) => (
  <Base {...p}><path d="M4 12 20 4l-4 16-4-6-8-2z" /><path d="m12 14 8-10" /></Base>
);

export const IconoVolver = (p: Props) => (
  <Base {...p}><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></Base>
);

export const IconoCerrar = (p: Props) => (
  <Base {...p}><path d="M18 6 6 18M6 6l12 12" /></Base>
);

export const IconoInfo = (p: Props) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8.5v.5" /></Base>
);

export const IconoGrupo = (p: Props) => (
  <Base {...p}>
    <circle cx="9" cy="9" r="3.5" />
    <path d="M2.5 19a6.5 6.5 0 0 1 13 0M16 6.2a3.5 3.5 0 0 1 0 5.6M18.5 19a6.5 6.5 0 0 0-2.2-4.9" />
  </Base>
);

export const IconoPersona = (p: Props) => (
  <Base {...p}><circle cx="12" cy="8.5" r="4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></Base>
);

export const IconoCanal = (p: Props) => (
  <Base {...p}>
    <path d="M4 10v4a1 1 0 0 0 1 1h3l5 4V5L8 9H5a1 1 0 0 0-1 1Z" />
    <path d="M17 9.5a4 4 0 0 1 0 5M19.5 7a7.5 7.5 0 0 1 0 10" />
  </Base>
);

export const IconoDocumento = (p: Props) => (
  <Base {...p}>
    <path d="M6 2.5h7.5L19 8v13.5H6z" /><path d="M13.5 2.5V8H19" /><path d="M9 13h7M9 17h5" />
  </Base>
);

export const IconoImagen = (p: Props) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.5" /><path d="m4 17 5-5 4 4 2.5-2 4.5 4.5" />
  </Base>
);

export const IconoReloj = (p: Props) => (
  <Base {...p} trazo={1.6}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Base>
);

export const IconoAlerta = (p: Props) => (
  <Base {...p}><path d="M12 3.5 21.5 20H2.5z" /><path d="M12 10v4m0 2.5v.5" /></Base>
);

/** Círculo con visto: una conversación resuelta. No es un acuse: va en círculo. */
export const IconoResuelta = (p: Props) => (
  <Base {...p}><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.8-5" /></Base>
);

/** Flecha que vuelve: reabrir lo que estaba resuelto. */
export const IconoReabrir = (p: Props) => (
  <Base {...p}><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" /><path d="M4.5 4.5V9H9" /></Base>
);

/** El pico de un desplegable. */
export const IconoDesplegar = (p: Props) => (
  <Base {...p}><path d="m7 10 5 5 5-5" /></Base>
);

/** Una nota con la esquina doblada: nota interna. */
export const IconoNota = (p: Props) => (
  <Base {...p}>
    <path d="M5 4.5h14v9.5l-5 5.5H5z" /><path d="M14 19.5V14h5" /><path d="M8.5 9h7M8.5 12h4" />
  </Base>
);

/** Candado: lo que no sale de aquí. */
export const IconoCandado = (p: Props) => (
  <Base {...p}><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></Base>
);

/** Un rayo: lo que pasa solo, sin que nadie lo pulse. Automatizaciones. */
export const IconoRayo = (p: Props) => (
  <Base {...p}><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" /></Base>
);

export const IconoLineas = (p: Props) => (
  <Base {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
  </Base>
);

export const IconoLlave = (p: Props) => (
  <Base {...p}>
    <circle cx="8" cy="16" r="4" />
    <path d="m11 13 9-9M17.5 6.5 20 9M15 9l2.5 2.5" />
  </Base>
);

export const IconoEntregas = (p: Props) => (
  <Base {...p}><path d="M3 7.5h12.5M3 12h9M3 16.5h12.5" /><path d="m17 9 4 3-4 3" /></Base>
);

export const IconoBitacora = (p: Props) => (
  <Base {...p}>
    <path d="M5 3.5h11.5L20 7v13.5H5z" /><path d="M9 9h7M9 13h7M9 17h4" />
  </Base>
);

export const IconoSalir = (p: Props) => (
  <Base {...p}><path d="M14 20H6V4h8" /><path d="M11 12h10m0 0-3.5-3.5M21 12l-3.5 3.5" /></Base>
);

export const IconoSilenciar = (p: Props) => (
  <Base {...p}>
    <path d="M4 10v4a1 1 0 0 0 1 1h3l5 4V5L8 9H5a1 1 0 0 0-1 1Z" />
    <path d="m17 10 4 4m0-4-4 4" />
  </Base>
);

export const IconoArchivar = (p: Props) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
    <path d="M5 8.5V20h14V8.5M10 13h4" />
  </Base>
);

export const IconoBloquear = (p: Props) => (
  <Base {...p}><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></Base>
);

/** Tres puntos: «hay más opciones aquí». Dibujado, no el glifo `⋮`. */
export const IconoMas = (p: Props) => (
  <Base {...p}>
    <circle cx="12" cy="5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.1" fill="currentColor" stroke="none" />
  </Base>
);

/**
 * Stickers.
 *
 * Dibujado y no la carita `🙂`: ese emoji lo pinta cada sistema a su manera y
 * en un navegador sin fuente de emoji sale un cuadro vacío. Se vio en una
 * captura de móvil, que es donde más duele.
 */
export const IconoSticker = (p: Props) => (
  <Base {...p}>
    <path d="M21 12a9 9 0 1 0-9 9c1 0 4-3 6-5s3-3 3-4Z" />
    <path d="M12 21c0-3 1-5 4-5.5M9 10v.5M15 10v.5M9.5 14.5a3.5 3.5 0 0 0 4 .5" />
  </Base>
);

/**
 * Estados: el anillo partido que WhatsApp pone alrededor de quien publicó.
 * El megáfono queda para los canales, que es lo que son: difusión.
 */
export const IconoEstados = (p: Props) => (
  <Base {...p}>
    <path d="M12 3a9 9 0 0 1 6.4 2.6M20.6 9.2a9 9 0 0 1-.2 6.2M17.6 19.1A9 9 0 0 1 12 21M6.4 19.1a9 9 0 0 1-3-4.3M3.1 9.6A9 9 0 0 1 7.6 4.2" />
    <circle cx="12" cy="12" r="3.5" />
  </Base>
);

/** Campana: los avisos. La rayada es «no me avises». */
export const IconoCampana = (p: Props) => (
  <Base {...p}>
    <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </Base>
);

export const IconoCampanaTachada = (p: Props) => (
  <Base {...p}>
    <path d="M8.5 5.2A6 6 0 0 1 18 9c0 4 1.5 5.5 2 6.5H9" />
    <path d="M5.5 9A6 6 0 0 1 6 6.5M6 9c0 4-1.5 5.5-2 6.5h2" />
    <path d="M10 19a2 2 0 0 0 4 0M3.5 3.5l17 17" />
  </Base>
);

/** Altavoz con ondas: el sonido. */
export const IconoSonido = (p: Props) => (
  <Base {...p}>
    <path d="M4 10v4a1 1 0 0 0 1 1h3l5 4V5L8 9H5a1 1 0 0 0-1 1Z" />
    <path d="M16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10" />
  </Base>
);

/** Un chincheta: la conversación fijada arriba. */
export const IconoFijar = (p: Props) => (
  <Base {...p}>
    <path d="M9 3h6l-1 6 3.5 3.5H6.5L10 9 9 3Z" /><path d="M12 12.5V21" />
  </Base>
);

export const IconoCopiar = (p: Props) => (
  <Base {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2H8" />
  </Base>
);

export const IconoDescargar = (p: Props) => (
  <Base {...p}><path d="M12 3.5v11m0 0 4-4m-4 4-4-4M4.5 20h15" /></Base>
);

/** Flecha curva a la izquierda: responder. La espejada es reenviar. */
export const IconoResponder = (p: Props) => (
  <Base {...p}><path d="M11 5.5 4 12l7 6.5V15c6 0 8 2.5 9 4.5-.5-7-4.5-9-9-9z" /></Base>
);

export const IconoReenviar = (p: Props) => (
  <Base {...p}><path d="M13 5.5 20 12l-7 6.5V15c-6 0-8 2.5-9 4.5.5-7 4.5-9 9-9z" /></Base>
);

/**
 * Estrella: destacar. Rellena cuando el mensaje YA está destacado, que es como
 * se distingue en el menú y junto a la hora sin leer ninguna palabra.
 */
export const IconoEstrella = ({ relleno = false, ...p }: Props & { relleno?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    fill={relleno ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={p.className ?? "size-5"}
    aria-hidden={p.titulo ? undefined : true}
    role={p.titulo ? "img" : undefined}
  >
    {p.titulo && <title>{p.titulo}</title>}
    <path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
  </svg>
);

/** Bocadillo con una barra: las respuestas rápidas, que se piden con «/». */
export const IconoRespuestas = (p: Props) => (
  <Base {...p}>
    <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9.5A1.5 1.5 0 0 1 19 17h-8.5L6 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5Z" />
    <path d="m13.5 7.5-3 6.5" />
  </Base>
);

/** Lápiz: editar lo ya enviado. */
export const IconoEditar = (p: Props) => (
  <Base {...p}>
    <path d="M14.5 5.5 18.5 9.5M4 20l1-4.5L15.8 4.7a1.9 1.9 0 0 1 2.7 0l.8.8a1.9 1.9 0 0 1 0 2.7L8.5 19z" />
  </Base>
);

export const IconoPapelera = (p: Props) => (
  <Base {...p}>
    <path d="M4 6.5h16M9 6.5V4h6v2.5M6.5 6.5 7.5 21h9l1-14.5" /><path d="M10.5 10.5v6M13.5 10.5v6" />
  </Base>
);

/**
 * Los acuses de entrega.
 *
 * Es la información que más se mira de un mensaje propio y la que más fácil es
 * estropear: un solo trazo, dos trazos, dos trazos azules. Se dibujan con el
 * mismo ángulo y la misma separación que la gente ya reconoce, y el color lo
 * pone quien los usa, no el icono.
 */
export const IconoCheck = ({ className = "size-4" }: Props) => (
  <svg viewBox="0 0 18 12" fill="none" stroke="currentColor" strokeWidth={1.6}
       strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M2 6.5 5.5 10 13 2" />
  </svg>
);

export const IconoCheckDoble = ({ className = "size-4" }: Props) => (
  <svg viewBox="0 0 18 12" fill="none" stroke="currentColor" strokeWidth={1.6}
       strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M1 6.5 4.5 10 11.5 2" />
    <path d="M7.5 9.2 8.7 10.4 16.5 2" />
  </svg>
);
