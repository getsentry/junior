/**
 * Input audit of the agent Guardian (`GUARDIAN_ABLATIONS`): each design case
 * with one input removed, against a baseline of the same samples.
 */
import { completeObject } from "@/chat/core-model";
import { createAgentGuardian } from "@/chat/guardian/agent/guardian";
import { mapBounded } from "@/chat/fan-out";
import type { GuardianBatch } from "@/chat/guardian/gate";
import type { Message, ReviewRequest } from "@/chat/guardian/guardian";
import { instructionAuthor } from "@/chat/conversations/kind-behavior";
import { guardianArm, installedPluginFacts } from "./guardian-design-arms";
import type {
  GuardianArm,
  GuardianDesignRequest,
  GuardianDesignResult,
} from "./guardian-design-harness";
import { designGuardianRequest } from "./guardian-design-request";
import { gateReviews } from "./guardian-tools";

interface Ablation {
  /** Change the request that core builds. */
  request?(request: ReviewRequest, batch: GuardianBatch): ReviewRequest;
  /** Change the gate's proposals, which the lookups read. */
  batch?(batch: GuardianBatch): GuardianBatch;
  noPluginFacts?: boolean;
}

const LEAD_NOTE = "[This Run is a Space's Lead.]";
const GAP_NOTE = "[Older messages are not shown.]";

function messages(
  request: ReviewRequest,
  map: (message: Message) => Message | undefined,
): ReviewRequest {
  return {
    ...request,
    messages: request.messages.flatMap((message) => map(message) ?? []),
  };
}

function actions(
  request: ReviewRequest,
  map: (
    action: ReviewRequest["actions"][number],
  ) => ReviewRequest["actions"][number],
): ReviewRequest {
  return { ...request, actions: request.actions.map(map) };
}

function omit<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}

/** Each input of the audit, by name. */
const ABLATIONS: Record<string, Ablation> = {
  other_person_as_context: {
    request: (request) =>
      messages(request, (message) =>
        message.from === "other_person"
          ? { ...message, from: "context" }
          : message,
      ),
  },
  brief_as_context: {
    request: (request, batch) => {
      const context = batch.proposals[0]?.context;
      if (!context || instructionAuthor(context.source) !== "brief") {
        return request;
      }
      return messages(request, (message) =>
        message.from === "instruction" && message.text === context.userIntent
          ? { ...message, from: "context" }
          : message,
      );
    },
  },
  no_lead_note: {
    request: (request) =>
      messages(request, (message) =>
        message.text === LEAD_NOTE ? undefined : message,
      ),
  },
  no_gap_note: {
    request: (request) =>
      messages(request, (message) =>
        message.text === GAP_NOTE ? undefined : message,
      ),
  },
  no_target: {
    request: (request) => actions(request, (action) => omit(action, "target")),
  },
  audience_world: {
    request: (request) =>
      actions(request, (action) =>
        action.target
          ? { ...action, target: { ...action.target, audience: "world" } }
          : action,
      ),
  },
  no_tool_decision: {
    request: (request) =>
      actions(request, (action) => omit(action, "toolDecision")),
  },
  no_summary: {
    request: (request) => actions(request, (action) => omit(action, "summary")),
  },
  no_server_hints: {
    request: (request) =>
      actions(request, (action) => omit(action, "serverHints")),
  },
  no_plugin_context: {
    request: (request) => actions(request, (action) => omit(action, "context")),
  },
  no_placeholders: {
    request: (request) => omit(request, "sandbox"),
  },
  no_script: {
    batch: (batch) => ({
      proposals: batch.proposals.map((proposal) => omit(proposal, "script")),
    }),
  },
  no_prior_decisions: {
    batch: (batch) => ({
      proposals: batch.proposals.map((proposal) =>
        omit(proposal, "priorRejectedActions"),
      ),
    }),
  },
  no_provenance: {
    batch: (batch) => ({
      proposals: batch.proposals.map((proposal) => omit(proposal, "evidence")),
    }),
  },
  no_plugin_facts: {
    noPluginFacts: true,
  },
};

