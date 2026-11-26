/** Plugin operational and profile reports. */
import type {
  PluginReadState,
  PluginOperationalReport,
  PluginOperationalReportContent,
  PluginOperationalTone,
  User,
} from "@sentry/junior-plugin-api";
import { createPluginConversationEventStats } from "@/chat/plugins/conversation-event-stats";
import { createPluginLogger } from "@/chat/plugins/logging";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { runPluginHooksAtOnce } from "@/chat/plugins/hook-runner";
import { createPluginState } from "@/chat/plugins/state";
import { getRegistrations } from "./registry";

const OPERATIONAL_REPORT_MAX_METRICS = 8;
const OPERATIONAL_REPORT_MAX_WIDGETS = 12;
const OPERATIONAL_REPORT_MAX_CHART_SERIES = 8;
const OPERATIONAL_REPORT_MAX_CHART_CATEGORIES = 100;
const OPERATIONAL_REPORT_MAX_RECORD_SETS = 8;
const OPERATIONAL_REPORT_MAX_FIELDS = 8;
const OPERATIONAL_REPORT_MAX_RECORDS = 25;
const OPERATIONAL_REPORT_MAX_LABEL_LENGTH = 80;
const OPERATIONAL_REPORT_MAX_VALUE_LENGTH = 160;

function pluginReadState(state: { get: PluginReadState["get"] }) {
  return {
    get: state.get,
  } satisfies PluginReadState;
}

function operationalReportText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function operationalReportTone(
  tone: PluginOperationalTone | undefined,
): PluginOperationalTone | undefined {
  return tone === "danger" ||
    tone === "good" ||
    tone === "neutral" ||
    tone === "warning"
    ? tone
    : undefined;
}

