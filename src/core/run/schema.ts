import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

export class UnsatisfiableSchemaError extends Error {
  override name = "SchemaInvalidError"
}

type Schema = Record<string, unknown>
const object = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value)
const fail = (path: string, message: string): never => { throw new UnsatisfiableSchemaError(`${path}: ${message}`) }
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])

/** Validate the supported structured-output contract before spending tokens. */
export interface StructuredValidator {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: { path: string[]; message: string }[] } }
}
export function validateSchema(value: unknown): StructuredValidator {
  if (!object(value) || value.type !== "object" || !object(value.properties)) {
    fail("schema", 'must have type "object" and an object-valued properties field')
  }
  const schema = value as Schema
  if (schema.$async !== undefined) fail("schema.$async", "asynchronous schemas are not supported")
  const seen = new Set<object>()
  const json = (value: unknown, path: string): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return
    if (typeof value === "number" && Number.isFinite(value)) return
    if (typeof value !== "object" || seen.has(value)) return fail(path, "must be JSON-serializable (no cycles or non-JSON values)")
    seen.add(value)
    for (const [key, child] of Object.entries(value)) json(child, `${path}.${key}`)
    seen.delete(value)
  }
  json(schema, "schema")

  const allowedTypes = (node: unknown): Set<string> => {
    if (node === false) return new Set()
    if (!object(node)) return new Set(types)
    let allowed = node.type === undefined ? new Set(types) : new Set((Array.isArray(node.type) ? node.type : [node.type]) as string[])
    if (allowed.has("number")) allowed.add("integer")
    for (const branch of (Array.isArray(node.allOf) ? node.allOf : [])) {
      const other = allowedTypes(branch)
      allowed = new Set([...allowed].filter((type) => other.has(type)))
    }
    for (const keyword of ["anyOf", "oneOf"]) if (Array.isArray(node[keyword])) {
      const other = new Set((node[keyword] as unknown[]).flatMap((branch) => [...allowedTypes(branch)]))
      allowed = new Set([...allowed].filter((type) => other.has(type)))
    }
    return allowed
  }

  const visit = (node: unknown, path: string, required: boolean): void => {
    if (typeof node === "boolean") {
      if (!node && required) fail(path, "required schema cannot be false")
      return
    }
    if (!object(node)) fail(path, "must be a schema object or boolean")
    const current = node as Schema
    if (!allowedTypes(current).size) fail(path, "type constraints are contradictory")
    if (current.type !== undefined) {
      const selected = Array.isArray(current.type) ? current.type : [current.type]
      if (!selected.length || selected.some((type) => typeof type !== "string" || !types.has(type))) fail(path, "contains an invalid type")
    }
    if (current.properties !== undefined && !object(current.properties)) fail(`${path}.properties`, "must be an object")
    if (current.required !== undefined && (!Array.isArray(current.required) || current.required.some((key) => typeof key !== "string"))) fail(`${path}.required`, "must be an array of property names")
    const keys = (current.required ?? []) as string[]
    const properties = (current.properties ?? {}) as Schema
    if (path === "schema" || current.additionalProperties === false) {
      const missing = keys.filter((key) => !Object.hasOwn(properties, key))
      if (missing.length) fail(path, `required properties are not declared: ${missing.join(", ")}`)
    }
    if (current.enum !== undefined && (!Array.isArray(current.enum) || !current.enum.length)) fail(`${path}.enum`, "must be a non-empty array")
    for (const [min, max] of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minProperties", "maxProperties"]]) {
      for (const key of [min, max]) if (current[key] !== undefined && (!Number.isInteger(current[key]) || (current[key] as number) < 0)) fail(`${path}.${key}`, "must be a nonnegative integer")
      if (typeof current[min] === "number" && typeof current[max] === "number" && current[min] > current[max]) fail(path, `${min} exceeds ${max}`)
    }
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      if (current[key] !== undefined && typeof current[key] !== "number") fail(`${path}.${key}`, "must be a number")
    }
    if (typeof current.multipleOf === "number" && current.multipleOf <= 0) fail(`${path}.multipleOf`, "must be positive")
    const lower = Math.max(typeof current.minimum === "number" ? current.minimum : -Infinity, typeof current.exclusiveMinimum === "number" ? current.exclusiveMinimum : -Infinity)
    const upper = Math.min(typeof current.maximum === "number" ? current.maximum : Infinity, typeof current.exclusiveMaximum === "number" ? current.exclusiveMaximum : Infinity)
    if (lower > upper || (lower === upper && (current.exclusiveMinimum === lower || current.exclusiveMaximum === upper))) fail(path, "numeric bounds are contradictory")
    if (current.type === "integer") {
      const first = current.exclusiveMinimum === lower ? Math.floor(lower) + 1 : Math.ceil(lower)
      const last = current.exclusiveMaximum === upper ? Math.ceil(upper) - 1 : Math.floor(upper)
      if (first > last) fail(path, "numeric bounds contain no integers")
    }
    if (typeof current.maxProperties === "number" && keys.length > current.maxProperties) fail(path, "more required properties than maxProperties")
    if (current.not === true || (object(current.not) && Object.keys(current.not).length === 0)) fail(path, "not excludes every value")
    for (const [key, child] of Object.entries(properties)) visit(child, `${path}.properties.${key}`, keys.includes(key))
    for (const keyword of ["$defs", "definitions", "patternProperties"]) {
      if (current[keyword] !== undefined) {
        if (!object(current[keyword])) fail(`${path}.${keyword}`, "must be an object")
        for (const [key, child] of Object.entries(current[keyword] as Schema)) visit(child, `${path}.${keyword}.${key}`, false)
      }
    }
    for (const keyword of ["items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else"]) {
      if (current[keyword] !== undefined) visit(current[keyword], `${path}.${keyword}`, keyword === "items" && Number(current.minItems) > 0)
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      if (current[keyword] === undefined) continue
      if (!Array.isArray(current[keyword]) || !(current[keyword] as unknown[]).length) fail(`${path}.${keyword}`, "must be a non-empty array")
      for (const [index, child] of (current[keyword] as unknown[]).entries()) visit(child, `${path}.${keyword}[${index}]`, required && keyword === "allOf")
      if ((keyword === "anyOf" || keyword === "oneOf") && (current[keyword] as unknown[]).every((child) => child === false)) fail(path, `${keyword} has no possible branch`)
    }
  }
  visit(schema, "schema", true)
  try {
    const create = () => {
      const Constructor = typeof schema.$schema === "string" && /draft-0[67]/.test(schema.$schema) ? Ajv : Ajv2020
      const ajv = new Constructor({ strict: false, allErrors: true, validateFormats: true, ownProperties: true })
      addFormats(ajv)
      return ajv
    }
    const validator = create().compile(schema)
    // Check finite domains against the whole schema, including type and bounds.
    const domains = (node: Schema, path: string): void => {
      // Referenced schemas were already compiled in root scope above. Avoid
      // rebinding local references to a leaf during this conservative check.
      if (!JSON.stringify(node).includes('"$ref"') && (Array.isArray(node.enum) || Object.hasOwn(node, "const"))) {
        const check = create().compile(node)
        if (Array.isArray(node.enum) && !node.enum.some((entry) => check(entry))) fail(path, "enum contains no values allowed by this schema")
        if (Object.hasOwn(node, "const") && !check(node.const)) fail(path, "const is incompatible with this schema")
      }
      for (const [key, child] of Object.entries((node.properties ?? {}) as Schema)) if (object(child)) domains(child, `${path}.properties.${key}`)
    }
    domains(schema, "schema")
    return {
      safeParse(value) {
        if (validator(value)) return { success: true }
        return { success: false, error: { issues: (validator.errors ?? []).map((error) => ({ path: error.instancePath.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")), message: error.message ?? `does not satisfy ${error.keyword}` })) } }
      },
    }
  } catch (error) {
    if (error instanceof UnsatisfiableSchemaError) throw error
    throw new UnsatisfiableSchemaError(`Unsupported or invalid JSON schema: ${error instanceof Error ? error.message : String(error)}`)
  }
}