/** The ablations that `GUARDIAN_ABLATIONS` selects, or none. */
export function selectedAblations(): string[] {
  const value = process.env["GUARDIAN_ABLATIONS"]?.trim();
  if (!value) return [];
  const names = value === "all" ? Object.keys(ABLATIONS) : value.split(",");
  for (const name of names) {
    if (!ABLATIONS[name]) {
      throw new Error(`Unknown ablation "${name}".`);
    }
  }
  return names;
}

/** The agent arm with one ablation. */
function ablatedArm(ablation: Ablation): GuardianArm {
  return guardianArm((modelId, batch) => {
    const guardian = createAgentGuardian(
      {
        completeObject,
        destinationFacts: ablation.noPluginFacts ? [] : installedPluginFacts(),
        modelId,
      },
      ablation.batch ? ablation.batch(batch) : batch,
    );
    return {
      review: async (request, signal) =>
        await guardian.review(
          ablation.request ? ablation.request(request, batch) : request,
          signal,
        ),
    };
  });
}

/** Whether an ablation changes what core builds for this case. */
async function changesRequest(
  ablation: Ablation,
  request: GuardianDesignRequest,
): Promise<boolean> {
  if (!ablation.request && !ablation.batch) return false;
  const reviewed = (
    await mapBounded(request.actions, async (proposal) =>
      proposal.tool.name === "bash" || (await gateReviews(proposal))
        ? proposal
        : undefined,
    )
  ).filter((proposal) => proposal !== undefined);
  if (reviewed.length === 0) return false;
  const batch: GuardianBatch = { proposals: reviewed };
  const built = await designGuardianRequest(reviewed, request.facts);
  const after = ablation.request ? ablation.request(built, batch) : built;
  const afterBatch = ablation.batch ? ablation.batch(batch) : batch;
  return (
    JSON.stringify(after) !== JSON.stringify(built) ||
    JSON.stringify(afterBatch) !== JSON.stringify(batch)
  );
}

/** Whether an ablation can change what the model sees in this case. */
async function applies(
  ablation: Ablation,
  request: GuardianDesignRequest,
): Promise<boolean> {
  return ablation.request || ablation.batch
    ? await changesRequest(ablation, request)
    : true;
}

type Sample = PromiseSettledResult<GuardianDesignResult>;

function outcomeOf(sample: Sample): string {
  return sample.status === "rejected"
    ? "threw"
    : sample.value.actions.map((action) => action.outcome).join(",");
}

async function runSamples(
  ablation: Ablation,
  request: GuardianDesignRequest,
  samples: number,
  signal: () => AbortSignal,
): Promise<Sample[]> {
  return await mapBounded(
    Array.from({ length: samples }, (_, index) => index),
    async (): Promise<Sample> => {
      try {
        const value = await ablatedArm(ablation)(request, {
          signal: signal(),
        });
        return { status: "fulfilled", value };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    },
  );
}

/** The audit record of one case. */
export type AblationAudit = {
  baseline: string[];
  /** Outcomes of each ablation that changes the case. */
  variants: Record<string, string[]>;
  /** The ablations whose every sample differs from a unanimous baseline. */
  flips: string[];
};

/**
 * Run the baseline and every selected ablation that changes the case.
 * The baseline samples are the case's own samples.
 */
export async function auditCase(
  request: GuardianDesignRequest,
  samples: number,
  names: readonly string[],
  signal: () => AbortSignal,
): Promise<{ baseline: Sample[]; audit: AblationAudit }> {
  const baseline = await runSamples({}, request, samples, signal);
  const baselineOutcomes = baseline.map(outcomeOf);
  const unanimous = baselineOutcomes.every(
    (outcome) => outcome === baselineOutcomes[0] && outcome !== "threw",
  );
  const variants: Record<string, string[]> = {};
  const flips: string[] = [];
  await mapBounded([...names], async (name) => {
    const ablation = ABLATIONS[name]!;
    if (!(await applies(ablation, request))) return;
    const outcomes = (await runSamples(ablation, request, samples, signal)).map(
      outcomeOf,
    );
    variants[name] = outcomes;
    if (
      unanimous &&
      outcomes.every(
        (outcome) => outcome !== baselineOutcomes[0] && outcome !== "threw",
      )
    ) {
      flips.push(name);
    }
  });
  return {
    baseline,
    audit: { baseline: baselineOutcomes, variants, flips: flips.sort() },
  };
}
