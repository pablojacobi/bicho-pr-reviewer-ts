/**
 * Composition root: assembles the review pipeline from settings.
 *
 * This is the single place where concrete infrastructure (GitHub client, model provider, diff
 * parser, adapters, analyzers, scanners) is wired together into a {@link ReviewService}. Everything
 * upstream depends on ports, so this module is the only one that knows every concrete type.
 */

import type { Analyzer } from "../application/analyzers/base.ts";
import { buildAnalyzers } from "../application/analyzers/registry.ts";
import { buildGraph, type ReviewGraph } from "../application/graph/builder.ts";
import { ReviewService } from "../application/reviewService.ts";
import {
  type FindingVerifier,
  LLMFindingVerifier,
  PolicyVerifier,
} from "../application/verifier.ts";
import { activeProvider, type Settings } from "../config/settings.ts";
import type { ModelProvider } from "../domain/ports/modelProvider.ts";
import type {
  Clock,
  IdGenerator,
  SubprocessRunner,
  TempWorkspace,
} from "../domain/ports/system.ts";
import { SystemClock } from "../infrastructure/clock.ts";
import { DiffParser } from "../infrastructure/diff/hunkParser.ts";
import { TempWorkspaceFactory } from "../infrastructure/fs/workspace.ts";
import { GitHubAppAuth } from "../infrastructure/github/auth.ts";
import { GitHubClient } from "../infrastructure/github/client.ts";
import { UuidGenerator } from "../infrastructure/ids.ts";
import { GenericAdapter } from "../infrastructure/language/genericAdapter.ts";
import { AdapterRegistry } from "../infrastructure/language/registry.ts";
import { TypeScriptAdapter } from "../infrastructure/language/typescriptAdapter.ts";
import { buildModelProvider } from "../infrastructure/model/registry.ts";
import { NodeSubprocessRunner } from "../infrastructure/process/subprocessRunner.ts";
import { buildNpmAuditScanner } from "../infrastructure/scanners/npmAuditRunner.ts";
import { buildSemgrepScanner } from "../infrastructure/scanners/semgrepRunner.ts";

/** Builds a {@link ReviewService} from settings, caching the assembled service per installation. */
export class Container {
  readonly #settings: Settings;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #runner: SubprocessRunner;
  readonly #workspace: TempWorkspace;
  readonly #services = new Map<number, ReviewService>();
  /** The graph shape depends only on the analyzer names, so it is compiled once and shared. */
  #graph: ReviewGraph | null = null;

  constructor(
    settings: Settings,
    overrides: {
      clock?: Clock;
      ids?: IdGenerator;
      subprocessRunner?: SubprocessRunner;
      workspace?: TempWorkspace;
    } = {},
  ) {
    this.#settings = settings;
    this.#clock = overrides.clock ?? new SystemClock();
    this.#ids = overrides.ids ?? new UuidGenerator();
    this.#runner = overrides.subprocessRunner ?? new NodeSubprocessRunner();
    this.#workspace = overrides.workspace ?? new TempWorkspaceFactory();
  }

  /**
   * Return the review service for an installation (the settings default if unspecified).
   *
   * A webhook carries its own installation id; the manual endpoint falls back to the configured
   * default. Services are cached per installation so tokens are minted per installation.
   */
  reviewService(installationId?: number | null): ReviewService {
    const resolved =
      installationId === undefined || installationId === null
        ? this.#settings.github.installationId
        : installationId;
    let service = this.#services.get(resolved);
    if (service === undefined) {
      service = this.#buildService(resolved);
      this.#services.set(resolved, service);
    }
    return service;
  }

  #buildService(installationId: number): ReviewService {
    const model = this.#modelProvider();
    const analyzers = this.#analyzers(model);
    this.#graph ??= buildGraph([...analyzers.keys()]);
    return new ReviewService({
      graph: this.#graph,
      github: this.#github(installationId),
      diffParser: new DiffParser(),
      adapters: new AdapterRegistry([new TypeScriptAdapter()], {
        fallback: new GenericAdapter(),
      }),
      analyzers,
      ids: this.#ids,
      verifier: this.#verifier(model),
      timeoutSeconds: this.#settings.reviewTimeoutSeconds,
    });
  }

  #verifier(model: ModelProvider): FindingVerifier {
    return this.#settings.verifierEnabled
      ? new LLMFindingVerifier({ model })
      : new PolicyVerifier();
  }

  #github(installationId: number): GitHubClient {
    const github = this.#settings.github;
    const auth = new GitHubAppAuth({
      appId: github.appId,
      privateKey: github.privateKey,
      clock: this.#clock,
      apiBase: github.apiBase,
    });
    return new GitHubClient({ auth, installationId, apiBase: github.apiBase });
  }

  #modelProvider(): ModelProvider {
    const provider = activeProvider(this.#settings);
    return buildModelProvider({
      model: provider.model,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      timeoutSeconds: provider.timeoutSeconds,
      maxAttempts: provider.maxAttempts,
      retryDelaySeconds: provider.retryDelaySeconds,
      maxConcurrency: provider.maxConcurrency,
    });
  }

  #analyzers(model: ModelProvider): ReadonlyMap<string, Analyzer> {
    const analyzers = buildAnalyzers({ model, ids: this.#ids });
    const scanner = this.#settings.scanner;
    if (scanner.semgrepEnabled) {
      analyzers.set(
        "semgrep",
        buildSemgrepScanner({
          runner: this.#runner,
          workspace: this.#workspace,
          ids: this.#ids,
          config: scanner.semgrepConfig,
          timeoutSeconds: scanner.semgrepTimeoutSeconds,
        }),
      );
    }
    if (scanner.npmAuditEnabled) {
      analyzers.set(
        "npm-audit",
        buildNpmAuditScanner({
          runner: this.#runner,
          workspace: this.#workspace,
          ids: this.#ids,
          timeoutSeconds: scanner.npmAuditTimeoutSeconds,
        }),
      );
    }
    return analyzers;
  }
}
