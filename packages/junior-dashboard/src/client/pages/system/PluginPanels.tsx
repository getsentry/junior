import { ArrowRight, Boxes, Sparkles } from "lucide-react";
import { Link } from "react-router";

import { Card } from "../../components/layout/Card";
import { systemPluginPath, type SystemPlugin } from "./SystemPlugins";

/** Render the loaded plugin inventory as launch panels. */
export function PluginPanels(props: { plugins: SystemPlugin[] }) {
  return (
    <section aria-label="Plugins" className="grid gap-3">
      {props.plugins.length ? (
        <div className="grid gap-3">
          {props.plugins.map((plugin) => (
            <PluginPanel key={plugin.name} plugin={plugin} />
          ))}
        </div>
      ) : (
        <Card padding="md">
          <div className="font-mono text-xs text-dashboard-text-muted">
            No plugin inventory has been reported yet.
          </div>
        </Card>
      )}
    </section>
  );
}

function PluginPanel(props: { plugin: SystemPlugin }) {
  const metrics = props.plugin.reports.flatMap(
    (report) => report.metrics ?? [],
  );
  return (
    <Link
      className="group grid min-w-0 gap-4 rounded-lg border border-dashboard-border bg-dashboard-surface-panel/85 p-4 no-underline transition-colors hover:border-cyan-300/20 hover:bg-cyan-300/[0.025] sm:p-5"
      to={systemPluginPath(props.plugin.name)}
    >
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded border border-cyan-300/15 bg-cyan-300/[0.075] text-cyan-200">
            <Boxes aria-hidden="true" size={16} strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <h3 className="m-0 truncate font-display text-lg font-medium text-dashboard-text">
              {props.plugin.displayName}
            </h3>
            <p className="mt-1 mb-0 line-clamp-2 font-mono text-xs leading-relaxed text-dashboard-text-muted">
              {props.plugin.description}
            </p>
          </div>
        </div>
        <ArrowRight
          aria-hidden="true"
          className="mt-1 shrink-0 text-dashboard-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-cyan-200/70"
          size={16}
        />
      </div>

      {metrics.length ? (
        <div
          className={`grid ${
            metrics.length === 1 ? "grid-cols-1" : "grid-cols-2"
          } gap-px overflow-hidden rounded border border-dashboard-border-subtle bg-dashboard-fill-mid`}
        >
          {metrics.slice(0, 2).map((metric) => (
            <div
              className="min-w-0 bg-dashboard-surface-panel px-3 py-2.5"
              key={metric.label}
            >
              <div className="truncate font-display text-lg font-light text-dashboard-text">
                {metric.value}
              </div>
              <div className="mt-1 truncate font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
                {metric.label}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-dashboard-border-row pt-3">
        <PanelFact
          icon={Sparkles}
          label={`${props.plugin.skills.length} skills`}
        />
      </div>
    </Link>
  );
}

function PanelFact(props: { icon: typeof Sparkles; label: string }) {
  const Icon = props.icon;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.08em] text-dashboard-text-muted">
      <Icon aria-hidden="true" size={11} />
      {props.label}
    </span>
  );
}
