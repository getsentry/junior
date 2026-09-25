import type { OwnedObjectAnnotation } from "@sentry/junior-plugin-api";
import { objectIconPath, objectPresentation } from "@sentry/junior-plugin-api";
import { ObjectIcon } from "../../components/ObjectIcon";
import { ObjectCard } from "../../conversations/ObjectCard";
import { ConversationSidebarAnnotations } from "../../conversations/ConversationMeta";
import { TranscriptRailEvent } from "../../conversations/TranscriptRailEvent";

const objects: OwnedObjectAnnotation[] = [
  ...(["open", "closed", "warning"] as const).map((status, index) => ({
    kind: "object" as const,
    objectType: "task" as const,
    plugin: "github",
    key: `repo#${index + 1}`,
    label: `repo#${index + 1}`,
    title: "Fix the parser",
    displayType: "Issue",
    status,
    url: `https://github.com/example/repo/issues/${index + 1}`,
  })),
  ...(["open", "draft", "closed", "merged", "warning"] as const).map(
    (status, index) => ({
      kind: "object" as const,
      objectType: "code_change" as const,
      plugin: "github",
      key: `repo#${index + 4}`,
      label: `repo#${index + 4}`,
      title: "Fix the parser",
      displayType: "Pull request",
      status,
      url: `https://github.com/example/repo/pull/${index + 4}`,
    }),
  ),
  {
    kind: "object",
    objectType: "automation",
    plugin: "junior",
    key: "daily-check",
    label: "Daily check",
    title: "Check parser errors",
    trigger: "Every weekday at 09:00 UTC",
    status: "blocked",
    warning: "Reconnect the provider to resume.",
    url: "https://example.com/automations/daily-check",
  },
  {
    kind: "object",
    objectType: "deployment",
    plugin: "vercel",
    key: "deploy-1",
    label: "Production",
    title: "parser.example.com",
    status: "ERROR",
    url: "https://example.com/deploy-1",
    facts: {
      type: "deployment",
      environment: "Production",
      revision: "a1b2c3d",
    },
  },
  {
    kind: "object",
    objectType: "item",
    plugin: "example",
    key: "item-1",
    label: "Reference",
    title: "Parser reference",
    url: "https://example.com/reference",
  },
];

/** Mixed types and states at each production icon size, including Slack assets. */
export function ObjectFixtures() {
  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {objects.map((object) => (
          <div
            key={object.key}
            className="flex items-center gap-3 rounded-lg border border-dashboard-border p-3"
          >
            <ObjectIcon {...object} size={20} />
            <span className="text-sm">
              {object.displayType ?? objectPresentation(object).label} ·{" "}
              {object.status ?? "Unknown"}
            </span>
          </div>
        ))}
      </div>
      <ConversationSidebarAnnotations
        annotations={objects.map((object) => ({
          key: object.key,
          label: object.plugin,
          objectType: object.objectType,
          status: object.status,
        }))}
      />
      <TranscriptRailEvent kind="event" objectType="code_change">
        Pull request checks failed
      </TranscriptRailEvent>
      <TranscriptRailEvent kind="event" objectType="task">
        Issue closed
      </TranscriptRailEvent>
      <div className="flex flex-wrap items-center gap-4">
        {objects.map((object) => (
          <img
            key={object.key}
            src={objectIconPath(objectPresentation(object).icon)}
            alt={`Slack asset: ${object.displayType ?? objectPresentation(object).label}, ${object.status ?? "unknown"}`}
            width={32}
            height={32}
          />
        ))}
        <span className="text-xs text-dashboard-text-muted">
          Slack PNG assets (not a Slack rendering preview)
        </span>
      </div>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
        {[objects[1]!, objects[5]!, ...objects.slice(8)].map((card) => (
          <ObjectCard key={card.key} card={card} />
        ))}
      </div>
    </div>
  );
}
