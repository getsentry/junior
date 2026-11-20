import { defineConfig } from "tsup";
import { DASHBOARD_ASSETS_PATH } from "./src/public-assets";

// esbuild bundles the stylesheet and its fonts. Rolldown builds the scripts
// (tsdown.client.config.ts), but it has no stable CSS bundling yet. This
// build runs first and cleans dist/public, so the script build must not.
export default defineConfig({
  entry: {
    styles: "src/styles.css",
  },
  // Only content-hashed browser files go here. Nitro serves this folder as
  // immutable static assets, so an unhashed file would stay cached forever.
  outDir: "dist/public",
  clean: true,
  minify: true,
  esbuildOptions(options) {
    options.entryNames = "[name]-[hash]";
    // Fonts keep their source name plus a content hash, and their URLs point
    // at the assets prefix.
    options.assetNames = "[name]-[hash]";
    options.publicPath = DASHBOARD_ASSETS_PATH;
    options.loader = { ...options.loader, ".woff2": "file" };
  },
});
