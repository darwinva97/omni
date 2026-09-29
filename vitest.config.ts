import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
const app = (name: string): string =>
  fileURLToPath(new URL(`./apps/${name}/src/index.ts`, import.meta.url));

/**
 * Los paquetes del workspace se resuelven a su FUENTE durante las pruebas, no
 * a `dist`. Así no hace falta compilar para probar y un fallo se ve en la línea
 * de TypeScript donde está, no en el JavaScript generado.
 */
const alias = {
  "@omni/shared": pkg("shared"),
  "@omni/core": pkg("core"),
  "@omni/channels": pkg("channels"),
  "@omni/platform": pkg("platform"),
  "@omni/db": pkg("db"),
  "@omni/storage": pkg("storage"),
  "@omni/plugins": pkg("plugins"),
  "@omni/engine": app("engine"),
  "@omni/cli": app("cli"),
  "@omni/worker": app("worker"),
  "@omni/sdk": fileURLToPath(new URL("./sdks/ts/src/index.ts", import.meta.url)),
};

const base = { environment: "node" as const };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          ...base,
          name: "unit",
          include: ["packages/*/src/**/*.spec.ts", "apps/*/src/**/*.spec.ts", "sdks/*/src/**/*.spec.ts"],
          exclude: ["**/*.int.spec.ts", "**/*.contract.spec.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          ...base,
          name: "integration",
          include: ["packages/*/src/**/*.int.spec.ts", "apps/*/src/**/*.int.spec.ts", "sdks/*/src/**/*.int.spec.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          ...base,
          name: "contract",
          include: ["packages/*/src/**/*.contract.spec.ts", "apps/*/src/**/*.contract.spec.ts"],
          testTimeout: 30000,
        },
      },
    ],
  },
});
