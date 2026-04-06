/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
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
  ],
  options: {
    doNotFollow: {
      path: "^node_modules",
    },
    includeOnly: "^src/chat",
    moduleSystems: ["es6"],
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
