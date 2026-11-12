import path from "node:path";
import type { NextConfig } from "next";

/*
 * `OMNI_STANDALONE=1` construye el servidor autónomo de Next (sólo lo que usa,
 * sin node_modules enteros): para desplegar el panel fuera de la imagen de
 * Docker, en una máquina pequeña. Sin la variable, igual que siempre.
 */
const nextConfig: NextConfig = process.env["OMNI_STANDALONE"]
  ? { output: "standalone", outputFileTracingRoot: path.join(__dirname, "../..") }
  : {};

export default nextConfig;
