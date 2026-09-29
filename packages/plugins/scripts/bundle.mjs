/**
 * Empaqueta el arranque del proceso de un plugin en un solo fichero.
 *
 * Tiene que ser autónomo: con imports relativos, Node lee los `package.json`
 * del árbol para resolverlos y habría que permitir esas lecturas, abriendo al
 * plugin medio repositorio. Un fichero suelto deja la lista de permisos en dos
 * rutas, y eso sí se puede razonar.
 */
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(raiz, "dist/runtime/hijo.js")],
  outfile: resolve(raiz, "dist/plugin-host.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
console.log("arranque de plugins empaquetado");
