import { z } from "zod";

const categoryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const classificationCategorySchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    id: categoryIdSchema,
  })
  .strict();

export const classificationTaxonomySchema = z
  .object({
    categories: z.array(classificationCategorySchema).min(1).max(50),
    version: z.string().trim().min(1).max(128),
  })
  .strict()
  .superRefine((taxonomy, ctx) => {
    const categoryIds = new Set<string>();
    for (const [index, category] of taxonomy.categories.entries()) {
      if (categoryIds.has(category.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate category id: ${category.id}`,
          path: ["categories", index, "id"],
        });
      }
      categoryIds.add(category.id);
    }
  });

export const conversationClassificationOptionsSchema = z
  .object({
    maxTranscriptChars: z.number().int().min(256).optional(),
    modelId: z.string().trim().min(1).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    taxonomy: classificationTaxonomySchema.optional(),
  })
  .strict();

export type ClassificationCategory = z.output<
  typeof classificationCategorySchema
>;
export type ClassificationTaxonomy = z.output<
  typeof classificationTaxonomySchema
>;
export type ConversationClassificationOptions = z.input<
  typeof conversationClassificationOptionsSchema
>;

/** Default taxonomy for per-turn requested-job analytics. */
export const DEFAULT_TURN_INTENT_TAXONOMY = {
  version: "turn-intent-v1",
  categories: [
    {
      id: "product_question",
      description:
        "Asks how an existing product, feature, integration, or internal service works, is configured, or should be used. Prefer this over planning_design for setup and configuration questions.",
    },
    {
      id: "customer_support",
      description:
        "Investigates or responds to a customer-specific question, account issue, support request, or success concern.",
    },
    {
      id: "code_change",
      description:
        "Creates, modifies, reviews, or refactors source code, tests, configuration, or infrastructure as code.",
    },
    {
      id: "bug_investigation",
      description:
        "Diagnoses incorrect software behavior, a failing test, or a suspected bug outside an active production incident.",
    },
    {
      id: "incident_response",
      description:
        "Investigates, mitigates, or communicates about a production incident, outage, alert, or active reliability problem.",
    },
    {
      id: "security_review",
      description:
        "Assesses a vulnerability, permission, access-control issue, compliance requirement, or security risk.",
    },
    {
      id: "product_analysis",
      description:
        "Analyzes product or business behavior using metrics, funnels, retention, experiments, cohorts, or user activity.",
    },
    {
      id: "operational_analysis",
      description:
        "Analyzes service health, deployments, logs, metrics, traces, cost, or capacity outside an active incident.",
    },
    {
      id: "knowledge_lookup",
      description:
        "Finds, explains, compares, or summarizes internal documentation, prior decisions, or existing technical context.",
    },
    {
      id: "market_account_research",
      description:
        "Researches a customer, account, company, market, competitor, or campaign to prepare sales or marketing work.",
    },
    {
      id: "project_management",
      description:
        "Creates, updates, triages, prioritizes, or reports status on issues, tasks, pull requests, or projects.",
    },
    {
      id: "planning_design",
      description:
        "Develops a future architecture, specification, rollout plan, implementation plan, proposal, or prioritized next steps. Do not use for questions about existing product setup.",
    },
    {
      id: "decision_support",
      description:
        "Compares options, evaluates tradeoffs, or recommends a decision without directly carrying it out.",
    },
    {
      id: "writing_communication",
      description:
        "Drafts or edits documentation, reports, announcements, summaries, messages, or other workplace communication.",
    },
    {
      id: "workflow_automation",
      description:
        "Creates or manages scheduled tasks, reminders, recurring reports, or other automated workflows.",
    },
    {
      id: "other",
      description:
        "Covers social, meta, trivial exact-output, or otherwise uncategorized requests.",
    },
  ],
} as const satisfies ClassificationTaxonomy;
