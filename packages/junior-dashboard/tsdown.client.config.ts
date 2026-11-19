import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, type Rolldown } from "tsdown";
import {
  DASHBOARD_ASSETS_PATH,
  DASHBOARD_CLIENT_MANIFEST_FILE,
  DASHBOARD_STYLESHEET_NAME,
  type DashboardClientManifest,
  type DashboardShell,
} from "./src/public-assets";

const publicDir = "dist/public";

// The first paint sets Latin text in both faces. Other subsets load only
// when a page shows their characters.
const FIRST_PAINT_FONT =
  /^(?:inter|outfit)-latin-wght-normal-[A-Z0-9]{8}\.woff2$/;

/**
 * Emit each imported image as a content-hashed file and replace the import
 * with its URL under the assets prefix. Rolldown's `asset` loader gives a
 * URL relative to the page, which breaks on nested routes.
 */
function imageAssetPlugin(): Rolldown.Plugin {
  return {
    name: "junior-dashboard-image-assets",
    load(id) {
      if (!/\.(?:png|webp)$/.test(id)) return null;
      const referenceId = this.emitFile({
        type: "asset",
        name: path.basename(id),
        source: readFileSync(id),
      });
      return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
    },
    resolveFileUrl({ fileName }) {
      return JSON.stringify(`${DASHBOARD_ASSETS_PATH}/${fileName}`);
    },
  };
}

/**
 * Give the composer the URL of the editor's lazy chunk. A failed chunk load
 * names no URL in Safari, so the composer cannot learn it from the error,
 * and a retry needs the URL to make the import new.
 */
function editorChunkUrlPlugin(): Rolldown.Plugin {
  const urlModule = path.resolve(
    "src/client/conversations/composer-editor/editorChunkUrl.ts",
  );
  const editorModule = path.resolve(
    "src/client/conversations/composer-editor/ComposerEditor.tsx",
  );
  return {
    name: "junior-dashboard-editor-chunk-url",
    load(id) {
      if (id !== urlModule) return null;
      const referenceId = this.emitFile({ type: "chunk", id: editorModule });
      return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
    },
  };
}

/**
 * Write the client manifest: each UI shell's entry and every file it imports
 * statically, the stylesheet, and the first-paint fonts. The page shell
 * preloads the files of the viewer's shell, so the browser fetches them
 * beside the entry instead of after it.
 */
function clientManifestPlugin(): Rolldown.Plugin {
  return {
    name: "junior-dashboard-client-manifest",
    writeBundle(_options, bundle) {
      const shellFiles = (shell: DashboardShell) => {
        const entry = Object.values(bundle).find(
          (output) =>
            output.type === "chunk" && output.isEntry && output.name === shell,
        )?.fileName;
        if (!entry) throw new Error(`Dashboard ${shell} entry was not built`);
        const imports = new Set<string>();
        const pending = [entry];
        for (let file = pending.pop(); file; file = pending.pop()) {
          const output = bundle[file];
          for (const item of output?.type === "chunk" ? output.imports : []) {
            if (imports.has(item)) continue;
            imports.add(item);
            pending.push(item);
          }
        }
        return { entry, imports: [...imports].sort() };
      };
      // tsup.styles.config.ts writes the stylesheet and fonts first.
      const files = readdirSync(publicDir);
      const stylesheet = files.find((file) =>
        DASHBOARD_STYLESHEET_NAME.test(file),
      );
      if (!stylesheet) {
        throw new Error("Dashboard stylesheet was not built");
      }
      const manifest: DashboardClientManifest = {
        fonts: files.filter((file) => FIRST_PAINT_FONT.test(file)).sort(),
        shells: { classic: shellFiles("classic"), inbox: shellFiles("inbox") },
        stylesheet,
      };
      mkdirSync("dist", { recursive: true });
      writeFileSync(
        path.join("dist", DASHBOARD_CLIENT_MANIFEST_FILE),
        JSON.stringify(manifest),
      );
    },
  };
}

// pnpm injects a copy of @sentry/junior under node_modules/.pnpm, so match
// the package name anywhere in the path.
const WORKSPACE_PACKAGE = /[\\/]@sentry[\\/]junior[\\/]/;

type ChunkingContext = Parameters<Rolldown.CodeSplittingNameFunction>[1];

const SHELL_ENTRIES: Record<DashboardShell, string> = {
  classic: path.resolve("src/classic.ts"),
  inbox: path.resolve("src/inbox.ts"),
};

// The modules that each shell imports statically, for one chunking pass.
// Rolldown reuses its module infos within a pass, so the entry's info keys
// the result.
const shellModules = new WeakMap<object, Record<DashboardShell, Set<string>>>();

function staticModulesOf(entry: string, ctx: ChunkingContext): Set<string> {
  const seen = new Set([entry]);
  const pending = [entry];
  for (let id = pending.pop(); id; id = pending.pop()) {
    for (const imported of ctx.getModuleInfo(id)?.importedIds ?? []) {
      if (seen.has(imported)) continue;
      seen.add(imported);
      pending.push(imported);
    }
  }
  return seen;
}

