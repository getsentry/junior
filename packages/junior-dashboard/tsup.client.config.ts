import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    client: "src/client.tsx",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: false,
  outDir: "dist",
  clean: true,
  splitting: false,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  noExternal: [
    "@tanstack/react-query",
    "react",
    "react-dom",
    "react-router",
    "recharts",
    "lucide-react",
    "shiki",
  ],
});
