/**
 * The Zod-to-JSON-Schema bridge the HTTP layer validates and documents with.
 *
 * Fastify validates with ajv and `@fastify/swagger` publishes the same schema, so the conversion
 * has to emit something both accept — which is what this pins down.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchema } from "../../src/api/schema.ts";

describe("jsonSchema", () => {
  it("emits JSON Schema without the $schema key ajv would try to resolve", () => {
    const schema = jsonSchema(z.object({ name: z.string(), count: z.int().min(1) }));

    expect(schema["$schema"]).toBeUndefined();
    expect(schema["type"]).toBe("object");
    expect(schema["required"]).toEqual(["name", "count"]);
  });
});
