/**
 * Reading nested configuration out of a flat environment.
 *
 * The Python original used pydantic-settings, which maps `BICHO_LLM__PROVIDERS__MINIMAX__API_KEY`
 * onto `settings.llm.providers["minimax"].api_key`. This module reproduces that mapping so the same
 * deployment environment drives both implementations unchanged: strip the `BICHO_` prefix, split on
 * the `__` delimiter, and lower-camel-case each segment.
 *
 * Because every segment gets the same treatment, a provider *name* is camel-cased too:
 * `…PROVIDERS__MY_PROVIDER__MODEL` becomes `providers.myProvider.model`, and `BICHO_LLM__ACTIVE`
 * must then say `myProvider`. One rule, no special cases.
 */

import { z } from "zod";

const PREFIX = "BICHO_";
const DELIMITER = "__";

/** Convert one `SNAKE_CASE` environment segment to `camelCase`. */
export function toCamelCase(segment: string): string {
  return segment
    .toLowerCase()
    .split("_")
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

/** A nested plain object built from environment variables. */
export type NestedEnv = { [key: string]: string | NestedEnv };

/**
 * Expand `BICHO_`-prefixed variables into a nested object.
 *
 * A variable set to the empty string is skipped, matching the original's treatment of an unset
 * value: `BICHO_JSON_LOGS=` means "not configured", not "false".
 */
export function expandEnv(source: NodeJS.ProcessEnv): NestedEnv {
  const root: NestedEnv = {};
  for (const [key, rawValue] of Object.entries(source)) {
    if (!key.startsWith(PREFIX) || rawValue === undefined || rawValue === "") {
      continue;
    }
    const segments = key.slice(PREFIX.length).split(DELIMITER).map(toCamelCase);
    const leaf = segments.pop();
    if (leaf === undefined || leaf === "") {
      continue;
    }
    let cursor = root;
    for (const segment of segments) {
      const existing = cursor[segment];
      if (typeof existing === "object") {
        cursor = existing;
      } else {
        // A scalar already sitting here means the env declares both `A=x` and `A__B=y`; the nested
        // form wins, since a section is what the schema expects at that position.
        const created: NestedEnv = {};
        cursor[segment] = created;
        cursor = created;
      }
    }
    cursor[leaf] = rawValue;
  }
  return root;
}

const TRUE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/**
 * A boolean that also accepts the usual textual spellings an environment carries.
 *
 * `z.coerce.boolean()` is unusable here: it treats every non-empty string as `true`, so
 * `SEMGREP_ENABLED=false` would silently enable the scanner.
 */
export const envBoolean = z.union([
  z.boolean(),
  z.string().transform((value, ctx) => {
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) {
      return true;
    }
    if (FALSE_VALUES.has(normalized)) {
      return false;
    }
    ctx.addIssue({ code: "custom", message: `invalid boolean: ${JSON.stringify(value)}` });
    return z.NEVER;
  }),
]);

/** A finite number parsed from its textual environment representation. */
export const envNumber = z.union([
  z.number().finite(),
  z.string().transform((value, ctx) => {
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: "custom", message: `invalid number: ${JSON.stringify(value)}` });
      return z.NEVER;
    }
    return parsed;
  }),
]);

/** An integer parsed from its textual environment representation. */
export const envInteger = envNumber.pipe(z.int());
