import { createHmac } from "node:crypto";
import {
  createWaitUntilCollector,
  type WaitUntilCollector,
} from "../wait-until";

export interface SlackWebhookClientOptions {
  signingSecret: string;
}

/** Build signed Slack webhook requests with deterministic test credentials. */
export class SlackWebhookTestClient {
  readonly signingSecret: string;

  constructor(options: SlackWebhookClientOptions) {
    this.signingSecret = options.signingSecret;
  }

  event(payload: unknown): Request {
    return this.json(payload);
  }

  form(params: URLSearchParams): Request {
    const body = params.toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    return this.request({
      body,
      contentType: "application/x-www-form-urlencoded",
      signature: this.sign(body, timestamp),
      timestamp,
    });
  }

  invalidSignature(payload: unknown): Request {
    return this.json(payload, "v0=invalid");
  }

  json(payload: unknown, signature?: string): Request {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return this.request({
      body,
      contentType: "application/json",
      signature: signature ?? this.sign(body, timestamp),
      timestamp,
    });
  }

  waitUntil(): WaitUntilCollector {
    return createWaitUntilCollector();
  }

  private request(args: {
    body: string;
    contentType: string;
    signature: string;
    timestamp: string;
  }): Request {
    return new Request("https://example.test/api/webhooks/slack", {
      method: "POST",
      headers: {
        "content-type": args.contentType,
        "x-slack-request-timestamp": args.timestamp,
        "x-slack-signature": args.signature,
      },
      body: args.body,
    });
  }

  private sign(body: string, timestamp: string): string {
    return `v0=${createHmac("sha256", this.signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
  }
}

/** Create a Slack webhook client for signed Events API and interaction tests. */
export function createSlackWebhookTestClient(
  options: SlackWebhookClientOptions,
): SlackWebhookTestClient {
  return new SlackWebhookTestClient(options);
}
