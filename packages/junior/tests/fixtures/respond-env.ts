export interface RespondRuntimeEnvSnapshot {
  agentTurnTimeoutMs?: string;
  aiAdvisorModel?: string;
  aiFastModel?: string;
  aiModel?: string;
  functionMaxDurationSeconds?: string;
  juniorStateAdapter?: string;
}

/** Configure deterministic runtime env values before importing respond modules. */
export function configureRespondRuntimeEnv(): RespondRuntimeEnvSnapshot {
  const originalEnv: RespondRuntimeEnvSnapshot = {
    agentTurnTimeoutMs: process.env.AGENT_TURN_TIMEOUT_MS,
    aiAdvisorModel: process.env.AI_ADVISOR_MODEL,
    aiFastModel: process.env.AI_FAST_MODEL,
    aiModel: process.env.AI_MODEL,
    functionMaxDurationSeconds: process.env.FUNCTION_MAX_DURATION_SECONDS,
    juniorStateAdapter: process.env.JUNIOR_STATE_ADAPTER,
  };

  process.env.AGENT_TURN_TIMEOUT_MS = "10000";
  process.env.AI_ADVISOR_MODEL = "openai/gpt-5.5";
  process.env.AI_FAST_MODEL = "openai/gpt-5.4-mini";
  process.env.AI_MODEL = "openai/gpt-5.4";
  process.env.FUNCTION_MAX_DURATION_SECONDS = "60";
  process.env.JUNIOR_STATE_ADAPTER = "memory";

  return originalEnv;
}

/** Restore env values captured by configureRespondRuntimeEnv. */
export function restoreRespondRuntimeEnv(
  snapshot: RespondRuntimeEnvSnapshot,
): void {
  restoreEnv("AGENT_TURN_TIMEOUT_MS", snapshot.agentTurnTimeoutMs);
  restoreEnv("AI_ADVISOR_MODEL", snapshot.aiAdvisorModel);
  restoreEnv("AI_FAST_MODEL", snapshot.aiFastModel);
  restoreEnv("AI_MODEL", snapshot.aiModel);
  restoreEnv(
    "FUNCTION_MAX_DURATION_SECONDS",
    snapshot.functionMaxDurationSeconds,
  );
  restoreEnv("JUNIOR_STATE_ADAPTER", snapshot.juniorStateAdapter);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
