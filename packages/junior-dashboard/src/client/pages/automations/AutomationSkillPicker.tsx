import { useState } from "react";
import { Boxes, ChevronsUpDown, Sparkles } from "lucide-react";
import type { SkillReport } from "@sentry/junior/api/schema";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../styles";

/**
 * Choose the skill an Automation runs. A saved skill that is no longer
 * installed stays selected and shows as not found.
 */
export function AutomationSkillPicker(props: {
  id: string;
  value: string;
  skills: readonly SkillReport[];
  invalid: boolean;
  describedBy?: string;
  onChange(skill: string): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = props.skills.find((skill) => skill.name === props.value);
  const missing = Boolean(props.value) && !selected;
  const groups = [
    {
      heading: "App and local skills",
      skills: props.skills.filter((skill) => !skill.pluginProvider),
    },
    {
      heading: "Plugin skills",
      skills: props.skills.filter((skill) => skill.pluginProvider),
    },
  ].filter((group) => group.skills.length > 0);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        aria-invalid={props.invalid || missing || undefined}
        aria-describedby={props.describedBy}
        className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-md border border-dashboard-border-emphasis bg-dashboard-ink px-3 py-2 text-left font-sans text-sm text-dashboard-text hover:border-dashboard-border-heavy focus-visible:border-dashboard-focus focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-dashboard-focus/25 aria-invalid:border-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {props.value ? (
          <>
            <SkillTile plugin={Boolean(selected?.pluginProvider)} />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "truncate font-mono text-sm",
                    missing &&
                      "text-dashboard-text-muted line-through decoration-dashboard-text-muted/60",
                  )}
                >
                  {props.value}
                </span>
                {missing ? (
                  <SkillBadge tone="danger">Not found</SkillBadge>
                ) : selected?.disableModelInvocation ? (
                  <SkillBadge>Manual only</SkillBadge>
                ) : null}
              </span>
              {selected?.description ? (
                <span className="truncate text-xs text-dashboard-text-muted">
                  {selected.description}
                </span>
              ) : null}
            </span>
          </>
        ) : (
          <span className="flex-1 text-dashboard-text-muted">
            Choose a skill
          </span>
        )}
        <ChevronsUpDown
          aria-hidden="true"
          className="size-4 shrink-0 text-dashboard-text-muted"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--anchor-width) max-w-[calc(100vw-2rem)] min-w-80 overflow-hidden p-0"
      >
        <Command label="Skills">
          <CommandInput placeholder="Search by name or description" />
          <CommandList>
            <CommandEmpty>No skills match.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup heading={group.heading} key={group.heading}>
                {group.skills.map((skill) => (
                  <CommandItem
                    key={skill.name}
                    value={skill.name}
                    keywords={[skill.description]}
                    onSelect={() => {
                      props.onChange(skill.name);
                      setOpen(false);
                    }}
                    className="items-start"
                  >
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono">{skill.name}</span>
                        {skill.disableModelInvocation ? (
                          <SkillBadge>Manual only</SkillBadge>
                        ) : null}
                      </span>
                      <span className="truncate text-xs text-dashboard-text-muted">
                        {skill.description}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SkillTile(props: { plugin: boolean }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-dashboard-accent/15 bg-dashboard-accent/[0.075] text-dashboard-accent-text">
      {props.plugin ? (
        <Boxes aria-hidden="true" size={15} strokeWidth={1.8} />
      ) : (
        <Sparkles aria-hidden="true" size={15} strokeWidth={1.8} />
      )}
    </span>
  );
}

function SkillBadge(props: { children: string; tone?: "danger" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm border px-1.5 py-0.5 font-sans text-xs leading-none font-medium",
        props.tone === "danger"
          ? "border-rose-300/40 text-rose-300"
          : "border-dashboard-accent/25 bg-dashboard-accent/[0.075] text-dashboard-accent-text",
      )}
    >
      {props.children}
    </span>
  );
}
