import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { GitHubCredentialBroker } from "@/chat/credentials/github-broker";
import { TestCredentialBroker } from "@/chat/credentials/test-broker";

// Encapsulation boundary for capability runtime construction.
// Swap broker strategy here (provider router, test broker, etc.) without
// changing agent orchestration code in respond.ts.
export function createSkillCapabilityRuntime(invocationArgs?: string): SkillCapabilityRuntime {
  return new SkillCapabilityRuntime({
    broker: process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1" ? new TestCredentialBroker() : new GitHubCredentialBroker(),
    invocationArgs
  });
}
