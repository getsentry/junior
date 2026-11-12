/**
 * Facts that credential audit events name about the run and the credential.
 *
 * These values are telemetry only. They grant nothing.
 */
import * as z from "zod";
import type { Source } from "@sentry/junior-plugin-api";
import {
  credentialUserSubjectId,
  type CredentialContext,
} from "@/chat/credentials/context";

const nonBlankStringSchema = z.string().min(1);

export const credentialAuditSourceSchema = z
  .object({
    kind: nonBlankStringSchema,
    automationId: nonBlankStringSchema.optional(),
    automationRunId: nonBlankStringSchema.optional(),
  })
  .strict();

/** The run Source and its Automation run, as credential audit events name them. */
export type CredentialAuditSource = z.output<
  typeof credentialAuditSourceSchema
>;

/** Project a run Source to the facts that credential audit events name. */
export function credentialAuditSource(source: Source): CredentialAuditSource {
  if (
    source.kind !== "scheduled_automation" &&
    source.kind !== "event_automation"
  ) {
    return { kind: source.kind };
  }
  const result: CredentialAuditSource = { kind: source.kind };
  if (source.automationId) result.automationId = source.automationId;
  if (source.automationRunId) result.automationRunId = source.automationRunId;
  return result;
}

/** Telemetry attributes for the run Source of a credential audit event. */
export function credentialAuditAttributes(
  source: CredentialAuditSource | undefined,
): Record<string, string> {
  if (!source) return {};
  const attributes: Record<string, string> = {
    "app.source.kind": source.kind,
  };
  if (source.automationId) attributes["app.task.id"] = source.automationId;
  if (source.automationRunId) {
    attributes["app.task.run.id"] = source.automationRunId;
  }
  return attributes;
}

/**
 * Name whose credential a lease holds. An OAuth lease issued for a person
 * holds that person's token: the Actor's own, or a delegated credential
 * subject. Any other lease holds a credential that Junior owns, such as a
 * GitHub App installation token or a deployment API key. An OAuth provider
 * with no person falls back to its deployment token.
 */
export function credentialAccount(
  lease: { authorization?: unknown },
  credentials: CredentialContext,
): "actor" | "app" {
  return lease.authorization && credentialUserSubjectId(credentials)
    ? "actor"
    : "app";
}
