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
