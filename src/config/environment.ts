/** Runtime environment definition. */

/**
 * The environment Bicho is running in.
 *
 * Only three environments exist by design — local development, the automated test suite, and the
 * single production instance. There is intentionally no staging environment.
 */
export const Environment = {
  LOCAL: "local",
  TEST: "test",
  PRODUCTION: "production",
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

/** Whether this is the production environment. */
export function isProduction(environment: Environment): boolean {
  return environment === Environment.PRODUCTION;
}
