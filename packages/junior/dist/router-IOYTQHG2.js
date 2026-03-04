import {
  claimWorkflowStartupLease
} from "./chunk-CUPIASST.js";
import "./chunk-OXUT4WDZ.js";
import {
  logError,
  logInfo,
  logWarn,
  withContext
} from "./chunk-OXCKLXL3.js";

// src/chat/workflow/router.ts
import { randomUUID } from "crypto";
import { start } from "workflow/api";

// src/chat/workflow/thread-workflow.ts
import { defineHook, getWorkflowMetadata } from "workflow";

// src/chat/workflow/thread-steps.ts
import { Message, ThreadImpl } from "chat";
import { WORKFLOW_DESERIALIZE } from "@workflow/serde";
var stateAdapterConnected = false;
function rehydrateAttachmentFetchers(payload, downloadPrivateFile) {
  for (const attachment of payload.message.attachments) {
    if (!attachment.fetchData && attachment.url) {
      attachment.fetchData = () => downloadPrivateFile(attachment.url);
    }
  }
}
function isSerializedThread(thread) {
  return typeof thread === "object" && thread !== null && thread._type === "chat:Thread";
}
function isSerializedMessage(message) {
  return typeof message === "object" && message !== null && message._type === "chat:Message";
}
function toRuntimeThread(thread) {
  if (isSerializedThread(thread)) {
    return ThreadImpl[WORKFLOW_DESERIALIZE](thread);
  }
  return thread;
}
function toRuntimeMessage(message) {
  if (isSerializedMessage(message)) {
    return Message[WORKFLOW_DESERIALIZE](message);
  }
  return message;
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
async function logThreadMessageFailureStep(payload, errorMessage, workflowRunId) {
  "use step";
  const { logError: logError2, withContext: withContext2 } = await import("./observability-Z2SJA73L.js");
  await withContext2(
    {
      slackThreadId: payload.normalizedThreadId,
      slackChannelId: getPayloadChannelId(payload),
      slackUserId: getPayloadUserId(payload),
      workflowRunId
    },
    async () => {
      logError2(
        "workflow_message_failed",
        {},
        {
          "app.workflow.message_kind": payload.kind,
          "messaging.message.id": payload.message.id,
          "error.message": errorMessage
        },
        "Thread workflow step failed"
      );
    }
  );
}
async function processThreadMessageStep(payload, workflowRunId) {
  "use step";
  const [{ appSlackRuntime, bot }, { withContext: withContext2, withSpan }, { downloadPrivateSlackFile }, { getStateAdapter }] = await Promise.all([
    import("./bot-5NOJLX62.js"),
    import("./observability-Z2SJA73L.js"),
    import("./client-KKELW3PT.js"),
    import("./state-GMR67ORW.js")
  ]);
  const resolvedWorkflowRunId = workflowRunId ?? getPayloadWorkflowRunId(payload);
  const threadWasSerialized = isSerializedThread(payload.thread);
  bot.registerSingleton();
  if (threadWasSerialized && !stateAdapterConnected) {
    await getStateAdapter().connect();
    stateAdapterConnected = true;
  }
  const runtimeThread = toRuntimeThread(payload.thread);
  const runtimeMessage = toRuntimeMessage(payload.message);
  const runtimePayload = {
    ...payload,
    thread: runtimeThread,
    message: runtimeMessage
  };
  rehydrateAttachmentFetchers(runtimePayload, downloadPrivateSlackFile);
  await withContext2(
    {
      slackThreadId: payload.normalizedThreadId,
      slackChannelId: runtimeThread.channelId,
      slackUserId: runtimeMessage.author.userId,
      workflowRunId: resolvedWorkflowRunId
    },
    async () => {
      await withSpan(
        "workflow.thread_message",
        "workflow.thread_message",
        {
          slackThreadId: payload.normalizedThreadId,
          slackChannelId: runtimeThread.channelId,
          slackUserId: runtimeMessage.author.userId,
          workflowRunId: resolvedWorkflowRunId
        },
        async () => {
          if (payload.kind === "new_mention") {
            await appSlackRuntime.handleNewMention(runtimeThread, runtimeMessage);
          } else {
            await appSlackRuntime.handleSubscribedMessage(runtimeThread, runtimeMessage);
          }
        },
        {
          "messaging.message.id": runtimeMessage.id,
          "app.workflow.message_kind": payload.kind
        }
      );
    }
  );
}
Object.assign(processThreadMessageStep, { maxRetries: 1 });
async function releaseWorkflowStartupLeaseStep(normalizedThreadId, startupLeaseOwnerToken) {
  "use step";
  const [{ releaseWorkflowStartupLease }, { logWarn: logWarn2 }] = await Promise.all([
    import("./state-GMR67ORW.js"),
    import("./observability-Z2SJA73L.js")
  ]);
  try {
    await releaseWorkflowStartupLease(normalizedThreadId, startupLeaseOwnerToken);
  } catch (error) {
    logWarn2(
      "workflow_startup_lease_release_failed",
      {},
      {
        "messaging.message.conversation_id": normalizedThreadId,
        "error.message": error instanceof Error ? error.message : String(error)
      },
      "Failed to release workflow startup lease after hook registration"
    );
  }
}

// src/chat/workflow/thread-workflow.ts
var MAX_DEDUP_KEYS = 500;
var DEDUP_TRIM_SIZE = Math.floor(MAX_DEDUP_KEYS / 2);
var threadMessageHook = defineHook();
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
async function slackThreadWorkflow(normalizedThreadId, startupLeaseOwnerToken) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const hook = threadMessageHook.create({
    token: normalizedThreadId
  });
  if (startupLeaseOwnerToken) {
    await releaseWorkflowStartupLeaseStep(normalizedThreadId, startupLeaseOwnerToken);
  }
  await processThreadPayloadStream(hook, workflowRunId);
}

