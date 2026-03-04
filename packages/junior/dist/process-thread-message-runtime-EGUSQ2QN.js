import {
  appSlackRuntime
} from "./chunk-3DWW2RBI.js";
import {
  downloadPrivateSlackFile
} from "./chunk-VA7IB7MV.js";
import "./chunk-OXCKLXL3.js";
import "./chunk-77IYZ6LP.js";

// src/chat/thread-runtime/process-thread-message-runtime.ts
function rehydrateAttachmentFetchers(payload) {
  for (const attachment of payload.message.attachments) {
    if (!attachment.fetchData && attachment.url) {
      attachment.fetchData = () => downloadPrivateSlackFile(attachment.url);
    }
  }
}
async function processThreadMessageRuntime(args) {
  const runtimePayload = {
    message: args.message,
    thread: args.thread
  };
  rehydrateAttachmentFetchers(runtimePayload);
  if (args.kind === "new_mention") {
    await appSlackRuntime.handleNewMention(args.thread, args.message);
    return;
  }
  await appSlackRuntime.handleSubscribedMessage(args.thread, args.message);
}
export {
  processThreadMessageRuntime
};
