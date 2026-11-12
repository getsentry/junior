import { useState } from "react";
import { Plus } from "lucide-react";
import type { AutomationEdit, SkillReport } from "@sentry/junior/api/schema";
import { useSkillsData } from "../../api";
import { SkillLink, skillLabel } from "../../components/SkillLink";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { AutomationSkillPicker } from "./AutomationSkillPicker";
import { taskDraft, type AutomationTaskDraft } from "./automationDraft";

type InputState = {
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

/**
 * Edit what an Automation runs: a written instruction, or a skill with
 * optional context. Switching modes restores the saved task of that mode.
 */
export function AutomationTaskFields(props: {
  task: AutomationTaskDraft;
  original: AutomationEdit;
  disabled: boolean;
  fieldError(key: string): string | undefined;
  inputState(key: string): InputState;
  onChange(task: AutomationTaskDraft): void;
}) {
  const { task, original } = props;
  // Keep the context field open while its text is cleared.
  const [contextOpen, setContextOpen] = useState(
    task.kind === "skill" && task.context !== "",
  );
  const skills = useSkillsData().data;
  return (
    <>
      {/* Field stretches its children. The toggle keeps its own width. */}
      <Field className="*:w-fit">
        <span id="run-label" className="text-sm font-semibold">
          Run
        </span>
        <ToggleGroup
          aria-labelledby="run-label"
          disabled={props.disabled}
          value={[task.kind]}
          onValueChange={([next]) => {
            if (next !== "instruction" && next !== "skill") return;
            if (next === task.kind) return;
            const restored: AutomationTaskDraft =
              next === original.task.kind
                ? taskDraft(original.task)
                : next === "skill"
                  ? { kind: "skill", skill: "", context: "" }
                  : { kind: "instruction", instruction: "" };
            setContextOpen(
              restored.kind === "skill" && restored.context !== "",
            );
            props.onChange(restored);
          }}
          className="w-fit rounded-md border border-dashboard-border-emphasis p-0.5"
        >
          <ToggleGroupItem value="instruction">Instruction</ToggleGroupItem>
          <ToggleGroupItem value="skill">Skill</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {task.kind === "skill" ? (
        <SkillFields
          {...props}
          task={task}
          skills={skills}
          contextOpen={contextOpen || task.context !== ""}
          onContextOpen={setContextOpen}
        />
      ) : (
        <Field>
          <FieldLabel htmlFor="task.instruction">Instruction</FieldLabel>
          <Textarea
            id="task.instruction"
            rows={8}
            value={task.instruction}
            onChange={(e) =>
              props.onChange({ ...task, instruction: e.target.value })
            }
            {...props.inputState("task.instruction")}
            className="resize-y text-base leading-relaxed sm:text-sm"
          />
          <p className="m-0 text-right text-xs text-dashboard-text-muted">
            {task.instruction.length.toLocaleString()} / 4,000
          </p>
          <FieldError id="task.instruction-error">
            {props.fieldError("task.instruction")}
          </FieldError>
        </Field>
      )}
    </>
  );
}

function SkillFields(props: {
  task: Extract<AutomationTaskDraft, { kind: "skill" }>;
  skills: readonly SkillReport[] | undefined;
  contextOpen: boolean;
  fieldError(key: string): string | undefined;
  inputState(key: string): InputState;
  onChange(task: AutomationTaskDraft): void;
  onContextOpen(open: boolean): void;
}) {
  const { task } = props;
  const selected = props.skills?.find((skill) => skill.name === task.skill);
  // Wait for the skill list before calling a saved skill missing.
  const missing = Boolean(task.skill && props.skills && !selected);
  const skillError =
    props.fieldError("task.skill") ??
    (missing
      ? `${skillLabel(task.skill)} is no longer installed. This automation is blocked until you choose another skill or switch to an instruction.`
      : undefined);
  return (
    <>
      <Field>
        <FieldLabel htmlFor="task.skill">Skill</FieldLabel>
        <AutomationSkillPicker
          id="task.skill"
          value={task.skill}
          skills={props.skills ?? []}
          invalid={Boolean(skillError)}
          describedBy={skillError ? "task.skill-error" : "skill-hint"}
          onChange={(skill) => props.onChange({ ...task, skill })}
        />
        <FieldError id="task.skill-error">{skillError}</FieldError>
        <FieldDescription
          id="skill-hint"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          Junior loads this skill at the start of each run.
          {selected ? (
            <SkillLink name={selected.name}>View skill</SkillLink>
          ) : null}
        </FieldDescription>
      </Field>
      {props.contextOpen ? (
        <Field>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="task.context">Additional context</FieldLabel>
            <Button
              variant="quiet"
              onClick={() => {
                props.onChange({ ...task, context: "" });
                props.onContextOpen(false);
              }}
            >
              Remove
            </Button>
          </div>
          <Textarea
            id="task.context"
            rows={4}
            // The person just asked to add context.
            autoFocus={task.context === ""}
            value={task.context}
            placeholder="What this automation needs beyond the skill, such as a repo, a threshold, or who to tag."
            onChange={(e) =>
              props.onChange({ ...task, context: e.target.value })
            }
            {...props.inputState("task.context")}
            className="resize-y text-base leading-relaxed sm:text-sm"
          />
          <div className="flex items-start justify-between gap-3">
            <FieldDescription>
              Junior gets this with the skill on every run.
            </FieldDescription>
            <p className="m-0 shrink-0 text-xs text-dashboard-text-muted">
              {task.context.length.toLocaleString()} / 4,000
            </p>
          </div>
          <FieldError id="task.context-error">
            {props.fieldError("task.context")}
          </FieldError>
        </Field>
      ) : (
        <Button
          variant="quiet"
          className="w-fit"
          onClick={() => props.onContextOpen(true)}
        >
          <Plus aria-hidden="true" className="size-4" />
          Add context
        </Button>
      )}
    </>
  );
}
