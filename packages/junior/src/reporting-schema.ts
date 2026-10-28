import { z } from "zod";

export const healthReportSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string(),
    timestamp: z.string(),
  })
  .strict();

export const pluginSchema = z
  .object({
    configKeys: z.array(z.string()),
    description: z.string(),
    displayName: z.string(),
    name: z.string(),
  })
  .strict();
export const pluginsSchema = z.array(pluginSchema);

export const skillReportSchema = z
  .object({
    name: z.string(),
    pluginProvider: z.string().optional(),
  })
  .strict();
export const skillReportsSchema = z.array(skillReportSchema);

export const pluginPackageContentItemReportSchema = z
  .object({
    dir: z.string(),
    hasMigrationsDir: z.boolean(),
    hasSkillsDir: z.boolean(),
    packageName: z.string(),
  })
  .strict();

export const pluginPackageContentReportSchema = z
  .object({
    packageNames: z.array(z.string()),
    packages: z.array(pluginPackageContentItemReportSchema),
    manifestRoots: z.array(z.string()),
    skillRoots: z.array(z.string()),
    tracingIncludes: z.array(z.string()),
  })
  .strict();

export const runtimeInfoReportSchema = z
  .object({
    cwd: z.string(),
    homeDir: z.string(),
    descriptionText: z.string().optional(),
    providers: z.array(z.string()),
    skills: z.array(skillReportSchema),
    packagedContent: pluginPackageContentReportSchema,
  })
  .strict();

const pluginOperationalToneSchema = z.enum([
  "danger",
  "good",
  "neutral",
  "warning",
]);

const pluginOperationalMetricSchema = z
  .object({
    label: z.string(),
    tone: pluginOperationalToneSchema.optional(),
    value: z.string(),
  })
  .strict();

const pluginOperationalFieldSchema = z
  .object({
    key: z.string(),
    label: z.string(),
  })
  .strict();

const pluginOperationalRecordSchema = z
  .object({
    id: z.string(),
    tone: pluginOperationalToneSchema.optional(),
    values: z.record(z.string(), z.string()),
  })
  .strict();

const pluginOperationalRecordSetSchema = z
  .object({
    fields: z.array(pluginOperationalFieldSchema).optional(),
    emptyText: z.string().optional(),
    records: z.array(pluginOperationalRecordSchema).optional(),
    title: z.string(),
  })
  .strict();

const pluginOperationalBarChartWidgetSchema = z
  .object({
    categories: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            values: z.record(z.string(), z.number().finite()),
          })
          .strict(),
      )
      .max(100),
    description: z.string().optional(),
    emptyText: z.string().optional(),
    id: z.string().min(1),
    series: z
      .array(
        z
          .object({
            format: z.literal("usd").optional(),
            key: z.string().min(1),
            label: z.string().min(1),
            tone: pluginOperationalToneSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    timeRangeDays: z
      .array(
        z.union([
          z.literal(1),
          z.literal(7),
          z.literal(30),
          z.literal(90),
        ]),
      )
      .min(1)
      .max(4)
      .optional(),
    title: z.string().min(1),
    type: z.literal("bar_chart"),
  })
  .strict();

export const pluginOperationalReportSchema = z
  .object({
    generatedAt: z.string().optional(),
    metrics: z.array(pluginOperationalMetricSchema).optional(),
    recordSets: z.array(pluginOperationalRecordSetSchema).optional(),
    title: z.string().optional(),
    pluginName: z.string(),
    widgets: z.array(pluginOperationalBarChartWidgetSchema).max(12).optional(),
  })
  .strict();

export const pluginOperationalReportFeedSchema = z
  .object({
    generatedAt: z.string(),
    reports: z.array(pluginOperationalReportSchema),
    source: z.literal("plugins"),
  })
  .strict();

export type HealthReport = z.infer<typeof healthReportSchema>;
export type Plugin = z.infer<typeof pluginSchema>;
export type Plugins = z.infer<typeof pluginsSchema>;
export type SkillReport = z.infer<typeof skillReportSchema>;
export type SkillReports = z.infer<typeof skillReportsSchema>;
export type RuntimeInfoReport = z.infer<typeof runtimeInfoReportSchema>;
export type PluginPackageContentItemReport = z.infer<
  typeof pluginPackageContentItemReportSchema
>;
export type PluginPackageContentReport = z.infer<
  typeof pluginPackageContentReportSchema
>;
export type PluginOperationalReport = z.infer<
  typeof pluginOperationalReportSchema
>;
export type PluginOperationalReportFeed = z.infer<
  typeof pluginOperationalReportFeedSchema
>;
