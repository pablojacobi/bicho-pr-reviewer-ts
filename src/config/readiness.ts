/**
 * Configuration readiness checks.
 *
 * Readiness is about *configuration*, not liveness: the process can be up (`/healthz`) yet unable
 * to do real work because required credentials are absent. `/readyz` reports the missing pieces so
 * a misconfigured deploy fails visibly instead of silently erroring on the first webhook.
 */

import type { Settings } from "./settings.ts";

/** Return the human-readable list of required settings that are absent (empty means ready). */
export function missingRequirements(settings: Settings): string[] {
  const problems: string[] = [];
  const { github, llm } = settings;
  if (!github.appId) {
    problems.push("github.appId is not set");
  }
  if (!github.privateKey) {
    problems.push("github.privateKey is not set");
  }
  if (github.installationId === 0) {
    problems.push("github.installationId is not set");
  }
  const provider = llm.providers[llm.active];
  if (provider === undefined) {
    problems.push(`llm.active provider ${JSON.stringify(llm.active)} is not in llm.providers`);
  } else if (!(provider.apiKey && provider.baseUrl && provider.model)) {
    problems.push(`llm provider ${JSON.stringify(llm.active)} is missing apiKey/baseUrl/model`);
  }
  return problems;
}
