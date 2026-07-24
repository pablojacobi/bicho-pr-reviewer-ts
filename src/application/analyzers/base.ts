/**
 * The base LLM analyzer: render a prompt, call the model, normalize findings.
 *
 * A failed model call becomes a degraded `AnalyzerOutcome` (never an exception), so the graph's
 * parallel superstep is not rolled back. Invalid line ranges from the model are clamped, not
 * dropped: a real issue reported with a sloppy range is still worth surfacing.
 */

import { type AnalyzerOutcome, makeOutcome, OutcomeStatus } from "../../domain/models/analysis.ts";
import type { NormalizedDiff } from "../../domain/models/diff.ts";
import {
  type Category,
  DiffSide,
  type Finding,
  makeFinding,
  SourceKind,
} from "../../domain/models/finding.ts";
import type { LanguageAdapter } from "../../domain/ports/languageAdapter.ts";
import { type ModelProvider, makeRunMeta } from "../../domain/ports/modelProvider.ts";
import type { IdGenerator } from "../../domain/ports/system.ts";
import { computeFingerprint } from "../../domain/services/fingerprint.ts";
import { getPrompt, PROMPT_VERSION } from "../prompts/registry.ts";
import { type AnalyzerReport, analyzerReportSchema, type RawFinding } from "./schemas.ts";

const LINE_PREFIX: Readonly<Record<string, string>> = {
  added: "+",
  removed: "-",
  context: " ",
};

/** Everything an analyzer needs about the pull request under review. */
export interface AnalysisContext {
  readonly diff: NormalizedDiff;
  readonly headSha: string;
  readonly language: string;
  readonly framework: string | null;
  readonly correlationId: string;
  readonly adapter: LanguageAdapter;
  readonly fileContents: ReadonlyMap<string, string>;
}

/** Runs one analyzer over the PR context and returns an outcome (never throws). */
export interface Analyzer {
  analyze(context: AnalysisContext): Promise<AnalyzerOutcome>;
}

/** Render the diff as annotated text for an analyzer prompt. */
export function renderDiff(diff: NormalizedDiff): string {
  return diff.files
    .map((file) => {
      const lines = [`### ${file.path} (${file.changeKind})`];
      for (const hunk of file.hunks) {
        lines.push(`@@ ${hunk.sectionHeading}`.trimEnd());
        for (const line of hunk.lines) {
          const number = line.newLine ?? line.oldLine;
          lines.push(`${number}\t${LINE_PREFIX[line.kind]}${line.content}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Runs one LLM analyzer role and normalizes its output into domain findings. */
export class LLMAnalyzer implements Analyzer {
  readonly #role: string;
  readonly #category: Category;
  readonly #model: ModelProvider;
  readonly #ids: IdGenerator;

  constructor(options: {
    role: string;
    category: Category;
    model: ModelProvider;
    ids: IdGenerator;
  }) {
    this.#role = options.role;
    this.#category = options.category;
    this.#model = options.model;
    this.#ids = options.ids;
  }

  async analyze(context: AnalysisContext): Promise<AnalyzerOutcome> {
    const prompt = `${getPrompt(this.#role)}\n\n## Diff\n${renderDiff(context.diff)}\n`;
    const result = await this.#model.structured<AnalyzerReport>({
      prompt,
      schema: analyzerReportSchema,
      schemaName: "report_findings",
      meta: makeRunMeta({
        role: this.#role,
        promptVersion: PROMPT_VERSION,
        correlationId: context.correlationId,
      }),
    });

    if (!result.ok) {
      return makeOutcome({
        source: this.#role,
        status: OutcomeStatus.ERROR,
        diagnostics: [{ source: this.#role, status: OutcomeStatus.ERROR, message: result.error }],
      });
    }

    const findings = result.value.findings.map((raw) =>
      this.#toFinding(raw, context, result.modelId),
    );
    return makeOutcome({
      source: this.#role,
      status: findings.length > 0 ? OutcomeStatus.OK : OutcomeStatus.ZERO_FINDINGS,
      findings,
    });
  }

  #toFinding(raw: RawFinding, context: AnalysisContext, modelId: string): Finding {
    const content = context.fileContents.get(raw.path);
    const symbol =
      content === undefined
        ? null
        : context.adapter.enclosingSymbol(raw.path, content, raw.startLine);
    return makeFinding({
      id: this.#ids.newId(),
      fingerprint: computeFingerprint({
        path: raw.path,
        category: this.#category,
        subcategory: raw.subcategory,
        ruleKey: raw.subcategory,
        enclosingSymbol: symbol,
        snippet: raw.snippet,
      }),
      category: this.#category,
      subcategory: raw.subcategory,
      severity: raw.severity,
      confidence: raw.confidence,
      title: raw.title,
      explanation: raw.explanation,
      impact: raw.impact,
      recommendation: raw.recommendation,
      path: raw.path,
      startLine: raw.startLine,
      // Clamp rather than reject: models routinely emit an end before the start.
      endLine: Math.max(raw.startLine, raw.endLine),
      diffSide: DiffSide.RIGHT,
      snippet: raw.snippet,
      sourceKind: SourceKind.LLM_ANALYZER,
      sourceName: this.#role,
      headSha: context.headSha,
      promptVersion: PROMPT_VERSION,
      modelId,
      language: context.language,
      framework: context.framework,
    });
  }
}
