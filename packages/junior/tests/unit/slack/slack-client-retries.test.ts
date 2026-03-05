import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackActionError, withSlackRetries } from "@/chat/slack-actions/client";

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
        message: "rate limited"
      })
      .mockResolvedValue("ok");

    const promise = withSlackRetries(task, 3);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable API errors", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "missing_scope",
        needed: "files:write",
        provided: "chat:write"
      },
      message: "missing scope"
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "missing_scope",
        needed: "files:write",
        provided: "chat:write"
      })
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("does not retry internal errors", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      message: "unknown failure"
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "internal_error"
      })
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps canvas_creation_failed as a dedicated non-retryable error", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "canvas_creation_failed"
      },
      message: "An API error occurred: canvas_creation_failed"
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "canvas_creation_failed"
      })
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("extracts structured canvas validation detail from Slack errors", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "canvas_creation_failed",
        detail: "'content' error: line 55: Unsupported heading depth (4)"
      },
      message: "An API error occurred: canvas_creation_failed"
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "canvas_creation_failed",
        detail: "'content' error: line 55: Unsupported heading depth (4)",
        detailLine: 55,
        detailRule: "unsupported_heading_depth"
      })
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps canvas_editing_failed as a dedicated non-retryable error", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "canvas_editing_failed"
      },
      message: "An API error occurred: canvas_editing_failed"
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "canvas_editing_failed"
      })
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("maps invalid_name as invalid_arguments", async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue({
      data: {
        error: "invalid_name"
      },
      message: "An API error occurred: invalid_name"
    });

    await expect(withSlackRetries(task, 3)).rejects.toEqual(
      expect.objectContaining<Partial<SlackActionError>>({
        name: "SlackActionError",
        code: "invalid_arguments",
        apiError: "invalid_name"
      })
    );
    expect(task).toHaveBeenCalledTimes(1);
  });
});
