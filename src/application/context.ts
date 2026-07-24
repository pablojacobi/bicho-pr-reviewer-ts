/**
 * The per-run review context injected into every graph node.
 *
 * Holds the ports and options a review needs, kept out of the graph *state* (which is pure data) so
 * nodes read dependencies from the runtime context rather than through globals. It is declared as
 * LangGraph's `contextSchema` — the direct analogue of the Python original's `context_schema` — and
 * supplied at invoke time, so one compiled graph serves every review.
 */

import { Annotation } from "@langchain/langgraph";
import type { ReviewOptions } from "../domain/models/review.ts";
import type { DiffParserPort } from "../domain/ports/diffParser.ts";
import type { GitHubPort } from "../domain/ports/github.ts";
import type { LanguageAdapterRegistry } from "../domain/ports/languageAdapter.ts";
import type { Analyzer } from "./analyzers/base.ts";
import type { FindingVerifier } from "./verifier.ts";

/** Dependencies and options for a single review run. */
export const ReviewContextAnnotation = Annotation.Root({
  github: Annotation<GitHubPort>(),
  diffParser: Annotation<DiffParserPort>(),
  adapters: Annotation<LanguageAdapterRegistry>(),
  analyzers: Annotation<ReadonlyMap<string, Analyzer>>(),
  verifier: Annotation<FindingVerifier>(),
  options: Annotation<ReviewOptions>(),
  correlationId: Annotation<string>(),
});

export type ReviewContext = typeof ReviewContextAnnotation.State;
