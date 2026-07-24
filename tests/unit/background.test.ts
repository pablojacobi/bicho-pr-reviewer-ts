import { describe, expect, it } from "vitest";
import {
  BackgroundReviewRunner,
  type ErrorLogger,
  RecentDeliveries,
  type ReviewServiceProvider,
} from "../../src/api/background.ts";
import type { ReviewService } from "../../src/application/reviewService.ts";
import {
  makeReviewOptions,
  type ReviewRequest,
  type ReviewResult,
  ReviewStatus,
  ReviewTrigger,
} from "../../src/domain/models/review.ts";

/** A manually-resolvable promise, so a test can control exactly when a task "finishes". */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function aRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    repository: "octo/hello-world",
    prNumber: 42,
    installationId: 7,
    headShaHint: null,
    trigger: ReviewTrigger.WEBHOOK,
    ...overrides,
  };
}

function aResult(): ReviewResult {
  return {
    status: ReviewStatus.COMPLETED,
    draft: null,
    confirmedCount: 0,
    totalCount: 0,
    reviewId: null,
  };
}

function anErrorLogger(): {
  logger: ErrorLogger;
  calls: { context: Record<string, unknown>; message: string }[];
} {
  const calls: { context: Record<string, unknown>; message: string }[] = [];
  return {
    logger: {
      error(context, message) {
        calls.push({ context, message });
      },
    },
    calls,
  };
}

describe("RecentDeliveries", () => {
  it("registers a new delivery id as true, and a repeat as false", () => {
    const deliveries = new RecentDeliveries();

    expect(deliveries.register("d1")).toBe(true);
    expect(deliveries.register("d1")).toBe(false);
  });

  it("evicts the oldest id once past maxSize, so it registers as new again", () => {
    const deliveries = new RecentDeliveries({ maxSize: 2 });
    deliveries.register("a");
    deliveries.register("b");
    deliveries.register("c"); // past maxSize=2: evicts "a", the oldest

    expect(deliveries.register("b")).toBe(false); // still remembered
    expect(deliveries.register("c")).toBe(false); // still remembered
    expect(deliveries.register("a")).toBe(true); // evicted, so this is a fresh registration
  });
});

describe("BackgroundReviewRunner", () => {
  it("returns immediately from schedule and runs the review afterwards, observable via drain", async () => {
    let ran = false;
    const service = {
      run: async () => {
        ran = true;
        return aResult();
      },
    } as unknown as ReviewService;
    const provider: ReviewServiceProvider = { reviewService: () => service };
    const { logger } = anErrorLogger();
    const runner = new BackgroundReviewRunner(provider, { logger });

    runner.schedule(aRequest(), makeReviewOptions());

    expect(ran).toBe(false);

    await runner.drain();

    expect(ran).toBe(true);
  });

  it("logs a rejected review via the injected ErrorLogger, without rejecting drain or the process", async () => {
    const failure = new Error("provider exploded");
    const service = {
      run: async () => {
        throw failure;
      },
    } as unknown as ReviewService;
    const provider: ReviewServiceProvider = { reviewService: () => service };
    const { logger, calls } = anErrorLogger();
    const runner = new BackgroundReviewRunner(provider, { logger });
    const request = aRequest({ repository: "octo/broken", prNumber: 99 });

    runner.schedule(request, makeReviewOptions());

    await expect(runner.drain()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("background_review_failed");
    expect(calls[0]?.context).toMatchObject({
      err: failure,
      repository: "octo/broken",
      prNumber: 99,
    });
  });

  it("resolves drain immediately when nothing is in flight", async () => {
    const provider: ReviewServiceProvider = {
      reviewService: () => {
        throw new Error("should not be called");
      },
    };
    const { logger } = anErrorLogger();
    const runner = new BackgroundReviewRunner(provider, { logger });

    await expect(runner.drain()).resolves.toBeUndefined();
  });

  it("does not overlap two scheduled reviews under the default concurrency of 1", async () => {
    const events: string[] = [];
    const gate = deferred<void>();
    const service = {
      run: async (request: ReviewRequest) => {
        const label = request.prNumber === 1 ? "first" : "second";
        events.push(`${label}-start`);
        if (label === "first") {
          await gate.promise;
        }
        events.push(`${label}-end`);
        return aResult();
      },
    } as unknown as ReviewService;
    const provider: ReviewServiceProvider = { reviewService: () => service };
    const { logger } = anErrorLogger();
    const runner = new BackgroundReviewRunner(provider, { logger });

    runner.schedule(aRequest({ prNumber: 1 }), makeReviewOptions());
    runner.schedule(aRequest({ prNumber: 2 }), makeReviewOptions());

    gate.resolve();
    await runner.drain();

    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("asks the provider for the service using the request's installationId", async () => {
    const service = { run: async () => aResult() } as unknown as ReviewService;
    const requestedIds: (number | null | undefined)[] = [];
    const provider: ReviewServiceProvider = {
      reviewService: (installationId) => {
        requestedIds.push(installationId);
        return service;
      },
    };
    const { logger } = anErrorLogger();
    const runner = new BackgroundReviewRunner(provider, { logger });

    runner.schedule(aRequest({ installationId: 555 }), makeReviewOptions());
    await runner.drain();

    expect(requestedIds).toEqual([555]);
  });
});
