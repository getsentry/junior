/**
 * Writes that reached the fake GitHub. The host's GitHub tools write through
 * this worker, and `gh` in the sandbox writes through the egress of the main
 * process, so a test reads both.
 */
import { inject } from "vitest";
import {
  readTestGitHubSdkReproWrites,
  type GitHubSdkReproWrite,
} from "@sentry/junior-testing/http";
import "../eval-context";

/** Return the sdk-repro scenario's GitHub writes of this test. */
export async function readGitHubSdkReproWrites(): Promise<
  GitHubSdkReproWrite[]
> {
  const context = inject("juniorEvalContext");
  if (!context) throw new Error("Eval global setup did not provide context");
  const response = await fetch(context.stateUrl, {
    headers: { authorization: `Bearer ${context.controlToken}` },
  });
  if (!response.ok) {
    throw new Error(`Eval egress state read failed: HTTP ${response.status}`);
  }
  const state = (await response.json()) as {
    githubSdkReproWrites?: GitHubSdkReproWrite[];
  };
  return [
    ...readTestGitHubSdkReproWrites(),
    ...(state.githubSdkReproWrites ?? []),
  ];
}
