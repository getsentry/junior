import { logCapabilityCatalogLoadedOnce } from "@/chat/capabilities/catalog";
import { ProviderCredentialRouter } from "@/chat/capabilities/router";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { GitHubCredentialBroker } from "@/chat/credentials/github-broker";
import { TestCredentialBroker } from "@/chat/credentials/test-broker";

// Encapsulation boundary for capability runtime construction.
// Swap broker strategy here (provider router, test broker, etc.) without
// changing agent orchestration code in respond.ts.
export function createSkillCapabilityRuntime(options: {
  invocationArgs?: string;
  resolveConfiguration?: (key: string) => Promise<unknown>;
} = {}): SkillCapabilityRuntime {
  logCapabilityCatalogLoadedOnce();
  const githubBroker = process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1"
    ? new TestCredentialBroker()
    : new GitHubCredentialBroker();
  const router = new ProviderCredentialRouter({
    brokersByProvider: {
      github: githubBroker
    }
  });

  return new SkillCapabilityRuntime({
    router,
    invocationArgs: options.invocationArgs,
    resolveConfiguration: options.resolveConfiguration
  });
}
