import { expect, test } from "bun:test";
import { delegateInputSchema, toJsonSchema } from "../../packages/contracts/src/index.ts";
import { DELEGATE_INPUT_SCHEMA } from "../../packages/claude-mod/schemas/delegate-input.ts";

test("the Mod advertises the delegate input schema that contracts validates", () => {
  expect(toJsonSchema(delegateInputSchema)).toEqual(DELEGATE_INPUT_SCHEMA);
});