function sanitizeOperationalReport(args: {
  pluginName: string;
  report: PluginOperationalReportContent;
}): PluginOperationalReport {
  const metrics = args.report.metrics
    ?.slice(0, OPERATIONAL_REPORT_MAX_METRICS)
    .map((metric) => {
      const label = operationalReportText(
        metric.label,
        OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
      );
      const value = operationalReportText(
        metric.value,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (!label || !value) {
        return undefined;
      }
      const sanitizedMetric: NonNullable<
        PluginOperationalReport["metrics"]
      >[number] = { label, value };
      const tone = operationalReportTone(metric.tone);
      if (tone) {
        sanitizedMetric.tone = tone;
      }
      return sanitizedMetric;
    })
    .filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));
  const recordSets = args.report.recordSets
    ?.slice(0, OPERATIONAL_REPORT_MAX_RECORD_SETS)
    .map((recordSet, recordSetIndex) => {
      const title = operationalReportText(
        recordSet.title,
        OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
      );
      if (!title) {
        return undefined;
      }
      const fields = recordSet.fields
        ?.slice(0, OPERATIONAL_REPORT_MAX_FIELDS)
        .map((field) => {
          const key = operationalReportText(
            field.key,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          const label = operationalReportText(
            field.label,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          return key && label ? { key, label } : undefined;
        })
        .filter((field): field is NonNullable<typeof field> => Boolean(field));
      const records = recordSet.records
        ?.slice(0, OPERATIONAL_REPORT_MAX_RECORDS)
        .map((record, recordIndex) => {
          const id =
            operationalReportText(
              record.id,
              OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
            ) ?? `${recordSetIndex}:${recordIndex}`;
          const values = Object.fromEntries(
            (fields ?? []).map((field) => [
              field.key,
              operationalReportText(
                record.values[field.key],
                OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
              ) ?? "",
            ]),
          );
          const sanitizedRecord: NonNullable<
            NonNullable<
              PluginOperationalReport["recordSets"]
            >[number]["records"]
          >[number] = {
            id,
            values,
          };
          const tone = operationalReportTone(record.tone);
          if (tone) {
            sanitizedRecord.tone = tone;
          }
          return sanitizedRecord;
        });
      const sanitizedRecordSet: NonNullable<
        PluginOperationalReport["recordSets"]
      >[number] = { title };
      if (fields?.length) {
        sanitizedRecordSet.fields = fields;
      }
      const emptyText = operationalReportText(
        recordSet.emptyText,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (emptyText) {
        sanitizedRecordSet.emptyText = emptyText;
      }
      if (records?.length) {
        sanitizedRecordSet.records = records;
      }
      return sanitizedRecordSet;
    })
    .filter((recordSet): recordSet is NonNullable<typeof recordSet> =>
      Boolean(recordSet),
    );
  const widgets = args.report.widgets
    ?.slice(0, OPERATIONAL_REPORT_MAX_WIDGETS)
    .map((widget, widgetIndex) => {
      const id =
        operationalReportText(widget.id, OPERATIONAL_REPORT_MAX_LABEL_LENGTH) ??
        String(widgetIndex);
      const title = operationalReportText(
        widget.title,
        OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
      );
      if (!title) {
        return undefined;
      }
      const seriesEntries = widget.series
        .slice(0, OPERATIONAL_REPORT_MAX_CHART_SERIES)
        .map((item) => {
          const key = operationalReportText(
            item.key,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          const label = operationalReportText(
            item.label,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          if (!key || !label) {
            return undefined;
          }
          const sanitizedSeries: NonNullable<
            PluginOperationalReport["widgets"]
          >[number]["series"][number] = { key, label };
          if (item.format === "usd") {
            sanitizedSeries.format = "usd";
          }
          const tone = operationalReportTone(item.tone);
          if (tone) {
            sanitizedSeries.tone = tone;
          }
          return { sanitizedSeries, sourceKey: item.key };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (!seriesEntries.length) {
        return undefined;
      }
      const series = seriesEntries.map((item) => item.sanitizedSeries);
      const categories = widget.categories
        .slice(-OPERATIONAL_REPORT_MAX_CHART_CATEGORIES)
        .map((category, categoryIndex) => ({
          id:
            operationalReportText(
              category.id,
              OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
            ) ?? `${widgetIndex}:${categoryIndex}`,
          label:
            operationalReportText(
              category.label,
              OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
            ) ?? String(categoryIndex + 1),
          values: Object.fromEntries(
            seriesEntries.map(({ sanitizedSeries, sourceKey }) => {
              const value = category.values[sourceKey];
              return [
                sanitizedSeries.key,
                value !== undefined && Number.isFinite(value) ? value : 0,
              ];
            }),
          ),
        }));
      const sanitizedWidget: NonNullable<
        PluginOperationalReport["widgets"]
      >[number] = {
        categories,
        id,
        series,
        title,
        type: "bar_chart",
      };
      const description = operationalReportText(
        widget.description,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (description) {
        sanitizedWidget.description = description;
      }
      const emptyText = operationalReportText(
        widget.emptyText,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (emptyText) {
        sanitizedWidget.emptyText = emptyText;
      }
      const timeRangeDays = widget.timeRangeDays?.filter(
        (days): days is 1 | 7 | 30 | 90 =>
          days === 1 || days === 7 || days === 30 || days === 90,
      );
      if (timeRangeDays?.length) {
        sanitizedWidget.timeRangeDays = [...new Set(timeRangeDays)];
      }
      return sanitizedWidget;
    })
    .filter((widget): widget is NonNullable<typeof widget> => Boolean(widget));

  const sanitized: PluginOperationalReport = {
    pluginName: args.pluginName,
  };
  const generatedAt = operationalReportText(
    args.report.generatedAt,
    OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
  );
  if (generatedAt) {
    sanitized.generatedAt = generatedAt;
  }
  if (recordSets?.length) {
    sanitized.recordSets = recordSets;
  }
  if (metrics?.length) {
    sanitized.metrics = metrics;
  }
  if (widgets?.length) {
    sanitized.widgets = widgets;
  }
  const title = operationalReportText(
    args.report.title,
    OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
  );
  if (title) {
    sanitized.title = title;
  }
  return sanitized;
}

function failedOperationalReport(args: {
  nowMs: number;
  pluginName: string;
}): PluginOperationalReport {
  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    pluginName: args.pluginName,
    metrics: [{ label: "report", tone: "danger", value: "failed" }],
    title: args.pluginName,
    recordSets: [
      {
        emptyText: "This plugin report failed to load.",
        title: "Error",
      },
    ],
  };
}

/** Collect read-only operational summaries exposed by plugins. */
export async function getPluginOperationalReports(
  nowMs: number,
): Promise<PluginOperationalReport[]> {
  const reports: PluginOperationalReport[] = [];
  const outcomes = await runPluginHooksAtOnce(getRegistrations(), (plugin) => {
    const hook = plugin.hooks?.operationalReport;
    return (
      hook &&
      (() =>
        hook({
          ...basePluginContext(plugin),
          eventStats: createPluginConversationEventStats(plugin, () => nowMs),
          nowMs,
          state: pluginReadState(createPluginState(plugin.manifest.name)),
        }))
    );
  });
  for (const outcome of outcomes) {
    const pluginName = outcome.plugin.manifest.name;
    try {
      if ("error" in outcome) throw outcome.error;
      const report = outcome.value;
      if (!report) {
        continue;
      }
      reports.push(
        sanitizeOperationalReport({
          pluginName,
          report,
        }),
      );
    } catch (error) {
      const log = createPluginLogger(pluginName);
      log.error("Plugin operational report failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      reports.push(failedOperationalReport({ nowMs, pluginName }));
    }
  }
  return reports;
}

/** Collect person-scoped plugin reports for one profile subject. */
export async function getPluginProfileReports(args: {
  nowMs: number;
  subject: User;
  viewer: User;
}): Promise<PluginOperationalReport[]> {
  const reports: PluginOperationalReport[] = [];
  const outcomes = await runPluginHooksAtOnce(getRegistrations(), (plugin) => {
    const hook = plugin.hooks?.profileReport;
    return (
      hook &&
      (() =>
        hook({
          ...basePluginContext(plugin),
          nowMs: args.nowMs,
          state: pluginReadState(createPluginState(plugin.manifest.name)),
          subject: args.subject,
          viewer: args.viewer,
        }))
    );
  });
  for (const outcome of outcomes) {
    const pluginName = outcome.plugin.manifest.name;
    try {
      if ("error" in outcome) throw outcome.error;
      const report = outcome.value;
      if (!report) {
        continue;
      }
      reports.push(
        sanitizeOperationalReport({
          pluginName,
          report,
        }),
      );
    } catch (error) {
      const log = createPluginLogger(pluginName);
      log.error("Plugin profile report failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep profile usable when one plugin fails; skip the failed card.
    }
  }
  return reports;
}
