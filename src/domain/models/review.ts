/** Review request, options, and the composed review draft. */

import { z } from "zod";
import { type Category, DiffSide } from "./finding.ts";

/** What triggered a review. */
export const ReviewTrigger = {
  WEBHOOK: "webhook",
  MANUAL: "manual",
} as const;
export type ReviewTrigger = (typeof ReviewTrigger)[keyof typeof ReviewTrigger];

/** The GitHub review event to submit (Bicho uses COMMENT or REQUEST_CHANGES, never APPROVE). */
export const ReviewEvent = {
  COMMENT: "COMMENT",
  REQUEST_CHANGES: "REQUEST_CHANGES",
  APPROVE: "APPROVE",
} as const;
export type ReviewEvent = (typeof ReviewEvent)[keyof typeof ReviewEvent];

/** The outcome of a review run. */
export const ReviewStatus = {
  DRY_RUN: "dry_run",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  STALE: "stale",
  FAILED: "failed",
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

/** Per-review options, identical for the webhook and manual paths. */
export interface ReviewOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly focus: string | null;
  readonly categories: readonly Category[];
}

/** Build {@link ReviewOptions}, defaulting every field to the webhook-path behaviour. */
export function makeReviewOptions(options: Partial<ReviewOptions> = {}): ReviewOptions {
  return {
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    focus: options.focus ?? null,
    categories: options.categories ?? [],
  };
}

/** The input to a review: which PR to review and why. */
export interface ReviewRequest {
  readonly repository: string;
  readonly prNumber: number;
  readonly installationId: number | null;
  readonly headShaHint: string | null;
  readonly trigger: ReviewTrigger;
}

/** A single inline comment to place on the diff. */
export const inlineCommentSchema = z
  .object({
    path: z.string(),
    line: z.int().min(1),
    body: z.string(),
    side: z.enum(DiffSide).default(DiffSide.RIGHT),
    startLine: z.int().min(1).nullable().default(null),
    startSide: z.enum(DiffSide).nullable().default(null),
  })
  .refine((comment) => comment.startLine === null || comment.startLine <= comment.line, {
    message: "startLine must be less than or equal to line",
    path: ["startLine"],
  });

export type InlineComment = Readonly<z.output<typeof inlineCommentSchema>>;
export type InlineCommentInput = z.input<typeof inlineCommentSchema>;

/** Validate and build an {@link InlineComment}. */
export function makeInlineComment(input: InlineCommentInput): InlineComment {
  return inlineCommentSchema.parse(input);
}

/** Whether this comment spans more than one line. */
export function isMultiline(comment: InlineComment): boolean {
  return comment.startLine !== null;
}

/** The composed review: a summary, an event, and inline comments, anchored to a commit. */
export interface ReviewDraft {
  readonly summary: string;
  readonly event: ReviewEvent;
  readonly commitId: string;
  readonly inlineComments: readonly InlineComment[];
}

/** A review already on the PR, used to detect Bicho's own prior review via its marker. */
export interface ExistingReview {
  readonly id: number;
  readonly author: string;
  readonly body: string;
}

/** The result of running the review pipeline. */
export interface ReviewResult {
  readonly status: ReviewStatus;
  readonly draft: ReviewDraft | null;
  readonly confirmedCount: number;
  readonly totalCount: number;
  readonly reviewId: number | null;
}
