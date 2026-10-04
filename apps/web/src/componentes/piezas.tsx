import { iniciales, tonoDe } from "@/lib/formato";
import {
  IconoAlerta, IconoCanal, IconoCheck, IconoCheckDoble, IconoGrupo,
  IconoPersona, IconoReloj,
} from "./iconos";

/**
 * Avatar de una conversación.
 *
 * WhatsApp enseña la foto; nosotros no la tenemos para todos los contactos, y
 * un hueco gris repetido cincuenta veces deja la lista ilegible. Así que
 * iniciales sobre un tono derivado de la DIRECCIÓN —que no cambia cuando
 * alguien se renombra— y, cuando no hay iniciales que sacar, el icono del tipo
 * de conversación, que al menos distingue un grupo de una persona.
 */
export function Avatar({
  nombre, direccion, kind, tamano = "md", url,
}: {
  nombre: string;
  direccion: string;
  kind: string;
  tamano?: "sm" | "md" | "lg";
  url?: string | null;
}) {
  const medidas = {
    sm: "size-8 text-[11px]",
    md: "size-11 text-sm",
    lg: "size-24 text-2xl",
  }[tamano];
  const iconoMedida = { sm: "size-4", md: "size-5", lg: "size-10" }[tamano];

  if (url) {
    return (
      <img
        src={url}
        alt=""
        className={`${medidas} shrink-0 rounded-full object-cover`}
        loading="lazy"
      />
    );
  }

  const letras = iniciales(nombre);
  const tono = tonoDe(direccion);
  const Icono = kind === "group" ? IconoGrupo : kind === "broadcast" ? IconoCanal : IconoPersona;

  return (
    <span
      aria-hidden
      className={`${medidas} flex shrink-0 items-center justify-center rounded-full font-semibold select-none`}
      style={{
        // Fondo muy claro y texto muy oscuro del MISMO tono: así cualquier
        // color del círculo cromático mantiene el contraste, cosa que una
        // paleta de fondos saturados no garantiza.
        background: `oklch(0.9 0.055 ${tono})`,
        color: `oklch(0.35 0.09 ${tono})`,
      }}
    >
      {letras || <Icono className={iconoMedida} />}
    </span>
  );
}

/**
 * El acuse de un mensaje propio.
 *
 * Es el dato que más se mira de un mensaje enviado y el que contesta a «¿le ha
 * llegado?». Cuatro estados bien distintos: reloj mientras está en la cola, un
 * trazo al salir, dos al entregarse y dos azules al leerse.
 *
 * El color NO es lo único que los separa: el número de trazos cambia también,
 * porque quien no distingue el azul del gris tiene que poder leerlo igual. Y
 * cada uno lleva su `title`, que es lo que lo hace accesible de verdad.
 */
export function Acuse({ estado, className = "" }: { estado: string; className?: string }) {
  if (estado === "failed") {
    return (
      <span title="No se pudo enviar" className={`text-(--color-error) ${className}`}>
        <IconoAlerta className="size-3.5" />
      </span>
    );
  }
  if (estado === "queued" || estado === "enviando") {
    return (
      <span title="En cola" className={`text-(--color-apagado) ${className}`}>
        <IconoReloj className="size-3.5" />
      </span>
    );
  }
  if (estado === "sent") {
    return (
      <span title="Enviado" className={`text-(--color-apagado) ${className}`}>
        <IconoCheck className="size-[1.05rem]" />
      </span>
    );
  }
  if (estado === "read" || estado === "played") {
    return (
      <span
        title={estado === "played" ? "Reproducido" : "Leído"}
        className={`text-(--color-leido) ${className}`}
      >
        <IconoCheckDoble className="size-[1.05rem]" />
      </span>
    );
  }
  return (
    <span title="Entregado" className={`text-(--color-apagado) ${className}`}>
      <IconoCheckDoble className="size-[1.05rem]" />
    </span>
  );
}

/** Píldora de estado de una línea. El texto lleva el significado, no el color. */
export function Estado({ estado }: { estado: string }) {
  const tono: Record<string, string> = {
    connected: "bg-(--color-exito-tenue) text-(--color-exito)",
    connecting: "bg-(--color-aviso-tenue) text-(--color-aviso)",
    "awaiting-link": "bg-(--color-aviso-tenue) text-(--color-aviso)",
    "logged-out": "bg-(--color-error-tenue) text-(--color-error)",
  };
  const etiqueta: Record<string, string> = {
    connected: "conectada",
    connecting: "conectando",
    "awaiting-link": "esperando enlace",
    disconnected: "desconectada",
    "logged-out": "desvinculada",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        tono[estado] ?? "bg-(--color-hundido) text-(--color-tenue)"
      }`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {etiqueta[estado] ?? estado}
    </span>
  );
}

/**
 * Estado vacío.
 *
 * Enseña qué hacer, no «no hay nada»: un panel recién instalado está vacío en
 * todas partes, y es justo cuando más falta hace que explique el siguiente paso.
 */
export function Vacio({
  titulo, children, accion,
}: {
  titulo: string;
  children?: React.ReactNode;
  accion?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-(--color-borde) px-6 py-12 text-center">
      <p className="text-sm font-medium">{titulo}</p>
      {children && (
        <p className="mt-1 max-w-sm text-sm text-(--color-tenue)">{children}</p>
      )}
      {accion && <div className="mt-4">{accion}</div>}
    </div>
  );
}

export function Aviso({
  tono = "aviso", children,
}: {
  tono?: "aviso" | "error";
  children: React.ReactNode;
}) {
  const clases = tono === "error"
    ? "border-(--color-error) bg-(--color-error-tenue) text-(--color-error)"
    : "border-(--color-aviso) bg-(--color-aviso-tenue) text-(--color-aviso)";
  return (
    <div className={`flex gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${clases}`}>
      <IconoAlerta className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Secreto que se muestra UNA vez.
 *
 * Entero y con el aviso por delante, porque no hay segunda oportunidad:
 * truncarlo o no decirlo haría que alguien cerrara la página y perdiera la
 * clave que acaba de crear.
 */
export function SecretoUnaVez({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="rounded-xl border border-(--color-aviso) bg-(--color-aviso-tenue) p-4">
      <p className="text-sm font-semibold text-(--color-aviso)">{etiqueta} — cópialo ahora</p>
      <p className="mt-1 text-xs text-(--color-aviso)">
        No se puede volver a mostrar: en la base solo queda su hash.
      </p>
      <code className="mt-3 block overflow-x-auto rounded-lg bg-(--color-panel) px-3 py-2.5 font-mono text-xs break-all text-(--color-texto)">
        {valor}
      </code>
    </div>
  );
}
