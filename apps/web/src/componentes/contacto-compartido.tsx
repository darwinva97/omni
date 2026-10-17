"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { ContactoCompartido } from "@/lib/api";
import { leerTelefono } from "@/lib/telefono";
import { Avatar } from "./piezas";
import {
  IconoAlerta, IconoCerrar, IconoCopiar, IconoCorreo, IconoDescargar, IconoEnlace,
  IconoEnviar, IconoMaletin, IconoNota, IconoPersona, IconoRegalo, IconoTelefono,
  IconoUbicacion,
} from "./iconos";

type Telefono = ContactoCompartido["phones"][number];

/** Dónde abrir el chat de un número que ya se sabe que tiene WhatsApp. */
const destinoDe = (t: Telefono): string | null =>
  t.chat ?? (t.waId ? `${t.waId}@s.whatsapp.net` : null);

/**
 * Un contacto compartido, dentro de la burbuja.
 *
 * Como en WhatsApp: quién es, con su foto, y debajo lo que se hace con él
 * —escribirle o verlo entero—. Antes la burbuja decía «Contacto» y nada más,
 * aunque la tarjeta trajera el número, la empresa y el correo.
 *
 * «Enviar mensaje» lleva al chat que ya hay con esa persona, aunque esté
 * abierto por su LID; si no hay ninguno, abre uno nuevo con su número.
 */
