import { createHmac } from "node:crypto";
import {
  createWaitUntilCollector,
  type WaitUntilCollector,
} from "./wait-until";

export interface TurnResumeTestClientOptions {
  juniorSecret: string;
}

export interface TurnResumeTestRequest {
  conversationId: string;
  expectedVersion: number;
  sessionId: string;
}

/**
 * Build signed internal timeout-resume requests with deterministic test secrets.
 */
export class TurnResumeTestClient {
  readonly juniorSecret: string;

  constructor(options: TurnResumeTestClientOptions) {
    this.juniorSecret = options.juniorSecret;
  }

  invalidSignature(payload: TurnResumeTestRequest): Request {
    return this.buildRequest({
      body: JSON.stringify(payload),
      signature: "v1=invalid",
      timestamp: Date.now().toString(),
    });
  }

  legacyRequest(payload: TurnResumeTestRequest): Request {
    const body = JSON.stringify({
      conversationId: payload.conversationId,
      expectedCheckpointVersion: payload.expectedVersion,
      sessionId: payload.sessionId,
    });
    const timestamp = Date.now().toString();
    return this.buildRequest({
      body,
      signature: this.sign(body, timestamp),
      timestamp,
    });
  }

  request(payload: TurnResumeTestRequest): Request {
    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    return this.buildRequest({
      body,
      signature: this.sign(body, timestamp),
      timestamp,
    });
  }

  waitUntil(): WaitUntilCollector {
    return createWaitUntilCollector();
  }

  private buildRequest(args: {
    body: string;
    signature: string;
    timestamp: string;
  }): Request {
    return new Request("https://junior.example.com/api/internal/turn-resume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-junior-resume-signature": args.signature,
        "x-junior-resume-timestamp": args.timestamp,
      },
      body: args.body,
    });
  }

  private sign(body: string, timestamp: string): string {
    const digest = createHmac("sha256", this.juniorSecret)
      .update(`junior.turn_timeout_resume.v1:${timestamp}:${body}`)
      .digest("hex");
    return `v1=${digest}`;
  }
}

/** Create a signed timeout-resume request client for handler tests. */
export function createTurnResumeTestClient(
  options: TurnResumeTestClientOptions,
): TurnResumeTestClient {
  return new TurnResumeTestClient(options);
}
