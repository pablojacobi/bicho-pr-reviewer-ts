/**
 * The hidden review marker used for idempotency.
 *
 * Bicho embeds one hidden HTML comment in each review it publishes. Before reviewing again, it
 * reads the existing reviews and parses this marker to check whether the current head SHA and
 * workflow version were already reviewed. GitHub is the source of truth; there is no database.
 */

const MARKER_PREFIX = "bicho-pr-reviewer";
const MARKER_VERSION = "1";

/**
 * The field list is optional in the pattern so that a marker carrying no fields at all still
 * matches and is then rejected as incomplete — rather than failing to match and being reported as
 * "no marker present", which would silently let a re-review through.
 */
const MARKER_RE = new RegExp(
  `<!--\\s*${MARKER_PREFIX}:${MARKER_VERSION}(?:\\s+([\\s\\S]*?))?\\s*-->`,
);
const FIELD_RE = /(\w+)=(\S*)/g;

/** Identifies a review Bicho published, so a re-run can detect it without any storage. */
export interface ReviewMarker {
  readonly headSha: string;
  readonly workflowVersion: string;
  readonly runFingerprint: string;
  readonly modelId: string;
  readonly promptVersion: string;
}

/** Render the marker as a hidden HTML comment to embed in a review body. */
export function renderMarker(marker: ReviewMarker): string {
  const fields = [
    `head_sha=${marker.headSha}`,
    `workflow_version=${marker.workflowVersion}`,
    `run=${marker.runFingerprint}`,
    `model=${marker.modelId}`,
    `prompt=${marker.promptVersion}`,
  ].join(" ");
  return `<!-- ${MARKER_PREFIX}:${MARKER_VERSION} ${fields} -->`;
}

/** Extract a marker from `text` (e.g. a review body), or `null` if absent/incomplete. */
export function parseMarker(text: string): ReviewMarker | null {
  const match = MARKER_RE.exec(text);
  if (match === null) {
    return null;
  }
  const fields = new Map<string, string>();
  // `matchAll` on a fresh iteration; the /g regex is module-level so reset its cursor first.
  FIELD_RE.lastIndex = 0;
  for (const field of match[1]?.matchAll(FIELD_RE) ?? []) {
    fields.set(field[1] as string, field[2] as string);
  }
  const headSha = fields.get("head_sha");
  const workflowVersion = fields.get("workflow_version");
  const runFingerprint = fields.get("run");
  const modelId = fields.get("model");
  const promptVersion = fields.get("prompt");
  if (
    headSha === undefined ||
    workflowVersion === undefined ||
    runFingerprint === undefined ||
    modelId === undefined ||
    promptVersion === undefined
  ) {
    return null;
  }
  return { headSha, workflowVersion, runFingerprint, modelId, promptVersion };
}
