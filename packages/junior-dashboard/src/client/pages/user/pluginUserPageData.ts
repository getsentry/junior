import { type PluginUserPageContent } from "@sentry/junior-plugin-api";

export type PluginUserPageRecord = PluginUserPageContent["records"][number];
export type PluginUserPageRecordAction = NonNullable<
  PluginUserPageRecord["actions"]
>[number];
