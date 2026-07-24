/**
 * The TypeScript/JavaScript language adapter.
 *
 * Its value over {@link GenericAdapter} is AST-based enclosing-symbol resolution: a finding's
 * fingerprint anchors to the function/class/method that contains it, so the finding survives
 * unrelated line drift elsewhere in the file. TS and JS share one adapter because oxc parses both
 * with the same grammar and they share the same dependency manifests, so splitting them would only
 * duplicate every method for no behavioural difference.
 */

import { posix } from "node:path";
import { parseSync } from "oxc-parser";
import type { ChangedFile } from "../../domain/models/pullRequest.ts";
import type { LanguageAdapter } from "../../domain/ports/languageAdapter.ts";
import { isGeneratedOrVendored, isSafeRelativePath } from "../fs/pathsafe.ts";
import { DEFAULT_ANALYZERS } from "./genericAdapter.ts";

/** Extensions oxc parses as TS/JS source; anything else has no grammar this adapter understands. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** Dependency/compiler manifests that are in scope even though they are not source files. */
const MANIFEST_BASENAMES = new Set(["package.json", "tsconfig.json", "package-lock.json"]);

/** A named, fingerprint-worthy AST node: its symbol name plus the offset span it covers. */
interface NamedSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The `.name` of an oxc `Identifier`/`PrivateIdentifier`-shaped node, or `null` if it has none. */
function identifierName(value: unknown): string | null {
  return isRecord(value) && typeof value["name"] === "string" ? value["name"] : null;
}

/** Whether `value` is an oxc arrow-function or `function`-expression node. */
function isFunctionExpression(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value["type"] === "ArrowFunctionExpression" || value["type"] === "FunctionExpression")
  );
}

/**
 * The symbol name `node` contributes, for the node kinds the spec treats as fingerprint-worthy named
 * scopes: a function/class declaration, a class method, a class field initialized to a function, or a
 * variable initialized to a function/arrow expression. Every other node — including every other node
 * kind oxc's grammar produces — contributes no name, so a queried line falls through to whichever
 * enclosing named node (if any) still contains it.
 */
function namedSymbol(node: Record<string, unknown>): string | null {
  switch (node["type"]) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return identifierName(node["id"]);
    case "MethodDefinition":
      return identifierName(node["key"]);
    case "PropertyDefinition":
      return isFunctionExpression(node["value"]) ? identifierName(node["key"]) : null;
    case "VariableDeclarator":
      return isFunctionExpression(node["init"]) ? identifierName(node["id"]) : null;
    default:
      return null;
  }
}

/** `node`'s {@link NamedSpan}, or `null` if it is not one of the kinds {@link namedSymbol} names. */
function namedSpan(node: Record<string, unknown>): NamedSpan | null {
  const name = namedSymbol(node);
  if (name === null) {
    return null;
  }
  // Every oxc AST node carries numeric `start`/`end` per its `Span` base shape; `namedSymbol` only
  // returns non-null for nodes it already matched by `.type`, which are always real AST nodes.
  return { name, start: node["start"] as number, end: node["end"] as number };
}

/**
 * Recursively visit every node in an oxc AST.
 *
 * oxc's parsed output is a plain, acyclic JSON tree — no `parent` back-references — so a naive
 * recursive walk over every array element and object property is safe. The walk does not special-case
 * particular field names: oxc's grammar has hundreds of node shapes across JS, JSX, and TS syntax, and
 * a fixed set of "known" fields would silently stop descending into whichever ones it forgot. Visiting
 * and recursing into everything is what makes the walk correct for whatever oxc hands back.
 */
function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  visit(node);
  for (const value of Object.values(node)) {
    walk(value, visit);
  }
}

/**
 * The offset range `line` (1-based) spans within `content`, or `null` if `content` has fewer lines.
 *
 * oxc's AST nodes carry `start`/`end` as UTF-16 code-unit offsets — the same units as a native JS
 * string's `.length` and indexing — not UTF-8 byte offsets, so plain `.length` accumulation across
 * lines lines up with them exactly, including for lines containing multi-byte or surrogate-pair
 * characters.
 */
function lineOffsetRange(content: string, line: number): { start: number; end: number } | null {
  let offset = 0;
  let currentLine = 1;
  for (const text of content.split("\n")) {
    if (currentLine === line) {
      return { start: offset, end: offset + text.length };
    }
    offset += text.length + 1; // +1 for the newline `split` consumed.
    currentLine += 1;
  }
  return null;
}

function hasSourceExtension(filename: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => filename.endsWith(extension));
}

/** Whether `filename` is TS/JS source, or one of the manifests describing a TS/JS project. */
function isTypeScriptRelevant(filename: string): boolean {
  return hasSourceExtension(filename) || MANIFEST_BASENAMES.has(posix.basename(filename));
}

/** Language adapter for TypeScript and JavaScript repositories. */
export class TypeScriptAdapter implements LanguageAdapter {
  readonly language = "typescript";

  score(files: readonly ChangedFile[]): number {
    return files.some((file) => hasSourceExtension(file.filename)) ? 0.9 : 0.0;
  }

  inScope(file: ChangedFile): boolean {
    if (file.patch === null || !isSafeRelativePath(file.filename)) {
      return false;
    }
    if (isGeneratedOrVendored(file.filename)) {
      return false;
    }
    return isTypeScriptRelevant(file.filename);
  }

  defaultAnalyzers(): readonly string[] {
    return DEFAULT_ANALYZERS;
  }

  /**
   * Resolve the innermost function/class/method whose span contains `line`.
   *
   * "Innermost" is the containing named node with the smallest `end - start` span. We score every
   * match instead of just keeping the last (or first) one found, because two sibling declarations can
   * both legitimately "contain" the same queried line — e.g. `} function next() {` puts the end of one
   * declaration and the start of the next on one line — and only an explicit size comparison picks the
   * more specific one deterministically in that case; nested containment alone would also work, but
   * would not cover that sibling case.
   *
   * oxc does not throw on invalid syntax: `errors` is populated and `program` is whatever it still
   * managed to parse (often an empty program, for badly broken input). There is no need to branch on
   * `errors` — walking whatever parsed and finding no containing symbol already yields the same `null`.
   */
  enclosingSymbol(path: string, content: string, line: number): string | null {
    if (!hasSourceExtension(path)) {
      return null;
    }
    const range = lineOffsetRange(content, line);
    if (range === null) {
      return null;
    }

    const { program } = parseSync(path, content);
    const candidates: NamedSpan[] = [];
    walk(program, (node) => {
      const span = namedSpan(node);
      if (span === null) {
        return;
      }
      if (span.start > range.end || span.end < range.start) {
        return;
      }
      candidates.push(span);
    });

    let best: NamedSpan | null = null;
    for (const candidate of candidates) {
      if (best === null || candidate.end - candidate.start < best.end - best.start) {
        best = candidate;
      }
    }
    return best === null ? null : best.name;
  }
}
