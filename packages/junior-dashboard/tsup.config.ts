import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";

interface EsbuildOnLoadArgs {
  path: string;
}

interface EsbuildOnLoadResult {
  contents: string;
  loader: "ts";
}

interface EsbuildBuild {
  onLoad(
    options: { filter: RegExp },
    callback: (args: EsbuildOnLoadArgs) => EsbuildOnLoadResult,
  ): void;
}

interface EsbuildPlugin {
  name: string;
  setup(build: EsbuildBuild): void;
}

const packageRoot = import.meta.dirname;
const dashboardAssetsPath = path.join(packageRoot, "src", "assets.ts");

/** Read client build output that must be embedded in plugin routes. */
function readBuiltAsset(fileName: string): string {
  const assetPath = path.join(packageRoot, "dist", fileName);
  if (!existsSync(assetPath)) {
    throw new Error(
      `Junior dashboard asset ${fileName} was not built before server bundling`,
    );
  }
  return readFileSync(assetPath, "utf8");
}

/** Inline dashboard browser assets so plugin routes need no Nitro copy hook. */
function dashboardAssetsPlugin(): EsbuildPlugin {
  return {
    name: "junior-dashboard-assets",
    setup(build) {
      build.onLoad({ filter: /(^|[\\/])src[\\/]assets\.ts$/ }, (args) => {
        if (path.resolve(args.path) !== dashboardAssetsPath) {
          return {
            contents: readFileSync(args.path, "utf8"),
            loader: "ts",
          };
        }

        return {
          contents: [
            `export const dashboardClientAsset = ${JSON.stringify(readBuiltAsset("client.js"))};`,
            `export const dashboardTailwindAsset = ${JSON.stringify(readBuiltAsset("tailwind.css"))};`,
          ].join("\n"),
          loader: "ts",
        };
      });
    },
  };
}

export default defineConfig({
  entry: {
    app: "src/app.ts",
    handler: "src/handler.ts",
    index: "src/index.ts",
    nitro: "src/nitro.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: false,
  outDir: "dist",
  clean: false,
  splitting: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  esbuildPlugins: [dashboardAssetsPlugin()],
  external: [
    "#junior-dashboard/config",
    "@sentry/junior",
    "@sentry/junior-plugin-api",
    "better-auth",
    "hono",
    "nitro",
  ],
});