export function TarjetaDeContactos({
  lineId, contactos, propia,
}: {
  lineId: string;
  contactos: ContactoCompartido[];
  /** Si la burbuja es nuestra: cambia el color de la raya que separa los botones. */
  propia: boolean;
}) {
  const router = useRouter();
  const [abierta, setAbierta] = useState(false);
  const [primero] = contactos;
  if (!primero) return null;

  const varios = contactos.length > 1;
  const conWhatsapp = varios ? undefined : primero.phones.find((t) => t.waId);
  const destino = conWhatsapp ? destinoDe(conWhatsapp) : null;
  const subtitulo = varios
    ? `y ${contactos.length - 1} ${contactos.length === 2 ? "contacto" : "contactos"} más`
    : primero.organization ?? primero.phones[0]?.number ?? primero.emails[0]?.address ?? null;
  const raya = propia ? "border-(--color-propio-borde)" : "border-(--color-ajeno-borde)";

  return (
    <div className="-mx-1 min-w-[15rem]">
      <button
        type="button"
        onClick={() => setAbierta(true)}
        className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left transition-colors duration-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
      >
        {varios ? (
          <span className="flex shrink-0 -space-x-3">
            {contactos.slice(0, 3).map((c, i) => (
              <span key={i} className="rounded-full ring-2 ring-(--color-panel)">
                <Avatar nombre={c.name} direccion={c.phones[0]?.number ?? c.name} kind="pn" tamano="sm" url={c.avatarUrl} />
              </span>
            ))}
          </span>
        ) : (
          <Avatar nombre={primero.name} direccion={primero.phones[0]?.number ?? primero.name} kind="pn" url={primero.avatarUrl} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{primero.name}</span>
          {subtitulo && (
            <span className="block truncate text-xs text-(--color-tenue)">{subtitulo}</span>
          )}
        </span>
      </button>

      <div className={`mt-1 flex border-t ${raya} text-sm font-medium text-(--color-acento-fuerte)`}>
        {destino && (
          <button
            type="button"
            onClick={() => router.push(`/lineas/${lineId}/chats/${encodeURIComponent(destino)}`)}
            className={`flex-1 border-r ${raya} py-2 transition-colors duration-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]`}
          >
            {conWhatsapp?.chat ? "Abrir chat" : "Enviar mensaje"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setAbierta(true)}
          className="flex-1 py-2 transition-colors duration-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        >
          {varios ? "Ver todos" : "Ver"}
        </button>
      </div>

      {abierta && (
        <FichaDeContactos lineId={lineId} contactos={contactos} onCerrar={() => setAbierta(false)} />
      )}
    </div>
  );
}

/**
 * Todo lo que traía la tarjeta, sin dejarse nada.
 *
 * Cada dato con lo que se hace con él: el número se copia o se le escribe, el
 * correo se abre, la dirección se busca en el mapa. Y la tarjeta entera se
 * puede guardar como `.vcf`, que es como se pasa a la agenda del ordenador o
 * del teléfono.
 */
function FichaDeContactos({
  lineId, contactos, onCerrar,
}: {
  lineId: string;
  contactos: ContactoCompartido[];
  onCerrar: () => void;
}) {
  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => { if (e.key === "Escape") onCerrar(); };
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, [onCerrar]);

  const tarjetas = contactos.map((c) => c.vcard).filter((v): v is string => Boolean(v));
  const titulo = contactos.length === 1 ? "Contacto" : `${contactos.length} contactos`;

  /*
   * En un portal, fuera de la burbuja: dentro heredaba su ancho máximo y su
   * clic derecho, que abría el menú del mensaje encima de la ficha.
   */
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="flex max-h-[min(40rem,88vh)] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel) text-(--color-texto) shadow-[0_12px_40px_rgba(0,0,0,0.25)]"
      >
        <div className="flex items-center gap-3 border-b border-(--color-borde-sutil) px-4 py-3">
          <IconoPersona className="size-5 shrink-0 text-(--color-tenue)" />
          <h2 className="min-w-0 flex-1 text-sm font-semibold">{titulo}</h2>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
          >
            <IconoCerrar className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 divide-y divide-(--color-borde-sutil) overflow-y-auto">
          {contactos.map((c, i) => <Ficha key={i} lineId={lineId} contacto={c} />)}
        </div>

        {tarjetas.length > 0 && (
          <div className="border-t border-(--color-borde-sutil) px-4 py-3">
            <button
              type="button"
              onClick={() => guardar(tarjetas, contactos.length === 1 ? contactos[0]!.name : "contactos")}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-(--color-borde) py-2 text-sm font-medium transition-colors duration-100 hover:bg-(--color-hundido)"
            >
              <IconoDescargar className="size-4" />
              {contactos.length === 1 ? "Guardar en la agenda (.vcf)" : "Guardar todos (.vcf)"}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Ficha({ lineId, contacto: c }: { lineId: string; contacto: ContactoCompartido }) {
  const cargo = [c.title, c.organization].filter(Boolean).join(" · ");
  return (
    <section className="px-4 py-4">
      <div className="flex flex-col items-center text-center">
        <Avatar nombre={c.name} direccion={c.phones[0]?.number ?? c.name} kind="pn" tamano="lg" url={c.avatarUrl} />
        <h3 className="mt-3 text-base font-semibold wrap-anywhere">{c.name}</h3>
        {c.nickname && <p className="text-xs text-(--color-tenue)">«{c.nickname}»</p>}
        {cargo && <p className="mt-0.5 text-sm text-(--color-tenue) wrap-anywhere">{cargo}</p>}
      </div>

      <ul className="mt-4 space-y-1">
        {c.phones.map((t, i) => <FilaTelefono key={i} lineId={lineId} telefono={t} />)}

        {c.emails.map((e, i) => (
          <Fila key={`e${i}`} icono={<IconoCorreo className="size-4" />} etiqueta={e.label ?? "Correo"}
            copiar={e.address}>
            <a href={`mailto:${e.address}`} className="hover:underline">{e.address}</a>
          </Fila>
        ))}

        {c.urls.map((u, i) => {
          const segura = enlaceSeguro(u);
          return (
            <Fila key={`u${i}`} icono={<IconoEnlace className="size-4" />} etiqueta="Web" copiar={u}>
              {segura
                ? <a href={segura} target="_blank" rel="noopener noreferrer" className="hover:underline">{u}</a>
                : u}
            </Fila>
          );
        })}

        {c.addresses.map((a, i) => (
          <Fila key={`a${i}`} icono={<IconoUbicacion className="size-4" />} etiqueta={a.label ?? "Dirección"}
            copiar={a.text}>
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.text)}`}
              target="_blank" rel="noopener noreferrer" className="hover:underline"
            >
              {a.text}
            </a>
          </Fila>
        ))}

        {c.birthday && (
          <Fila icono={<IconoRegalo className="size-4" />} etiqueta="Cumpleaños">
            {cumpleanos(c.birthday)}
          </Fila>
        )}

        {c.business && (
          <Fila icono={<IconoMaletin className="size-4" />} etiqueta="Cuenta de empresa">
            {c.business.name && <span className="block font-medium">{c.business.name}</span>}
            {c.business.description && (
              <span className="block whitespace-pre-wrap text-(--color-tenue)">{c.business.description}</span>
            )}
          </Fila>
        )}

        {c.note && (
          <Fila icono={<IconoNota className="size-4" />} etiqueta="Nota">
            <span className="whitespace-pre-wrap">{c.note}</span>
          </Fila>
        )}
      </ul>
    </section>
  );
}

type Comprobacion =
  | { tipo: "listo" } | { tipo: "comprobando" } | { tipo: "no-tiene" }
  | { tipo: "error"; motivo: string };

/**
 * Un número, con lo que se puede hacer con él.
 *
 * Si la tarjeta dice que tiene WhatsApp, se le escribe directamente. Si no lo
 * dice —un fijo, o alguien que no lo usa—, se pregunta antes a WhatsApp: abrir
 * un chat con un número sin cuenta es mandar mensajes que no llegan nunca.
 */
function FilaTelefono({ lineId, telefono: t }: { lineId: string; telefono: Telefono }) {
  const router = useRouter();
  const [estado, setEstado] = useState<Comprobacion>({ tipo: "listo" });
  const abrir = (direccion: string): void =>
    router.push(`/lineas/${lineId}/chats/${encodeURIComponent(direccion)}`);

  const comprobarYAbrir = async (): Promise<void> => {
    const lectura = leerTelefono(t.number, null);
    if (!lectura.ok) { setEstado({ tipo: "error", motivo: lectura.motivo }); return; }
    setEstado({ tipo: "comprobando" });
    const r = await fetch(
      `/api/omni/v1/lines/${lineId}/contacts/${encodeURIComponent(lectura.numero)}/exists`,
    ).catch(() => null);
    const cuerpo = r
      ? (await r.json().catch(() => null)) as
          { data?: { exists: boolean; address: string | null }; detail?: string } | null
      : null;
    if (r?.ok && cuerpo?.data) {
      if (!cuerpo.data.exists) { setEstado({ tipo: "no-tiene" }); return; }
      abrir(cuerpo.data.address ?? `${lectura.numero}@s.whatsapp.net`);
      return;
    }
    setEstado({
      tipo: "error",
      motivo: `No se pudo comprobar si tiene WhatsApp: ${
        cuerpo?.detail ?? (r ? `falló (${r.status})` : "no hay conexión con el servidor")
      }.`,
    });
  };

  const destino = destinoDe(t);
  const detalle = t.chat
    ? `Ya tienes un chat${t.knownAs ? ` con ${t.knownAs}` : ""}`
    : t.knownAs ? `En WhatsApp: ${t.knownAs}` : null;

  return (
    <Fila
      icono={<IconoTelefono className="size-4" />}
      etiqueta={t.label ?? "Teléfono"}
      copiar={t.number}
      accion={
        <button
          type="button"
          onClick={() => (destino ? abrir(destino) : void comprobarYAbrir())}
          disabled={estado.tipo === "comprobando"}
          title={destino ? (t.chat ? "Abrir el chat" : "Enviar un mensaje") : "Comprobar si tiene WhatsApp y escribirle"}
          aria-label={destino ? (t.chat ? "Abrir el chat" : "Enviar un mensaje") : "Comprobar si tiene WhatsApp y escribirle"}
          className="flex size-8 items-center justify-center rounded-lg text-(--color-acento-fuerte) hover:bg-(--color-acento-tenue) disabled:cursor-wait disabled:opacity-50"
        >
          <IconoEnviar className="size-4" />
        </button>
      }
    >
      <span className="tabular-nums">{t.number}</span>
      {detalle && <span className="block text-xs text-(--color-tenue)">{detalle}</span>}
      {!t.waId && estado.tipo === "listo" && (
        <span className="block text-xs text-(--color-apagado)">La tarjeta no dice si tiene WhatsApp</span>
      )}
      {estado.tipo === "comprobando" && (
        <span className="block text-xs text-(--color-tenue)">Comprobando si tiene WhatsApp…</span>
      )}
      {(estado.tipo === "no-tiene" || estado.tipo === "error") && (
        <span role="status" className="mt-0.5 flex items-start gap-1 text-xs text-(--color-error)">
          <IconoAlerta className="mt-px size-3.5 shrink-0" />
          {estado.tipo === "no-tiene" ? "Este número no tiene WhatsApp." : estado.motivo}
        </span>
      )}
    </Fila>
  );
}

function Fila({
  icono, etiqueta, children, copiar, accion,
}: {
  icono: React.ReactNode;
  etiqueta: string;
  children: React.ReactNode;
  /** El texto que copia el botón de copiar, si lo lleva. */
  copiar?: string;
  accion?: React.ReactNode;
}) {
  const [copiado, setCopiado] = useState(false);
  useEffect(() => {
    if (!copiado) return;
    const t = setTimeout(() => setCopiado(false), 1500);
    return () => clearTimeout(t);
  }, [copiado]);

  return (
    <li className="group flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-(--color-hundido)">
      <span className="mt-0.5 text-(--color-tenue)">{icono}</span>
      <div className="min-w-0 flex-1 text-sm wrap-anywhere">
        <span className="block text-[11px] text-(--color-tenue)">{etiqueta}</span>
        {children}
      </div>
      {copiar && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(copiar).then(() => setCopiado(true)).catch(() => {});
          }}
          title={copiado ? "Copiado" : "Copiar"}
          aria-label={copiado ? "Copiado" : `Copiar ${etiqueta.toLowerCase()}`}
          className={`flex h-8 shrink-0 items-center justify-center rounded-lg px-2 text-(--color-tenue) transition-opacity duration-100 hover:bg-(--color-panel) hover:text-(--color-texto) focus-visible:opacity-100 ${
            copiado ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          {copiado ? <span className="text-xs font-medium text-(--color-acento-fuerte)">Copiado</span> : <IconoCopiar className="size-4" />}
        </button>
      )}
      {accion}
    </li>
  );
}

/**
 * Solo se enlaza lo que es una web. La tarjeta la escribe cualquiera, y un
 * `javascript:` en un enlace se ejecutaría al pulsarlo dentro del panel.
 */
function enlaceSeguro(url: string): string | null {
  const conEsquema = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(conEsquema);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const MESES = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", timeZone: "UTC" });
const CON_ANO = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** «12 de mayo de 1994», o «12 de mayo» si la tarjeta no trae el año. */
function cumpleanos(valor: string): string {
  const sinAno = /^--(\d{2})-(\d{2})$/.exec(valor);
  if (sinAno) return MESES.format(new Date(Date.UTC(2000, Number(sinAno[1]) - 1, Number(sinAno[2]))));
  const fecha = new Date(`${valor}T00:00:00Z`);
  return Number.isNaN(fecha.getTime()) ? valor : CON_ANO.format(fecha);
}

/** Descarga las tarjetas como un `.vcf`, que es lo que abre cualquier agenda. */
function guardar(tarjetas: string[], nombre: string): void {
  const texto = tarjetas.map((t) => t.replace(/\r?\n/g, "\r\n")).join("\r\n");
  const url = URL.createObjectURL(new Blob([texto + "\r\n"], { type: "text/vcard;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${nombre.replace(/[\\/:*?"<>|]+/g, " ").trim() || "contacto"}.vcf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
