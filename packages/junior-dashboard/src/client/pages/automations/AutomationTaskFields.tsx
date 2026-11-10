import { useState } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import type { AutomationEdit, SkillReport } from "@sentry/junior/api/schema";
import { useSkillsData } from "../../api";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { systemPluginPath } from "../system/SystemPlugins";
import { AutomationSkillPicker } from "./AutomationSkillPicker";
import type { AutomationDraft } from "./automationDraft";

type InputState = {
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

/**
 * Edit what an Automation runs: a written instruction, or a skill with
 * optional context. Switching modes restores the saved text of that mode.
 */
export function AutomationTaskFields(props: {
  draft: Pick<AutomationDraft, "instruction" | "skill">;
  original: AutomationEdit;
  disabled: boolean;
  fieldError(key: string): string | undefined;
  inputState(key: string): InputState;
  onChange(value: Partial<AutomationDraft>): void;
}) {
  const { draft, original } = props;
  // Keep the context field open while its text is cleared.
  const [contextOpen, setContextOpen] = useState(draft.instruction !== "");
  const skills = useSkillsData().data;
  const skillMode = draft.skill !== null;
  return (
    <>
      <Field>
        <span id="run-label" className="text-sm font-semibold">
          Run
        </span>
        <ToggleGroup
          aria-labelledby="run-label"
          disabled={props.disabled}
          value={[skillMode ? "skill" : "instruction"]}
          onValueChange={([next]) => {
            if (!next || next === (skillMode ? "skill" : "instruction")) return;
            const savedSkillMode = original.skill !== undefined;
            const instruction =
              (next === "skill") === savedSkillMode ? original.instruction : "";
            setContextOpen(instruction !== "");
            props.onChange({
              skill: next === "skill" ? (original.skill ?? "") : null,
              instruction,
            });
          }}
          className="w-fit rounded-md border border-dashboard-border-emphasis p-0.5"
        >
          <ToggleGroupItem value="instruction">Instruction</ToggleGroupItem>
          <ToggleGroupItem value="skill">Skill</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {skillMode ? (
        <SkillFields
          {...props}
          skill={draft.skill ?? ""}
          skills={skills}
          contextOpen={contextOpen || draft.instruction !== ""}
          onContextOpen={setContextOpen}
        />
      ) : (
        <Field>
          <FieldLabel htmlFor="instruction">Instruction</FieldLabel>
          <Textarea
            id="instruction"
            rows={8}
            value={draft.instruction}
            onChange={(e) => props.onChange({ instruction: e.target.value })}
            {...props.inputState("instruction")}
            className="resize-y text-base leading-relaxed sm:text-sm"
          />
          <p className="m-0 text-right text-xs text-dashboard-text-muted">
            {draft.instruction.length.toLocaleString()} / 4,000
          </p>
          <FieldError id="instruction-error">
            {props.fieldError("instruction")}
          </FieldError>
        </Field>
      )}
    </>
  );
}

function SkillFields(props: {
  draft: Pick<AutomationDraft, "instruction">;
  skill: string;
  skills: readonly SkillReport[] | undefined;
  contextOpen: boolean;
  fieldError(key: string): string | undefined;
  inputState(key: string): InputState;
  onChange(value: Partial<AutomationDraft>): void;
  onContextOpen(open: boolean): void;
}) {
  const selected = props.skills?.find((skill) => skill.name === props.skill);
  // Wait for the skill list before calling a saved skill missing.
  const missing = Boolean(props.skill && props.skills && !selected);
  const skillError =
    props.fieldError("skill") ??
    (missing
      ? `The skill ${props.skill} is no longer installed. This automation is blocked until you choose another skill or switch to an instruction.`
      : undefined);
  return (
    <>
      <Field>
        <FieldLabel htmlFor="skill">Skill</FieldLabel>
        <AutomationSkillPicker
          id="skill"
          value={props.skill}
          skills={props.skills ?? []}
          invalid={Boolean(skillError)}
          describedBy={skillError ? "skill-error" : "skill-hint"}
          onChange={(skill) => props.onChange({ skill })}
        />
        <FieldError id="skill-error">{skillError}</FieldError>
        <FieldDescription
          id="skill-hint"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          Junior loads this skill at the start of each run.
          {selected ? (
            <Link
              to={
                selected.pluginProvider
                  ? systemPluginPath(selected.pluginProvider)
                  : "/system#skills"
              }
              className="text-dashboard-accent-text"
            >
              View skill
            </Link>
          ) : null}
        </FieldDescription>
      </Field>
      {props.contextOpen ? (
        <Field>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="instruction">Additional context</FieldLabel>
            <Button
              variant="quiet"
              onClick={() => {
                props.onChange({ instruction: "" });
                props.onContextOpen(false);
              }}
            >
              Remove
            </Button>
          </div>
          <Textarea
            id="instruction"
            rows={4}
            // The person just asked to add context.
            autoFocus={props.draft.instruction === ""}
            value={props.draft.instruction}
            placeholder="What this automation needs beyond the skill, such as a repo, a threshold, or who to tag."
            onChange={(e) => props.onChange({ instruction: e.target.value })}
            {...props.inputState("instruction")}
            className="resize-y text-base leading-relaxed sm:text-sm"
          />
          <div className="flex items-start justify-between gap-3">
            <FieldDescription>
              Junior gets this with the skill on every run.
            </FieldDescription>
            <p className="m-0 shrink-0 text-xs text-dashboard-text-muted">
              {props.draft.instruction.length.toLocaleString()} / 4,000
            </p>
          </div>
          <FieldError id="instruction-error">
            {props.fieldError("instruction")}
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
