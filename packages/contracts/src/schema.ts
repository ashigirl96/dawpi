import { bridgeError, type Outcome } from "./errors.ts";

export type StringSchema = {
  kind: "string";
  minLength?: number;
  forbidden?: { values: readonly string[]; reason: string };
};
export type IntegerSchema = { kind: "integer"; minimum?: number; maximum?: number };
export type BooleanSchema = { kind: "boolean" };
export type LiteralSchema<V extends string | number | boolean = string | number | boolean> = {
  kind: "literal";
  value: V;
};
export type EnumSchema<V extends readonly string[] = readonly string[]> = { kind: "enum"; values: V };
export type ArraySchema<S extends Schema = Schema> = { kind: "array"; items: S; minItems?: number };
export type ObjectSchema<P extends Properties = Properties> = { kind: "object"; properties: P };
export type RecordSchema = { kind: "record" };
export type NullableSchema<S extends Schema = Schema> = { kind: "nullable"; inner: S };
export type UnknownSchema = { kind: "unknown" };
export type OptionalSchema<S extends Schema = Schema> = { kind: "optional"; inner: S };

export type Schema =
  | StringSchema
  | IntegerSchema
  | BooleanSchema
  | LiteralSchema
  | EnumSchema
  | ArraySchema<any>
  | ObjectSchema<any>
  | RecordSchema
  | NullableSchema<any>
  | UnknownSchema;

export type Properties = Record<string, Schema | OptionalSchema<any>>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type OptionalKeys<P extends Properties> = {
  [K in keyof P]: P[K] extends OptionalSchema<any> ? K : never;
}[keyof P];

export type Infer<S> = S extends StringSchema
  ? string
  : S extends IntegerSchema
    ? number
    : S extends BooleanSchema
      ? boolean
      : S extends LiteralSchema<infer V>
        ? V
        : S extends EnumSchema<infer V>
          ? V[number]
          : S extends ArraySchema<infer I>
            ? Infer<I>[]
            : S extends ObjectSchema<infer P>
              ? Simplify<
                  { [K in Exclude<keyof P, OptionalKeys<P>>]: Infer<P[K]> } & {
                    [K in OptionalKeys<P>]?: P[K] extends OptionalSchema<infer I> ? Infer<I> : never;
                  }
                >
              : S extends RecordSchema
                ? Record<string, unknown>
                : S extends NullableSchema<infer I>
                  ? Infer<I> | null
                  : unknown;

export const s = {
  string: (options: Omit<StringSchema, "kind"> = {}): StringSchema => ({ kind: "string", ...options }),
  integer: (options: Omit<IntegerSchema, "kind"> = {}): IntegerSchema => ({ kind: "integer", ...options }),
  boolean: (): BooleanSchema => ({ kind: "boolean" }),
  literal: <const V extends string | number | boolean>(value: V): LiteralSchema<V> => ({ kind: "literal", value }),
  enum: <const V extends readonly string[]>(values: V): EnumSchema<V> => ({ kind: "enum", values }),
  array: <S extends Schema>(items: S, options: { minItems?: number } = {}): ArraySchema<S> => ({
    kind: "array",
    items,
    ...options,
  }),
  object: <P extends Properties>(properties: P): ObjectSchema<P> => ({ kind: "object", properties }),
  record: (): RecordSchema => ({ kind: "record" }),
  nullable: <S extends Schema>(inner: S): NullableSchema<S> => ({ kind: "nullable", inner }),
  unknown: (): UnknownSchema => ({ kind: "unknown" }),
  optional: <S extends Schema>(inner: S): OptionalSchema<S> => ({ kind: "optional", inner }),
};

