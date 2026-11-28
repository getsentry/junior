import fs from "node:fs";

// The files outside the composition roots that import the app context today.
// `baseline-growth:check` lets the list only shrink, and the
// `app-context-importers-current` rule fails on a stale entry.
const APP_CONTEXT_IMPORTERS_PATH =
  "scripts/app-context-importers-baseline.json";
const appContextImporters = JSON.parse(
  fs.readFileSync(new URL(APP_CONTEXT_IMPORTERS_PATH, import.meta.url), "utf8"),
);
const missingImporters = appContextImporters.filter(
  (file) => !fs.existsSync(new URL(file, import.meta.url)),
);
if (missingImporters.length > 0) {
  throw new Error(
    `${APP_CONTEXT_IMPORTERS_PATH} lists files that do not exist: ${missingImporters.join(", ")}. Delete these entries.`,
  );
}
const appContextImporterPaths = appContextImporters.map(
  (file) => `^${file.replaceAll(".", "\\.")}$`,
);

/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "app-context-only-in-composition-roots",
      comment:
        "Only composition roots import the app context module: createApp in src/app.ts and the CLI commands in src/cli/. Other code gets the context, or a Pick of it, from its caller. A type-only leaf module, such as src/app/context-types.ts, may import it to give other code its types. See policies/interface-design.md.",
      severity: "error",
      from: {
        path: "^src/",
        pathNot: [
          "^src/(app|app/context-types)\\.ts$",
          "^src/cli/",
          ...appContextImporterPaths,
        ],
      },
      to: {
        path: "^src/app/context\\.ts$",
      },
    },
    {
      name: "no-chat-app-imports-outside-app",
      comment: "Only chat composition roots may depend on app/ modules.",
      severity: "error",
      from: {
        path: "^src/chat/",
        pathNot: "^src/chat/app/",
      },
      to: {
        path: "^src/chat/app/",
      },
    },
    {
      name: "no-chat-services-to-runtime",
      comment: "Service modules must not depend on runtime orchestration.",
      severity: "error",
      from: {
        path: "^src/chat/services/",
      },
      to: {
        path: "^src/chat/runtime/",
      },
    },
    {
      name: "no-native-runtime-to-providers",
      comment:
        "The native agent runtime and shared services must not depend on provider layers.",
      severity: "error",
      from: {
        path: "^src/chat/(agent|runtime|services)/",
      },
      to: {
        path: "^src/chat/providers/",
      },
    },
    {
      name: "no-chat-services-to-slack",
      comment:
        "Service modules must depend on small injected ports, not Slack infrastructure; Slack timestamp value objects are the only exception.",
      severity: "error",
      from: {
        path: "^src/chat/services/",
      },
      to: {
        path: "^src/chat/slack/",
        pathNot: "^src/chat/slack/timestamp\\.ts$",
      },
    },
    {
      name: "no-inbox-items-to-slack",
      comment:
        "Inbox item code is provider-neutral. App setup injects Slack cards and mentions.",
      severity: "error",
      from: {
        path: "^src/chat/(inbox-items/|tools/inbox-items\\.ts$)",
      },
      to: {
        path: "^src/chat/slack/",
      },
    },
    {
      name: "no-slack-sdk-outside-provider-modules",
      comment:
        "Slack SDK imports must stay in Slack-owned infrastructure or Slack tool modules.",
      severity: "error",
      from: {
        path: "^src/chat/",
        pathNot: "^src/chat/(slack/|tools/slack/)",
      },
      to: {
        path: "^@slack/",
      },
    },
    {
      name: "no-chat-slack-to-runtime",
      comment:
        "Slack modules must own Slack behavior and avoid runtime orchestration imports.",
      severity: "error",
      from: {
        path: "^src/chat/slack/",
      },
      to: {
        path: "^src/chat/runtime/",
      },
    },
    {
      name: "no-chat-state-to-runtime",
      comment: "State modules must not depend on runtime orchestration.",
      severity: "error",
      from: {
        path: "^src/chat/state/",
      },
      to: {
        path: "^src/chat/runtime/",
      },
    },
    {
      name: "no-chat-state-to-services",
      comment: "State modules must not depend on service modules.",
      severity: "error",
      from: {
        path: "^src/chat/state/",
      },
      to: {
        path: "^src/chat/services/",
      },
    },
    {
      name: "no-dynamic-model-imports",
      comment:
        "Import model calls statically from @/chat/core-model, so each call names its operation and records its cost. oxlint checks the imported names, which a dynamic import() hides.",
      severity: "error",
      from: {
        path: "^src/",
        pathNot: "^src/chat/(pi/|core-model\\.ts$|plugins/model\\.ts$)",
      },
      to: {
        path: "^src/chat/pi/(client|sdk)\\.ts$",
        dependencyTypes: ["dynamic-import"],
      },
    },
    {
      name: "config-is-a-leaf",
      comment:
        "Config loads before the rest of the app and runs at import time, so src/config/ may reach only other config files and these small leaf modules. A wider import can load the build or create an import cycle.",
      severity: "error",
      from: {
        path: "^src/config/",
      },
      to: {
        path: "^src/",
        pathNot:
          "^src/(config/|chat/(optional-string|reasoning-level|slack/emoji|pi/gateway-models|pi/sdk)\\.ts$)",
        reachable: true,
      },
    },
  ],
  // An empty `path` list matches every module, so the rule goes away with
  // the last entry.
  required:
    appContextImporterPaths.length === 0
      ? []
      : [
          {
            name: "app-context-importers-current",
            comment: `Each file in ${APP_CONTEXT_IMPORTERS_PATH} must still import src/app/context.ts. When a file stops, delete its entry, so the list only gets shorter.`,
            severity: "error",
            module: {
              path: appContextImporterPaths,
            },
            to: {
              path: "^src/app/context\\.ts$",
            },
          },
        ],
  options: {
    doNotFollow: {
      path: "^node_modules",
    },
    includeOnly: "^src/",
    moduleSystems: ["es6"],
    // Read imports from the TypeScript AST. The default transpiles each file
    // to JavaScript first, which takes about two thirds of the run. The AST
    // also has `import type` edges, so the rules check those too.
    parser: "tsc",
    tsConfig: {
      fileName: "./tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      mainFields: ["types", "module", "main"],
    },
    skipAnalysisNotInRules: true,
  },
};
