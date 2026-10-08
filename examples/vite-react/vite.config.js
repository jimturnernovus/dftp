// The data-loc Babel plugin is added only while serving (npm run dev), so a
// production build (npm run build) carries no source paths. This example sits
// inside the DFTP folder, so a relative path is safe here; in your own project
// use the guarded form from plugins/README.md (DFTP_PLUGINS), because the DFTP
// folder is somewhere else on every machine.
import { URL, fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataLoc = fileURLToPath(new URL("../../plugins/babel-plugin-data-loc.cjs", import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [
    react(command === "serve" ? { babel: { plugins: [[dataLoc, { root }]] } } : {}),
  ],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
}));
