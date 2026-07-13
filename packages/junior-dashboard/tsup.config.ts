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
const dashboardAvatarHeaderPath = path.join(
  packageRoot,
  "src",
  "assets",
  "junior-avatar-line.png",
);

/** Read client build output that must be embedded in dashboard routes. */
function readBuiltAsset(fileName: string): string {
  const assetPath = path.join(packageRoot, "dist", fileName);
  if (!existsSync(assetPath)) {
    throw new Error(
      `Junior dashboard asset ${fileName} was not built before server bundling`,
    );
  }
  return readFileSync(assetPath, "utf8");
}

/** Inline dashboard browser assets so dashboard routes can serve static assets. */
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
            `export const dashboardAvatarHeaderAsset = ${JSON.stringify(readFileSync(dashboardAvatarHeaderPath).toString("base64"))};`,
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
    index: "src/index.ts",
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
    "@sentry/junior",
    "@sentry/junior/api",
    "@sentry/junior/api/schema",
    "@sentry/junior/instrumentation",
    "better-auth",
    "hono",
  ],
});
