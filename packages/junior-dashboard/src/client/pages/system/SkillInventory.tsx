import { Boxes, Sparkles } from "lucide-react";
import type { SkillReport } from "@sentry/junior/api/schema";
import { getDashboardAgentName } from "../../agentName";

import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { formatCompactNumber } from "../../format";

type SkillGroup = { pluginProvider?: string; skills: SkillReport[] };

/** Present discovered skills independently from the plugin inventory. */
export function SkillInventory(props: { skills: SkillReport[] }) {
  const groups = groupSkills(props.skills);
  const pluginSkillCount = props.skills.filter(
    (skill) => skill.pluginProvider,
  ).length;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4 max-sm:flex-col">
        <SectionIntro
          description={
            <>
              The task-specific instructions {getDashboardAgentName()}{" "}
              discovered, grouped by their plugin provider when one is
              registered.
            </>
          }
          title="Skills"
        />
        <div className="grid min-w-[12rem] grid-cols-2 overflow-hidden rounded-lg border border-white/[0.07] bg-black/15 max-sm:w-full max-sm:min-w-0">
          <InventoryMetric label="discovered" value={props.skills.length} />
          <InventoryMetric label="from plugins" value={pluginSkillCount} />
        </div>
      </div>
      <div className="grid gap-3 p-3 sm:p-4">
        {groups.length ? (
          groups.map((group) => (
            <SkillGroupCard
              group={group}
              key={group.pluginProvider ?? "standalone"}
            />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-white/[0.08] px-4 py-8 text-center font-mono text-xs text-dashboard-text-muted">
            No skills have been discovered yet.
          </div>
        )}
      </div>
    </Card>
  );
}

function SkillGroupCard(props: { group: SkillGroup }) {
  const label = props.group.pluginProvider ?? "Standalone";
  return (
    <article className="rounded-lg border border-white/[0.065] bg-white/[0.025] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid size-8 shrink-0 place-items-center rounded border border-cyan-300/15 bg-cyan-300/[0.075] text-cyan-200">
            {props.group.pluginProvider ? (
              <Boxes aria-hidden="true" size={15} strokeWidth={1.8} />
            ) : (
              <Sparkles aria-hidden="true" size={15} strokeWidth={1.8} />
            )}
          </div>
          <div>
            <h3 className="m-0 truncate font-display text-base font-medium text-dashboard-text">
              {label}
            </h3>
            <div className="mt-0.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
              {props.group.pluginProvider ? "plugin provider" : "core or local"}
            </div>
          </div>
        </div>
        <span className="font-mono text-xs text-dashboard-text-muted">
          {formatCompactNumber(props.group.skills.length)} skill
          {props.group.skills.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {props.group.skills.map((skill) => (
          <span
            className="rounded border border-white/[0.07] bg-black/20 px-2.5 py-1.5 font-mono text-xs text-dashboard-text-muted"
            key={skill.name}
          >
            {skill.name}
          </span>
        ))}
      </div>
    </article>
  );
}

function InventoryMetric(props: { label: string; value: number }) {
  return (
    <div className="border-r border-white/[0.06] px-3 py-2.5 text-center last:border-r-0">
      <div className="font-display text-xl font-light leading-none text-dashboard-text">
        {formatCompactNumber(props.value)}
      </div>
      <div className="mt-1.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
        {props.label}
      </div>
    </div>
  );
}

function groupSkills(skills: SkillReport[]): SkillGroup[] {
  const groups = new Map<string | undefined, SkillReport[]>();
  for (const skill of skills) {
    const group = groups.get(skill.pluginProvider) ?? [];
    group.push(skill);
    groups.set(skill.pluginProvider, group);
  }
  return [...groups.entries()]
    .map(([pluginProvider, group]) => ({
      pluginProvider,
      skills: [...group].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    }))
    .sort((left, right) => {
      if (!left.pluginProvider) return 1;
      if (!right.pluginProvider) return -1;
      return left.pluginProvider.localeCompare(right.pluginProvider);
    });
}
