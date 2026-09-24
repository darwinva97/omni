import { defineConfig } from "vitest/config";

/**
 * Tres proyectos con propósitos distintos:
 *  - unit:        sin red, sin base de datos. Rápido, corre en cada guardado.
 *  - integration: contra Postgres real. Requiere OMNI_TEST_DATABASE_URL.
 *  - contract:    la MISMA batería contra cada driver de canal, para que los
 *                 nueve drivers no diverjan. Es lo que sostiene la abstracción.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.spec.ts", "apps/*/src/**/*.spec.ts"],
          exclude: ["**/*.int.spec.ts", "**/*.contract.spec.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/src/**/*.int.spec.ts", "apps/*/src/**/*.int.spec.ts"],
          environment: "node",
          testTimeout: 30000,
          hookTimeout: 30000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "contract",
          include: ["packages/*/src/**/*.contract.spec.ts", "apps/*/src/**/*.contract.spec.ts"],
          environment: "node",
          testTimeout: 30000,
        },
      },
    ],
  },
});
