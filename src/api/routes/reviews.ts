/**
 * Manual review endpoint.
 *
 * `POST /reviews` runs the same `ReviewService.run` as the webhook path. With `dryRun` (the
 * default) it returns the composed draft — summary plus the inline comments that *would* be posted
 * — without touching GitHub, so the pipeline can be exercised end to end from curl or the OpenAPI
 * UI before any credentials or live publishing exist.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Category } from "../../domain/models/finding.ts";
import {
  makeReviewOptions,
  type ReviewRequest,
  ReviewTrigger,
} from "../../domain/models/review.ts";
import { jsonSchema } from "../schema.ts";

/** Request body for a manual review. */
const reviewRequestBodySchema = z.object({
  repository: z.string().min(1).describe("owner/repo, e.g. octo/hello-world"),
  prNumber: z.int().min(1).describe("The pull request number."),
  installationId: z.int().nullable().default(null),
  dryRun: z.boolean().default(true).describe("Compose the review without publishing it."),
  force: z.boolean().default(false).describe("Review again even if this head was reviewed."),
  focus: z.string().nullable().default(null),
  categories: z.array(z.enum(Category)).default([]),
});

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/reviews",
    {
      schema: {
        tags: ["reviews"],
        summary: "Run a review for a pull request",
        body: jsonSchema(reviewRequestBodySchema),
      },
    },
    async (request) => {
      const body = reviewRequestBodySchema.parse(request.body);
      const reviewRequest: ReviewRequest = {
        repository: body.repository,
        prNumber: body.prNumber,
        installationId: body.installationId,
        headShaHint: null,
        trigger: ReviewTrigger.MANUAL,
      };
      const options = makeReviewOptions({
        dryRun: body.dryRun,
        force: body.force,
        focus: body.focus,
        categories: body.categories,
      });
      const result = await app.container
        .reviewService(body.installationId)
        .run(reviewRequest, options);
      return {
        status: result.status,
        confirmedCount: result.confirmedCount,
        totalCount: result.totalCount,
        draft: result.draft,
        reviewId: result.reviewId,
      };
    },
  );
}
