// src/chat/workflow/router.ts
import { start } from "workflow/api";

// src/chat/workflow/thread-workflow.ts
import { defineHook, getWorkflowMetadata } from "workflow";

// src/chat/workflow/thread-steps.ts
var stateAdapterConnected = false;
function isSerializedThread(thread) {
  return typeof thread === "object" && thread !== null && thread._type === "chat:Thread";
}
function isSerializedMessage(message) {
  return typeof message === "object" && message !== null && message._type === "chat:Message";
}
function getPayloadChannelId(payload) {
  return payload.thread.channelId;
}
function getPayloadUserId(payload) {
  return payload.message.author?.userId;
}
function toOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function getPayloadWorkflowRunId(payload) {
  return toOptionalString(payload.workflowRunId) ?? toOptionalString(payload.thread.runId) ?? toOptionalString(payload.message.runId);
}
function createMessageOwnerToken() {
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
var WorkflowMessageOwnershipError = class extends Error {
  constructor(stage, dedupKey) {
    super(`Workflow message ownership lost during ${stage} for dedupKey=${dedupKey}`);
    this.name = "WorkflowMessageOwnershipError";
  }
};
async function logThreadMessageFailureStep(payload, errorMessage, workflowRunId) {
  "use step";
  const { logError } = await import("./observability-Z2SJA73L.js");
  logError(
    "workflow_message_failed",
    {
      slackThreadId: payload.normalizedThreadId,
      slackChannelId: getPayloadChannelId(payload),
      slackUserId: getPayloadUserId(payload),
      workflowRunId
    },
    {
      "messaging.message.id": payload.message.id,
      "app.workflow.message_kind": payload.kind,
      "error.message": errorMessage
    },
    "Thread workflow step failed"
  );
}
async function processThreadMessageStep(payload, workflowRunId) {
  "use step";
  const [{ Message, ThreadImpl }, { WORKFLOW_DESERIALIZE }] = await Promise.all([import("chat"), import("@workflow/serde")]);
  const threadDeserializer = ThreadImpl[WORKFLOW_DESERIALIZE];
  const messageDeserializer = Message[WORKFLOW_DESERIALIZE];
  const [
    { processThreadMessageRuntime },
    {
      getStateAdapter,
      acquireWorkflowMessageProcessingOwnership,
      completeWorkflowMessageProcessingOwnership,
      failWorkflowMessageProcessingOwnership,
      getWorkflowMessageProcessingState,
      refreshWorkflowMessageProcessingOwnership
    }
  ] = await Promise.all([
    import("./process-thread-message-runtime-7FAJ7KQK.js"),
    import("./state-HQNMBF7O.js")
  ]);
  const resolvedWorkflowRunId = workflowRunId ?? getPayloadWorkflowRunId(payload);
  const threadWasSerialized = isSerializedThread(payload.thread);
  const existingMessageState = await getWorkflowMessageProcessingState(payload.dedupKey);
  if (existingMessageState?.status === "completed") {
    return;
  }
  const ownerToken = createMessageOwnerToken();
  const claimResult = await acquireWorkflowMessageProcessingOwnership({
    rawKey: payload.dedupKey,
    ownerToken,
    workflowRunId: resolvedWorkflowRunId
  });
  if (claimResult === "blocked") {
    return;
  }
  if (threadWasSerialized && !stateAdapterConnected) {
    await getStateAdapter().connect();
    stateAdapterConnected = true;
  }
  const runtimeThread = isSerializedThread(payload.thread) ? threadDeserializer(payload.thread) : payload.thread;
  const runtimeMessage = isSerializedMessage(payload.message) ? messageDeserializer(payload.message) : payload.message;
  const runtimePayload = {
    ...payload,
    thread: runtimeThread,
    message: runtimeMessage
  };
  try {
    const refreshed = await refreshWorkflowMessageProcessingOwnership({
      rawKey: payload.dedupKey,
      ownerToken,
      workflowRunId: resolvedWorkflowRunId
    });
    if (!refreshed) {
      throw new WorkflowMessageOwnershipError("refresh", payload.dedupKey);
    }
    await processThreadMessageRuntime({
      kind: payload.kind,
      thread: runtimePayload.thread,
      message: runtimePayload.message
    });
    const completed = await completeWorkflowMessageProcessingOwnership({
      rawKey: payload.dedupKey,
      ownerToken,
      workflowRunId: resolvedWorkflowRunId
    });
    if (!completed) {
      throw new WorkflowMessageOwnershipError("complete", payload.dedupKey);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failed = await failWorkflowMessageProcessingOwnership({
      rawKey: payload.dedupKey,
      ownerToken,
      errorMessage,
      workflowRunId: resolvedWorkflowRunId
    });
    if (!failed && !(error instanceof WorkflowMessageOwnershipError)) {
      throw new Error(`Failed to persist workflow message failure state for dedupKey=${payload.dedupKey}: ${errorMessage}`);
    }
    throw error;
  }
}
Object.assign(processThreadMessageStep, { maxRetries: 1 });

// src/chat/workflow/thread-workflow.ts
var MAX_DEDUP_KEYS = 500;
var DEDUP_TRIM_SIZE = Math.floor(MAX_DEDUP_KEYS / 2);
var threadMessageHook = defineHook();
function isHookConflictError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("already in use") || message.includes("hook token") || message.includes("hook conflict");
}
function trimSeenDedupKeys(seen) {
  if (seen.size <= MAX_DEDUP_KEYS) {
    return;
  }
  let deleteCount = seen.size - DEDUP_TRIM_SIZE;
  for (const key of seen) {
    seen.delete(key);
    deleteCount -= 1;
    if (deleteCount <= 0) {
      break;
    }
  }
}
async function processThreadPayloadStream(stream, workflowRunId) {
  const seenDedupKeys = /* @__PURE__ */ new Set();
  for await (const payload of stream) {
    if (seenDedupKeys.has(payload.dedupKey)) {
      continue;
    }
    seenDedupKeys.add(payload.dedupKey);
    trimSeenDedupKeys(seenDedupKeys);
    try {
      await processThreadMessageStep(payload, workflowRunId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logThreadMessageFailureStep(payload, errorMessage, workflowRunId);
    }
  }
}
async function slackThreadWorkflow(normalizedThreadId) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  let hook;
  try {
    hook = threadMessageHook.create({
      token: normalizedThreadId
    });
  } catch (error) {
    if (isHookConflictError(error)) {
      return;
    }
    throw error;
  }
  await processThreadPayloadStream(hook, workflowRunId);
}

// src/chat/workflow/router.ts
var LEADER_POST_START_RESUME_DELAYS_MS = [250, 750, 1500];
var FOLLOWER_RESUME_DELAYS_MS = [250, 750, 1500];
var FINAL_SAFETY_RESUME_DELAYS_MS = [250, 500];
var STARTUP_LEASE_TTL_MS = 3e3;
var WARN_RETRY_ATTEMPT = 3;
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function createStartupLeaseToken() {
  return `lease-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
async function claimWorkflowStartupLeaseSafe(normalizedThreadId, ownerToken, ttlMs) {
  const { claimWorkflowStartupLease } = await import("./state-HQNMBF7O.js");
  return await claimWorkflowStartupLease(normalizedThreadId, ownerToken, ttlMs);
}
async function releaseWorkflowStartupLeaseSafe(normalizedThreadId, ownerToken) {
  const { releaseWorkflowStartupLease } = await import("./state-HQNMBF7O.js");
  try {
    await releaseWorkflowStartupLease(normalizedThreadId, ownerToken);
  } catch {
  }
}
function classifyResumeMiss(error) {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("not found")) {
    return "hook_not_found";
  }
  if (message.includes("returned no hook entity")) {
    return "resume_empty";
  }
  return "resume_error";
}
function isBenignStartRaceError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const typedError = error;
  const code = typedError.code?.toLowerCase();
  const name = typedError.name?.toLowerCase();
  const message = typedError.message.toLowerCase();
  if (code === "already_exists" || code === "conflict") {
    return true;
  }
  if (name === "conflicterror") {
    return true;
  }
  return message.includes("already exists") || message.includes("already started") || message.includes("already running") || message.includes("hook conflict") || message.includes("duplicate");
}
async function attemptResumeHook(normalizedThreadId, payload) {
  try {
    const hook = await threadMessageHook.resume(normalizedThreadId, payload);
    if (hook) {
      return { resumed: true, runId: hook.runId };
    }
    return {
      resumed: false,
      error: new Error("Hook resume returned no hook entity")
    };
  } catch (error) {
    return {
      resumed: false,
      error
    };
  }
}
async function retryResume(normalizedThreadId, payload, startupRole, retryDelaysMs, retryPhase) {
  let lastError;
  void startupRole;
  void retryPhase;
  for (const [index, delayMs] of retryDelaysMs.entries()) {
    await sleep(delayMs);
    const resumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
    if (resumeAttempt.resumed) {
      return resumeAttempt.runId;
    }
    lastError = resumeAttempt.error;
    const retryAttempt = index + 1;
    const retryReason = classifyResumeMiss(resumeAttempt.error);
    const isFinalRetry = index === retryDelaysMs.length - 1;
    const isWarnRetry = retryAttempt >= WARN_RETRY_ATTEMPT || isFinalRetry;
    void retryAttempt;
    void retryReason;
    void isFinalRetry;
    void isWarnRetry;
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Failed to resume thread workflow hook after start");
}
async function startWorkflowAndRetryResume(args) {
  const { normalizedThreadId, payload, startupRole, resumeMissReason, resumeMissError } = args;
  let startedRunId;
  let startError;
  let startOutcome = "started";
  try {
    const startedRun = await start(slackThreadWorkflow, [normalizedThreadId]);
    startedRunId = startedRun.runId;
  } catch (error) {
    if (isBenignStartRaceError(error)) {
      startError = error;
      startOutcome = "raced";
    } else {
      startError = error;
      startOutcome = "failed";
    }
  }
  void payload.kind;
  void startupRole;
  void resumeMissReason;
  void resumeMissError;
  void startError;
  if (startOutcome === "failed") {
    throw startError;
  }
  const resumedRunId = await retryResume(
    normalizedThreadId,
    payload,
    startupRole,
    LEADER_POST_START_RESUME_DELAYS_MS,
    "leader_post_start"
  );
  return resumedRunId ?? startedRunId;
}
async function routeToThreadWorkflow(normalizedThreadId, payload) {
  const firstResumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
  if (firstResumeAttempt.resumed) {
    return firstResumeAttempt.runId;
  }
  try {
    const firstMissReason = classifyResumeMiss(firstResumeAttempt.error);
    const leaderOwnerToken = createStartupLeaseToken();
    const claimedLeaderLease = await claimWorkflowStartupLeaseSafe(
      normalizedThreadId,
      leaderOwnerToken,
      STARTUP_LEASE_TTL_MS
    );
    if (claimedLeaderLease) {
      try {
        return await startWorkflowAndRetryResume({
          normalizedThreadId,
          payload,
          startupRole: "leader",
          resumeMissReason: firstMissReason,
          resumeMissError: firstResumeAttempt.error
        });
      } finally {
        await releaseWorkflowStartupLeaseSafe(normalizedThreadId, leaderOwnerToken);
      }
    }
    try {
      return await retryResume(
        normalizedThreadId,
        payload,
        "follower",
        FOLLOWER_RESUME_DELAYS_MS,
        "follower_wait"
      );
    } catch (followerRetryError) {
      const fallbackOwnerToken = createStartupLeaseToken();
      const claimedFallbackLease = await claimWorkflowStartupLeaseSafe(
        normalizedThreadId,
        fallbackOwnerToken,
        STARTUP_LEASE_TTL_MS
      );
      if (claimedFallbackLease) {
        try {
          return await startWorkflowAndRetryResume({
            normalizedThreadId,
            payload,
            startupRole: "leader",
            resumeMissReason: classifyResumeMiss(followerRetryError),
            resumeMissError: followerRetryError
          });
        } finally {
          await releaseWorkflowStartupLeaseSafe(normalizedThreadId, fallbackOwnerToken);
        }
      }
      return await retryResume(
        normalizedThreadId,
        payload,
        "follower",
        FINAL_SAFETY_RESUME_DELAYS_MS,
        "final_safety_wait"
      );
    }
  } catch (error) {
    throw error;
  }
}
export {
  routeToThreadWorkflow
};