/**
 * Name a first-load group chunk by the shells that import its module
 * statically. Both shells share the group's chunk only for code that both
 * load first. Code that only one shell loads first gets that shell's chunk,
 * so the other shell does not download it.
 */
function shellGroupName(group: string): Rolldown.CodeSplittingNameFunction {
  return (id, ctx) => {
    const key = ctx.getModuleInfo(SHELL_ENTRIES.inbox);
    if (!key) return group;
    let modules = shellModules.get(key);
    if (!modules) {
      modules = {
        classic: staticModulesOf(SHELL_ENTRIES.classic, ctx),
        inbox: staticModulesOf(SHELL_ENTRIES.inbox, ctx),
      };
      shellModules.set(key, modules);
    }
    const inbox = modules.inbox.has(id);
    if (inbox === modules.classic.has(id)) return group;
    return `${group}-${inbox ? "inbox" : "classic"}`;
  };
}

// Run with `--config-loader unrun`: Node's own loader cannot resolve the
// extensionless imports in ./src/public-assets.
//
// Rolldown, not esbuild: esbuild puts shared code in one chunk per set of
// importing routes, so the first load had about 58 files, many under 1 KB.
// Rolldown keeps code that the entry already loads in the entry.
//
// Each UI shell is its own entry, and the page loads only the viewer's. A
// shell imports the shared startup from src/client.tsx, so the two entries
// share its chunks. `$initial` below covers what either entry imports.
export default defineConfig({
  entry: {
    classic: "src/classic.ts",
    inbox: "src/inbox.ts",
  },
  format: "esm",
  platform: "browser",
  tsconfig: "tsconfig.build.json",
  dts: false,
  outDir: publicDir,
  // tsup.styles.config.ts already cleaned this folder.
  clean: false,
  minify: true,
  // The browser cannot load bare imports, so bundle every dependency.
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  // Fail the build when server-only code (Node builtins, @sentry/node) leaks
  // into the browser bundle. Rolldown reports those imports as unresolved
  // warnings, and the dashboard would fail only at runtime in the browser.
  failOnWarn: true,
  suppressWarnings: /module level directive "use client"/,
  alias: {
    // pnpm injects a separate copy of the plugin API into @sentry/junior.
    // Resolve every import to one copy, so the browser loads it once.
    // unrun rewrites import.meta.resolve as a relative URL, so use require.
    "@sentry/junior-plugin-api": createRequire(import.meta.url).resolve(
      "@sentry/junior-plugin-api",
    ),
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // @sentry/core and @sentry/browser-utils ship one build that keeps its
    // debug logging unless this flag is false.
    __SENTRY_DEBUG__: "false",
  },
  outputOptions: {
    // Deploys change app code far more often than dependencies. Keep the
    // third-party code that the first load needs out of the entries, so its
    // files keep their hashes and stay cached across deploys. `$initial`
    // limits each group to code that an entry imports statically, so lazy
    // pages, grammars, and wasm stay lazy.
    //
    // App code imports single icons and Base UI components by name, so a
    // new import adds modules to the chunk that holds them. Those packages
    // get their own chunks, so a new import does not change `vendor`.
    //
    // Workspace packages are app code and change with each release, so they
    // stay out of `vendor`. They need a group too: without one, routes that
    // share them split into many small first-load chunks.
    codeSplitting: {
      groups: [
        {
          debugName: "vendor-react",
          name: shellGroupName("vendor-react"),
          test: /node_modules[\\/](?:react|react-dom|react-router|scheduler)[\\/]/,
          tags: ["$initial"],
          priority: 2,
        },
        {
          debugName: "vendor-sentry",
          name: shellGroupName("vendor-sentry"),
          test: /node_modules[\\/]@sentry[\\/](?!junior)/,
          tags: ["$initial"],
          priority: 2,
        },
        {
          debugName: "vendor-icons",
          name: shellGroupName("vendor-icons"),
          test: /node_modules[\\/]lucide-react[\\/]/,
          tags: ["$initial"],
          priority: 2,
        },
        {
          debugName: "vendor-ui",
          name: shellGroupName("vendor-ui"),
          test: /node_modules[\\/]@base-ui[\\/]/,
          tags: ["$initial"],
          priority: 2,
        },
        {
          debugName: "vendor",
          name: shellGroupName("vendor"),
          test: (id) =>
            /node_modules[\\/]/.test(id) && !WORKSPACE_PACKAGE.test(id),
          tags: ["$initial"],
          priority: 1,
        },
        {
          // Lowest priority: `vendor` takes zod first. Otherwise this group
          // would pull it in as a dependency of @sentry/junior.
          debugName: "junior",
          name: shellGroupName("junior"),
          test: WORKSPACE_PACKAGE,
          tags: ["$initial"],
          priority: 0,
        },
      ],
    },
    entryFileNames: "[name]-[hash:8].js",
    chunkFileNames: "chunks/[name]-[hash:8].js",
    assetFileNames: "[name]-[hash:8][extname]",
    hashCharacters: "base36",
  },
  plugins: [imageAssetPlugin(), editorChunkUrlPlugin(), clientManifestPlugin()],
});
