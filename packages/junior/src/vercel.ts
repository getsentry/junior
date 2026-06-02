import { DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC } from "@/chat/task-execution/vercel-queue";

export interface JuniorVercelConfigOptions {
  buildCommand?: string | null;
}

/** Return a minimal Vercel config for scaffolded Junior apps. */
export function juniorVercelConfig(options: JuniorVercelConfigOptions = {}) {
  const buildCommand =
    options.buildCommand === undefined ? "pnpm build" : options.buildCommand;

  const config: Record<string, unknown> = {
    framework: "nitro",
    crons: [
      {
        path: "/api/internal/heartbeat",
        schedule: "* * * * *",
      },
    ],
    functions: {
      "api/internal/agent/continue.ts": {
        maxDuration: 300,
        experimentalTriggers: [
          {
            type: "queue/v2beta",
            topic: DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC,
          },
        ],
      },
    },
  };

  if (buildCommand !== null) {
    config.buildCommand = buildCommand;
  }

  return config;
}