// src/chat/workflow/router.ts
var LEADER_POST_START_RESUME_DELAYS_MS = [250, 750, 1500];
var FOLLOWER_RESUME_DELAYS_MS = [250, 750, 1500];
var FINAL_SAFETY_RESUME_DELAYS_MS = [250, 500];
var STARTUP_LEASE_TTL_MS = 3e3;
var WARN_RETRY_ATTEMPT = 3;
function getPayloadChannelId2(payload) {
  return payload.thread.channelId;
}
function getPayloadUserId2(payload) {
  return payload.message.author?.userId;
}
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    const logRetry = isWarnRetry ? logWarn : logInfo;
    logRetry(
      "workflow_route_resume_retry",
      {},
      {
        "app.workflow.retry_attempt": retryAttempt,
        "app.workflow.retry_reason": retryReason,
        "app.workflow.retry_severity": isWarnRetry ? "warn" : "info",
        "app.workflow.startup_role": startupRole,
        "app.workflow.retry_phase": retryPhase,
        ...retryReason !== "hook_not_found" ? { "error.message": getErrorMessage(resumeAttempt.error) } : {}
      },
      "Retrying workflow hook resume after startup race"
    );
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Failed to resume thread workflow hook after start");
}
async function startWorkflowAndRetryResume(args) {
  const { normalizedThreadId, payload, startupLeaseOwnerToken, startupRole, resumeMissReason, resumeMissError } = args;
  let startedRunId;
  let startError;
  let startOutcome = "started";
  try {
    const startedRun = await start(slackThreadWorkflow, [normalizedThreadId, startupLeaseOwnerToken]);
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
  logInfo(
    "workflow_route_start_attempt",
    {},
    {
      "app.workflow.message_kind": payload.kind,
      "app.workflow.startup_role": startupRole,
      "app.workflow.startup_lease": "acquired",
      ...startedRunId ? { "app.workflow.run_id": startedRunId } : {},
      "app.workflow.start_outcome": startOutcome,
      "app.workflow.resume_miss_reason": resumeMissReason,
      ...resumeMissReason !== "hook_not_found" && resumeMissError ? { "error.message": getErrorMessage(resumeMissError) } : {},
      ...startError ? { "app.workflow.start_error": getErrorMessage(startError) } : {}
    },
    "Starting thread workflow after expected resume miss"
  );
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
  return withContext(
    {
      slackThreadId: normalizedThreadId,
      slackChannelId: getPayloadChannelId2(payload),
      slackUserId: getPayloadUserId2(payload)
    },
    async () => {
      const firstResumeAttempt = await attemptResumeHook(normalizedThreadId, payload);
      if (firstResumeAttempt.resumed) {
        return firstResumeAttempt.runId;
      }
      try {
        const firstMissReason = classifyResumeMiss(firstResumeAttempt.error);
        const leaderOwnerToken = randomUUID();
        const claimedLeaderLease = await claimWorkflowStartupLease(
          normalizedThreadId,
          leaderOwnerToken,
          STARTUP_LEASE_TTL_MS
        );
        if (claimedLeaderLease) {
          return await startWorkflowAndRetryResume({
            normalizedThreadId,
            payload,
            startupLeaseOwnerToken: leaderOwnerToken,
            startupRole: "leader",
            resumeMissReason: firstMissReason,
            resumeMissError: firstResumeAttempt.error
          });
        }
        logInfo(
          "workflow_route_start_attempt",
          {},
          {
            "app.workflow.message_kind": payload.kind,
            "app.workflow.startup_role": "follower",
            "app.workflow.startup_lease": "contended",
            "app.workflow.start_outcome": "contended",
            "app.workflow.resume_miss_reason": firstMissReason
          },
          "Waiting for existing workflow startup lease holder"
        );
        try {
          return await retryResume(
            normalizedThreadId,
            payload,
            "follower",
            FOLLOWER_RESUME_DELAYS_MS,
            "follower_wait"
          );
        } catch (followerRetryError) {
          const fallbackOwnerToken = randomUUID();
          const claimedFallbackLease = await claimWorkflowStartupLease(
            normalizedThreadId,
            fallbackOwnerToken,
            STARTUP_LEASE_TTL_MS
          );
          if (claimedFallbackLease) {
            return await startWorkflowAndRetryResume({
              normalizedThreadId,
              payload,
              startupLeaseOwnerToken: fallbackOwnerToken,
              startupRole: "leader",
              resumeMissReason: classifyResumeMiss(followerRetryError),
              resumeMissError: followerRetryError
            });
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
        logError(
          "workflow_route_failed",
          {},
          {
            "app.workflow.message_kind": payload.kind,
            "error.message": error instanceof Error ? error.message : String(error)
          },
          "Failed to route message to thread workflow"
        );
        throw error;
      }
    }
  );
}
export {
  routeToThreadWorkflow
};
