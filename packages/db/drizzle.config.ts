import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "postgres://omni@127.0.0.1:5440/omni_dev" },
  casing: "snake_case",
});
