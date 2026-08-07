import { Boxes, KeyRound, Sparkles } from "lucide-react";

import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";
import type { SystemPlugin } from "./SystemPlugins";

/** Render non-reporting plugin metadata. */
export function PluginDetails(props: { plugin: SystemPlugin }) {
  return (
    <section aria-labelledby="plugin-details-heading" className="grid gap-3">
      <SectionIntro
        className="px-1"
        eyebrow="Plugin information"
        id="plugin-details-heading"
        title="Details"
      />
      <Card>
        <div className="grid grid-cols-1 gap-px bg-white/[0.055] sm:grid-cols-3">
          <Detail icon={Boxes} label="Identifier" value={props.plugin.name} />
          <Detail
            icon={Sparkles}
            label="Skills"
            value={String(props.plugin.skills.length)}
          />
          <Detail
            icon={KeyRound}
            label="Configuration"
            value={String(props.plugin.configKeys.length)}
          />
        </div>
        <div className="grid gap-5 border-t border-white/[0.06] p-4 sm:p-5 lg:grid-cols-2">
          <CapabilityList
            emptyText="No plugin-provided skills were discovered."
            items={props.plugin.skills.map((skill) => skill.name)}
            title="Skills"
          />
          {props.plugin.configKeys.length ? (
            <div className="lg:col-span-2">
              <CapabilityList
                emptyText=""
                items={props.plugin.configKeys}
                title="Configuration keys"
              />
            </div>
          ) : null}
        </div>
      </Card>
    </section>
  );
}

function Detail(props: { icon: typeof Boxes; label: string; value: string }) {
  const Icon = props.icon;
  return (
    <div className="flex items-center gap-3 bg-dashboard-surface-panel px-4 py-3.5">
      <Icon aria-hidden="true" className="text-cyan-200/60" size={15} />
      <div className="min-w-0">
        <div className="truncate font-display text-base font-medium text-dashboard-text">
          {props.value}
        </div>
        <div className="mt-0.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
          {props.label}
        </div>
      </div>
    </div>
  );
}

function CapabilityList(props: {
  emptyText: string;
  items: string[];
  title: string;
}) {
  return (
    <div>
      <h3 className="m-0 font-mono text-xs font-medium uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.title}
      </h3>
      {props.items.length ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {props.items.map((item) => (
            <span
              className="rounded border border-white/[0.07] bg-black/20 px-2.5 py-1.5 font-mono text-xs text-dashboard-text-muted"
              key={item}
            >
              {item}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          {props.emptyText}
        </p>
      )}
    </div>
  );
}
