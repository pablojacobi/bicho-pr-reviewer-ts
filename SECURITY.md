# Security Policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories on this repository — the repository's
**Security** tab, "Report a vulnerability" — rather than a public issue or pull request. Include
what you found, the affected version or commit, and reproduction steps if you have them. Expect an
acknowledgement within a few days.

Do not open a public issue for a suspected vulnerability: it gives anyone watching the repository a
head start before a fix exists.

## Security model

Bicho reads and reasons about pull requests it did not write, from repositories it does not
control, triggered automatically by a webhook. The posture below follows from that. It matches
AGENTS.md's security and prompt-injection rules, which are the authoritative version; this section
summarises it for anyone assessing the project without reading the whole contributor guide.

- **All repository content is untrusted.** Diffs, file contents, PR titles and descriptions,
  filenames, commit messages, and scanner output are all treated as adversarial input, never as
  instructions.
- **Prompt injection cannot change reviewer behaviour.** Analyzer and verifier prompts embed
  repository text strictly as data to analyze — every prompt template states this explicitly to
  the model (`src/application/prompts/registry.ts`) — so nothing read from a repository can alter
  Bicho's own instructions, select a different analyzer, or change what gets published.
- **Repository code is never executed, and the repository is never cloned.** Only the specific
  files a review needs are written into a sandboxed temporary workspace
  (`src/infrastructure/fs/workspace.ts`), created with a uniquely-suffixed directory and always
  removed afterwards via `await using`, on both the success and the failure path. Path safety
  (`src/infrastructure/fs/pathsafe.ts`) rejects traversal, absolute paths, and Windows-style
  separators before anything is written to disk.
- **Subprocesses run with no shell and a hard timeout.** Semgrep and every other subprocess run
  through `execFile` (`src/infrastructure/process/subprocessRunner.ts`), which hands the OS an
  argument vector directly, so nothing derived from repository content can be interpreted as shell
  syntax — and every call is bounded by a configured timeout.
- **The webhook signature is verified before parsing.** GitHub's `X-Hub-Signature-256` is checked
  as an HMAC-SHA256 over the *raw* request body, compared in constant time
  (`node:crypto.timingSafeEqual`), before the body is parsed as JSON at all
  (`src/api/security.ts`, `src/api/routes/webhooks.ts`).
- **Secrets are redacted from logs.** GitHub App private keys, the webhook secret, and model API
  keys are read once into typed settings and never logged directly; pino's redaction list
  (`src/config/logging.ts`) blanks known-sensitive keys — tokens, secrets, private keys, the
  signature header — wherever they appear in a log record.
- **Only what an analyzer needs reaches the model provider.** A prompt carries the diff and the
  head content of in-scope changed files, never the whole repository, and production logs do not
  carry full prompts either.
