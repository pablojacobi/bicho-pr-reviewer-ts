/**
 * Bridging Zod to Fastify's JSON Schema validation and OpenAPI output.
 *
 * Zod is the single source of truth for request shapes; Fastify's validator (ajv) and
 * `@fastify/swagger` both consume JSON Schema. Emitting draft-7 keeps ajv happy, and stripping the
 * `$schema` key avoids ajv resolving a meta-schema it does not need.
 */

import { z } from "zod";

/** Convert a Zod schema into the JSON Schema Fastify validates and documents with. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  void $schema;
  return rest;
}
