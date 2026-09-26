import Link from "next/link";
import { apiFetchAuth, type Linea, type Yo } from "@/lib/api";
import { Cabecera, Estado, Vacio, Aviso } from "@/lib/ui";

export default async function Lineas() {
  const [yo, lineas] = await Promise.all([
    apiFetchAuth<Yo>("/v1/auth/me"),
    apiFetchAuth<Linea[]>("/v1/lines"),
  ]);

  const noOficiales = lineas.filter((l) => l.channelKind.startsWith("whatsapp.") && l.channelKind !== "whatsapp.cloud");

  return (
    <>
      <Cabecera titulo={`${yo.name} · ${yo.role ?? ""}`} />
      <main className="mx-auto max-w-5xl space-y-4 px-5 py-6">
        {noOficiales.length > 0 && (
          <Aviso>
            <strong>{noOficiales.length} línea{noOficiales.length > 1 ? "s" : ""} usa{noOficiales.length > 1 ? "n" : ""} un
            cliente no oficial de WhatsApp.</strong> La cuenta puede ser restringida o baneada.
            Usa números que puedas permitirte perder; para entornos regulados, el transporte oficial.
          </Aviso>
        )}

        <h2 className="text-sm font-medium">Líneas</h2>

        {lineas.length === 0 ? (
          <Vacio>Todavía no hay líneas. Se crean desde la API o con <code>omni linea:crear</code>.</Vacio>
        ) : (
          <ul className="divide-y divide-(--color-borde) overflow-hidden rounded-lg border border-(--color-borde) bg-(--color-panel)">
            {lineas.map((l) => (
              <li key={l.id}>
                <Link href={`/lineas/${l.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-(--color-ajeno)">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{l.name}</span>
                    <span className="block truncate text-xs text-(--color-tenue)">
                      {l.channelKind} · {l.address ?? "sin número"} · {l.sendRatePerMinute}/min
                    </span>
                  </span>
                  <Estado estado={l.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
