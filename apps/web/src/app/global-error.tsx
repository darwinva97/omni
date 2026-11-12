"use client";

/** Si falla hasta el armazón del panel. Sin estilos de la app: tiene que valer solo. */
export default function ErrorGlobal({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100dvh", margin: 0, background: "#f3f4f6", color: "#111" }}>
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center", background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb" }}>
          <p style={{ fontWeight: 600, margin: 0 }}>No se pudo cargar el panel</p>
          <p style={{ fontSize: 14, color: "#555" }}>Vuelve a intentarlo en unos segundos.</p>
          <button type="button" onClick={reset} style={{ padding: "8px 16px", borderRadius: 8, border: 0, background: "#0d9488", color: "#fff", cursor: "pointer" }}>
            Reintentar
          </button>
          {error.digest && <p style={{ fontSize: 11, color: "#999" }}>Código: {error.digest}</p>}
        </div>
      </body>
    </html>
  );
}
