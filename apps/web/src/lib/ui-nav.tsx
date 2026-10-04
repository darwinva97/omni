/**
 * Compatibilidad: lo que antes vivía aquí se reparte entre el armazón y los
 * controles. Se mantiene el fichero porque varias pantallas lo importan y
 * cambiar diez importaciones de golpe esconde los errores de verdad entre el
 * ruido del renombrado.
 */
export { Pagina, Rail } from "@/componentes/armazon";
export { Tabla, Campo, Boton, Tarjeta, SecretoUnaVez } from "./ui";
