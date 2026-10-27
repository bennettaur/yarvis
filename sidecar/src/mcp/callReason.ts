import { asSchema, type JSONSchema7, jsonSchema, type Tool } from "ai";

/**
 * A tool that waits for approval also asks the model to say why it is calling
 * it. The user reads the reason in the approval prompt, and the decision
 * model weighs it in auto mode. It is the model's own claim about its call,
 * so it is shown as that and never as evidence the user asked for it.
 *
 * The field is added to the tool's input schema and taken off again before
 * the tool runs, so the tool itself never sees it.
 */

/** Named so it won't collide with a tool's own arguments; a tool that has one keeps its schema. */
export const CALL_REASON_FIELD = "callReason";

/** Long enough for a sentence, short enough to read at a glance in the prompt. */
export const MAX_CALL_REASON_CHARS = 300;

const CALL_REASON_PROPERTY: JSONSchema7 = {
  type: "string",
  minLength: 1,
  maxLength: MAX_CALL_REASON_CHARS,
  description:
    "Why you are making this call, in one short sentence, tied to what the user asked. It needs their approval, and they see this before deciding.",
};

/** The reason the model gave and the arguments the tool itself takes. */
export function splitCallReason(args: unknown): { reason: string | null; args: unknown } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { reason: null, args };
  const { [CALL_REASON_FIELD]: reason, ...rest } = args as Record<string, unknown>;
  return { reason: typeof reason === "string" ? reason : null, args: rest };
}

/** A tool's input schema with `callReason` added, or null when it can't take one. */
function extendSchema(schema: JSONSchema7): JSONSchema7 | null {
  const properties = schema.properties ?? {};
  // Only a plain object schema is extended. A union or reference at the root,
  // or a tool with its own `callReason`, is left exactly as it was.
  if (schema.type !== "object" || CALL_REASON_FIELD in properties) return null;
  return {
    ...schema,
    properties: { ...properties, [CALL_REASON_FIELD]: CALL_REASON_PROPERTY },
    required: [...(schema.required ?? []), CALL_REASON_FIELD],
  };
}

/** Text with something to read once spaces and invisible characters are gone. */
function hasText(text: string): boolean {
  return text.replace(/[\s\u200b-\u200f\u2060\ufeff]/g, "").length > 0;
}

export interface ReasonedTool {
  tool: Tool;
  /**
   * Whether the tool takes a `callReason`. Settled with its schema, which can
   * load lazily; when it doesn't, its input is its own and nothing is taken off.
   */
  takesReason: () => Promise<boolean>;
}

/**
 * The tool with a required `callReason` added to its input, when its schema
 * can take one. Validation is still the tool's own, run on the input without
 * the reason, so a tool's defaults and transforms apply as before.
 */
export function withCallReason(t: Tool): ReasonedTool {
  const base = asSchema(t.inputSchema);
  let extended: Promise<JSONSchema7 | null> | undefined;
  const resolve = () => {
    extended ??= Promise.resolve(base.jsonSchema).then(extendSchema);
    return extended;
  };
  const takesReason = async () => (await resolve()) !== null;
  const schema = jsonSchema(async () => (await resolve()) ?? (await base.jsonSchema), {
    validate: async (value) => {
      if (!(await takesReason())) {
        return base.validate ? base.validate(value) : { success: true, value };
      }
      const { reason, args } = splitCallReason(value);
      // Required: a call with no reason fails here, and the model tries again with one.
      if (!reason || !hasText(reason) || reason.length > MAX_CALL_REASON_CHARS) {
        return {
          success: false,
          error: new Error(
            `${CALL_REASON_FIELD} is required: one sentence, at most ${MAX_CALL_REASON_CHARS} characters, on why you are making this call`,
          ),
        };
      }
      if (!base.validate) return { success: true, value };
      const result = await base.validate(args);
      if (!result.success) return result;
      const validated = result.value as Record<string, unknown>;
      return { success: true, value: { ...validated, [CALL_REASON_FIELD]: reason } };
    },
  });
  return { tool: { ...t, inputSchema: schema } as Tool, takesReason };
}
