import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileUploadCalls,
  type CapturedSlackApiCall,
  type CapturedSlackFileUploadCall,
  type SlackApiMethod,
} from "../msw/handlers/slack-api";

/** Read-only outbox for Slack MSW calls captured during a test. */
export class SlackApiOutbox {
  calls(method?: SlackApiMethod): CapturedSlackApiCall[] {
    return getCapturedSlackApiCalls(method);
  }

  fileUploads(): CapturedSlackFileUploadCall[] {
    return getCapturedSlackFileUploadCalls();
  }

  homeViews(): CapturedSlackApiCall[] {
    return this.calls("views.publish");
  }

  messages(): CapturedSlackApiCall[] {
    return this.calls("chat.postMessage");
  }

  reactionAdds(): CapturedSlackApiCall[] {
    return this.calls("reactions.add");
  }

  reactionRemovals(): CapturedSlackApiCall[] {
    return this.calls("reactions.remove");
  }

  reactions(): CapturedSlackApiCall[] {
    return this.reactionAdds();
  }
}

export const slackApiOutbox = new SlackApiOutbox();
