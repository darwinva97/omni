import QRCode from "qrcode";

/**
 * El QR de enlace, pintado como QR de verdad.
 *
 * Antes se enseñaba la cadena cruda, y con eso no se puede enlazar nada: el
 * teléfono necesita ESCANEAR un código, no leer un texto. Era la razón por la
 * que una línea de WhatsApp no se podía poner en marcha desde el panel.
 *
 * Se dibuja en el servidor y se manda como SVG: no hace falta mandar al
 * navegador una biblioteca de QR para pintar una imagen que ya está decidida.
 */
export async function Qr({ valor }: { valor: string }) {
  const svg = await QRCode.toString(valor, {
    type: "svg",
    margin: 1,
    // Nivel medio: el QR de WhatsApp caduca en segundos y se regenera solo, así
    // que no hace falta la corrección de errores más alta, que lo haría más
    // denso y más difícil de leer en una pantalla pequeña.
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });

  return (
    <div className="mt-3 inline-block rounded-lg bg-white p-3">
      {/*
        El SVG lo genera `qrcode` a partir de una cadena que viene de nuestra
        propia API, no de una entrada de usuario.
      */}
      <div
        className="h-56 w-56 [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
