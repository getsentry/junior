import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { isBriefsEnabled } from "@/chat/briefs/registration";
import { briefsTaskRegistration } from "@/chat/briefs/task";
import { botConfig } from "@/chat/config";
import { distillationTaskRegistration } from "@/chat/distillation/task";

/** Return enabled core tasks alongside installed plugin tasks. */
export function coreTaskRegistrations(): PluginRegistration[] {
  return [
    ...(isBriefsEnabled() ? [briefsTaskRegistration] : []),
    ...(botConfig.contextDistillationEnabled
      ? [distillationTaskRegistration]
      : []),
  ];
}
