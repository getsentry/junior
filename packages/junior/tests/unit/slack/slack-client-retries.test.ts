import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackActionError, withSlackRetries } from "@/chat/slack/client";

describe("withSlackRetries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries rate-limited calls using Slack retryAfter", async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        code: "slack_webapi_rate_limited_error",
        statusCode: 429,
        retryAfter: 1,
        message: "rate limited",
      })
      .mockResolvedValue("ok");

    const promise = withSlackRetries(task, 3);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("caps a huge Retry-After header instead of honoring it verbatim", async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        code: "slack_webapi_rate_limited_error",
        statusCode: 429,
        retryAfter: 3600,
        message: "rate limited",
      })
      .mockResolvedValue("ok");

    const promise = withSlackRetries(task, 3);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("stops retrying once the total retry delay budget is exhausted", async () => {
    vi.useFakeTimers();
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      code: "slack_webapi_rate_limited_error",
      statusCode: 429,
      retryAfter: 3600,
      message: "rate limited",
    });

    const outcome = withSlackRetries(task, 5).catch((error: unknown) => error);
    // Two capped 10s pauses spend the 20s budget; the third failure is final
    // even though attempts remain.
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(outcome).resolves.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "rate_limited",
      }),
    );
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("retries connection-phase network failures that never reached Slack", async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        code: "slack_webapi_request_error",
        message: "A request error occurred: socket hang up",
        original: { code: "ECONNRESET", message: "socket hang up" },
      })
      .mockResolvedValue("ok");

    const promise = withSlackRetries(task, 3, { action: "chat.postMessage" });
    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("retries Slack 5xx responses", async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        code: "slack_webapi_http_error",
        statusCode: 503,
        message: "An HTTP protocol error occurred: statusCode = 503",
      })
      .mockResolvedValue("ok");

    const promise = withSlackRetries(task, 3, { action: "chat.postMessage" });
    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not retry a timed-out post that Slack may have accepted", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      code: "slack_webapi_request_error",
      message: "A request error occurred: ETIMEDOUT",
      original: { code: "ETIMEDOUT" },
    });

    await expect(
      withSlackRetries(task, 3, { action: "chat.postMessage" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "internal_error",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("retries a timed-out idempotent read", async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        code: "slack_webapi_request_error",
        message: "A request error occurred: ETIMEDOUT",
        original: { code: "ETIMEDOUT" },
      })
      .mockResolvedValue("ok");

    const promise = withSlackRetries(task, 3, {
      action: "conversations.replies",
      idempotent: true,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable API errors", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "missing_scope",
        needed: "files:write",
        provided: "chat:write",
      },
      message: "missing scope",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "missing_scope",
        needed: "files:write",
        provided: "chat:write",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("does not retry internal errors", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      message: "unknown failure",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "internal_error",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps canvas_creation_failed as a dedicated non-retryable error", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "canvas_creation_failed",
      },
      message: "An API error occurred: canvas_creation_failed",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "canvas_creation_failed",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("extracts structured canvas validation detail from Slack errors", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "canvas_creation_failed",
        detail: "'content' error: line 55: Unsupported heading depth (4)",
      },
      message: "An API error occurred: canvas_creation_failed",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "canvas_creation_failed",
        detail: "'content' error: line 55: Unsupported heading depth (4)",
        detailLine: 55,
        detailRule: "unsupported_heading_depth",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps canvas_editing_failed as a dedicated non-retryable error", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "canvas_editing_failed",
      },
      message: "An API error occurred: canvas_editing_failed",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "canvas_editing_failed",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps invalid_name as invalid_arguments", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "invalid_name",
      },
      message: "An API error occurred: invalid_name",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "invalid_arguments",
        apiError: "invalid_name",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps invalid_cursor as invalid_arguments while preserving the API error", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "invalid_cursor",
      },
      message: "An API error occurred: invalid_cursor",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "invalid_arguments",
        apiError: "invalid_cursor",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps already_reacted as a dedicated Slack action error", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "already_reacted",
      },
      message: "An API error occurred: already_reacted",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "already_reacted",
        apiError: "already_reacted",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps no_reaction as a dedicated Slack action error", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "no_reaction",
      },
      message: "An API error occurred: no_reaction",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "no_reaction",
        apiError: "no_reaction",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe("mapSlackError - read_only_channel", () => {
  it("maps restricted_action_read_only_channel as read_only_channel", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "restricted_action_read_only_channel",
      },
      message: "An API error occurred: restricted_action_read_only_channel",
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "read_only_channel",
        apiError: "restricted_action_read_only_channel",
      }),
    );
    expect(task).toHaveBeenCalledTimes(1);
  });
});
