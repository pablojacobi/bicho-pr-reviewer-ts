/**
 * In-process background execution for webhook-triggered reviews.
 *
 * A webhook is acknowledged at once (202) and the review runs off-request. This is deliberately
 * **non-durable**: a restart drops an accepted-but-unfinished review (documented, and recoverable
 * via the manual endpoint). A semaphore bounds concurrency (default 1, matching the single
 * instance), and every task is isolated so one failure never touches another or the process.
 * {@link RecentDeliveries} short-circuits duplicate deliveries without any datastore.
 */

import type { ReviewService } from "../application/reviewService.ts";
import type { ReviewOptions, ReviewRequest } from "../domain/models/review.ts";
import { Semaphore } from "../infrastructure/model/semaphore.ts";

/** Supplies the review service for an installation (implemented by the container). */
export interface ReviewServiceProvider {
  reviewService(installationId?: number | null): ReviewService;
}

/**
 * The slice of a logger this runner needs.
 *
 * Structural rather than pino's `Logger`, so the API layer is not coupled to a logging library and
 * a test can pass a two-line recorder.
 */
export interface ErrorLogger {
  error(context: Record<string, unknown>, message: string): void;
}

/** A bounded, in-memory set of seen delivery ids, evicting oldest-first past `maxSize`. */
export class RecentDeliveries {
  readonly #maxSize: number;
  readonly #seen = new Set<string>();
  readonly #order: string[] = [];

  constructor(options: { maxSize?: number } = {}) {
    this.#maxSize = options.maxSize ?? 2048;
  }

  /** Record `deliveryId`; return `true` if new, `false` if already seen. */
  register(deliveryId: string): boolean {
    if (this.#seen.has(deliveryId)) {
      return false;
    }
    this.#seen.add(deliveryId);
    this.#order.push(deliveryId);
    if (this.#order.length > this.#maxSize) {
      this.#seen.delete(this.#order.shift() as string);
    }
    return true;
  }
}

/** Schedules reviews as isolated, concurrency-bounded background tasks. */
export class BackgroundReviewRunner {
  readonly deliveries = new RecentDeliveries();
  readonly #provider: ReviewServiceProvider;
  readonly #semaphore: Semaphore;
  readonly #logger: ErrorLogger;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(
    provider: ReviewServiceProvider,
    options: { concurrency?: number; logger: ErrorLogger },
  ) {
    this.#provider = provider;
    this.#semaphore = new Semaphore(options.concurrency ?? 1);
    this.#logger = options.logger;
  }

  /** Start a background review; returns immediately. */
  schedule(request: ReviewRequest, options: ReviewOptions): void {
    const task = this.#run(request, options);
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task));
  }

  async #run(request: ReviewRequest, options: ReviewOptions): Promise<void> {
    await this.#semaphore.run(async () => {
      try {
        await this.#provider.reviewService(request.installationId).run(request, options);
      } catch (error) {
        // A background review must never take the process down, and never surface to the sender:
        // the webhook was already acknowledged. Log it and move on; the next event can retry.
        this.#logger.error(
          { err: error, repository: request.repository, prNumber: request.prNumber },
          "background_review_failed",
        );
      }
    });
  }

  /** Await all in-flight reviews (used on shutdown and in tests). */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }
}
