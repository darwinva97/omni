/**
 * Un identificador válido para la API (`^[a-z0-9-]+$`, hasta 60) a partir de lo que se escriba.
 *
 * Antes el campo «Identificador» se mandaba tal cual: «Mi Tienda» o «ventas_2» daban 422 y la
 * página entera se caía con «This page couldn't load». Ahora se deduce del nombre si se deja
 * vacío y se arregla si trae mayúsculas, tildes, espacios o guiones bajos.
 */
export function aIdentificador(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}