type Failure = { path: string; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function check(schema: Schema, value: unknown, path: string): Failure | null {
  switch (schema.kind) {
    case "string": {
      if (typeof value !== "string") return { path, reason: `expected string, got ${describe(value)}` };
      if (schema.minLength !== undefined && value.length < schema.minLength)
        return { path, reason: `expected at least ${schema.minLength} characters` };
      if (schema.forbidden?.values.includes(value)) return { path, reason: schema.forbidden.reason };
      return null;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value))
        return { path, reason: `expected integer, got ${describe(value)}` };
      if (schema.minimum !== undefined && value < schema.minimum)
        return { path, reason: `expected at least ${schema.minimum}` };
      if (schema.maximum !== undefined && value > schema.maximum)
        return { path, reason: `expected at most ${schema.maximum}` };
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : { path, reason: `expected boolean, got ${describe(value)}` };
    case "literal":
      return value === schema.value ? null : { path, reason: `expected ${JSON.stringify(schema.value)}` };
    case "enum":
      return typeof value === "string" && schema.values.includes(value)
        ? null
        : { path, reason: `expected one of ${schema.values.map((v) => JSON.stringify(v)).join(", ")}` };
    case "array": {
      if (!Array.isArray(value)) return { path, reason: `expected array, got ${describe(value)}` };
      if (schema.minItems !== undefined && value.length < schema.minItems)
        return { path, reason: `expected at least ${schema.minItems} items` };
      for (const [index, item] of value.entries()) {
        const failure = check(schema.items, item, `${path}[${index}]`);
        if (failure) return failure;
      }
      return null;
    }
    case "object": {
      if (!isPlainObject(value)) return { path, reason: `expected object, got ${describe(value)}` };
      const properties: Properties = schema.properties;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) return { path: `${path}.${key}`, reason: "unknown property" };
      }
      for (const [key, property] of Object.entries(properties)) {
        const present = Object.hasOwn(value, key) && value[key] !== undefined;
        if (property.kind === "optional") {
          if (!present) continue;
          const failure = check(property.inner, value[key], `${path}.${key}`);
          if (failure) return failure;
          continue;
        }
        if (!present) return { path: `${path}.${key}`, reason: "missing required property" };
        const failure = check(property, value[key], `${path}.${key}`);
        if (failure) return failure;
      }
      return null;
    }
    case "record":
      return isPlainObject(value) ? null : { path, reason: `expected object, got ${describe(value)}` };
    case "nullable":
      return value === null ? null : check(schema.inner, value, path);
    case "unknown":
      return value === undefined ? { path, reason: "missing value" } : null;
  }
}

export function validate<S extends Schema>(schema: S, value: unknown): Outcome<Infer<S>> {
  const failure = check(schema, value, "$");
  if (failure === null) return { ok: true, value: value as Infer<S> };
  return {
    ok: false,
    error: bridgeError("INVALID_INPUT", `${failure.path}: ${failure.reason}`, { details: failure }),
  };
}

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: Schema): JsonSchema {
  switch (schema.kind) {
    case "string": {
      const out: JsonSchema = { type: "string" };
      if (schema.minLength !== undefined) out.minLength = schema.minLength;
      if (schema.forbidden) out.not = { enum: [...schema.forbidden.values] };
      return out;
    }
    case "integer": {
      const out: JsonSchema = { type: "integer" };
      if (schema.minimum !== undefined) out.minimum = schema.minimum;
      if (schema.maximum !== undefined) out.maximum = schema.maximum;
      return out;
    }
    case "boolean":
      return { type: "boolean" };
    case "literal":
      return { const: schema.value };
    case "enum":
      return { type: "string", enum: [...schema.values] };
    case "array": {
      const out: JsonSchema = { type: "array", items: toJsonSchema(schema.items) };
      if (schema.minItems !== undefined) out.minItems = schema.minItems;
      return out;
    }
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, property] of Object.entries(schema.properties as Properties)) {
        if (property.kind === "optional") {
          properties[key] = toJsonSchema(property.inner);
        } else {
          properties[key] = toJsonSchema(property);
          required.push(key);
        }
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    case "record":
      return { type: "object" };
    case "nullable":
      return { anyOf: [toJsonSchema(schema.inner), { type: "null" }] };
    case "unknown":
      return {};
  }
}
