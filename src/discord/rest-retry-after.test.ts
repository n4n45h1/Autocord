import { performance } from "node:perf_hooks";
import { Client, GatewayIntentBits, type ClientOptions } from "discord.js";
import { describe, expect, it, vi } from "vitest";

type RestResponse = Awaited<ReturnType<NonNullable<NonNullable<ClientOptions["rest"]>["makeRequest"]>>>;

describe("Discord REST 429 Retry-After backoff", () => {
  it("respects consecutive fractional Retry-After headers before recovering", async () => {
    // Keep this test fast while verifying that the waits really occur.
    const retryAfterSeconds = [0.08, 0.12];
    const requestTimes: number[] = [];

    // Exercise the real discord.js REST manager used by Autocord, without
    // connecting to Discord or using a real bot token.
    const makeRequest = vi.fn(async () => {
      const attempt = requestTimes.push(performance.now()) - 1;
      if (attempt < retryAfterSeconds.length) {
        const retryAfter = retryAfterSeconds[attempt]!;
        return new Response(
          JSON.stringify({
            message: "You are being rate limited.",
            retry_after: retryAfter,
            global: false,
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(retryAfter),
              "X-RateLimit-Limit": "1",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset-After": String(retryAfter),
              "X-RateLimit-Bucket": "autocord-test-bucket",
              "X-RateLimit-Scope": "user",
            },
          },
        ) as unknown as RestResponse;
      }

      return new Response(
        JSON.stringify({ id: "222222222222222222", content: "recovered" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as RestResponse;
    });

    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
      rest: { makeRequest, offset: 0, retries: 0 },
    });

    try {
      client.rest.setToken("fake-test-token");
      const result = await client.rest.get(
        "/channels/111111111111111111/messages/222222222222222222",
      );

      expect(result).toMatchObject({
        id: "222222222222222222",
        content: "recovered",
      });
      expect(makeRequest).toHaveBeenCalledTimes(3);

      // A 429 is not permission to retry immediately. Each successive
      // request must wait for the corresponding Retry-After value (seconds).
      // Allow a small timer/clock tolerance to avoid flaky tests in CI.
      for (let i = 0; i < retryAfterSeconds.length; i++) {
        const elapsedMs = requestTimes[i + 1]! - requestTimes[i]!;
        expect(elapsedMs).toBeGreaterThanOrEqual(
          retryAfterSeconds[i]! * 1_000 - 15,
        );
      }
    } finally {
      await client.destroy();
    }
  });
});
