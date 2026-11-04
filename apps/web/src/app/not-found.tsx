import Link from "next/link";

/** Una línea borrada, un enlace viejo o una dirección mal copiada: dice eso, con salida. */
export default function NoEncontrado() {
  return (
    <div className="flex h-full min-h-[60dvh] items-center justify-center bg-(--color-lienzo) px-6 py-10">
      <div className="w-full max-w-md rounded-2xl border border-(--color-borde) bg-(--color-panel) p-6 text-center">
        <p className="text-base font-semibold">Esto ya no existe</p>
        <p className="mt-2 text-sm text-(--color-tenue)">
          La línea o la conversación se borró, o el enlace es antiguo.
        </p>
        <Link href="/" className="mt-5 inline-block rounded-lg bg-(--color-acento) px-4 py-2 text-sm font-medium text-(--color-sobre-acento) hover:opacity-90">
          Ir a mis líneas
        </Link>
      </div>
    </div>
  );
}
