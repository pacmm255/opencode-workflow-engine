import { describe, expect, test } from "bun:test";
import { MetaInvalidError, parseScript } from "../src/core/script/meta.ts";
import { validateScript } from "../src/core/script/validate.ts";

describe("literal script metadata", () => {
  test("plain inline JavaScript does not require metadata", () => {
    expect(parseScript("return await agent('hello');")).toEqual({ meta: {}, body: "return await agent('hello');" });
  });

  test("compile-only validation accepts await and catches JS/TypeScript syntax errors without executing", () => {
    expect(validateScript("throw new Error('must not execute'); return await agent('x')").meta).toEqual({});
    for (const source of ["const = broken", "const value: number = 1"]) expect(() => validateScript(source)).toThrow(expect.objectContaining({ name: "ScriptSyntaxError" }));
  });

  test("reads comments, single quotes, nested literals and trailing commas without evaluating", () => {
    const script = `/* intro */\nexport const meta = {
      name: 'Investigate', // display name
      description: "Read \\u0061nd compare",
      phases: [{ title: 'Read', detail: 'first', model: 'provider/model', },],
      extras: { enabled: true, missing: null, count: -1.25e2 },
    };\nreturn args;`;
    const result = parseScript(script);
    expect(result.meta).toMatchObject({ name: "Investigate", description: "Read and compare", phases: [{ title: "Read" }], extras: { enabled: true, missing: null, count: -125 } });
    expect(result.body.split("\n").length).toBe(script.split("\n").length);
    expect(result.body).toEndWith("return args;");
    expect(result.body).not.toContain("export const");
  });

  test.each([
    "{name: sideEffect(), description: 'x'}",
    "{name: 'x', description: `hello ${sideEffect()}`} ",
    "{name: 'x', description: 'x', ...other}",
    "{name: 'x', description: 'x', get value() { return 1 }}",
    "{name: 'x', description: 'x', [computed]: 1}",
    "{name: 'x', description: 'x', value: 1 + 2}",
    "{name: 'x', description: 'x', name: 'duplicate'}",
    "{name: 'x', description: 'x', value: 1e999}",
    "{name: 'x'}",
    "{name: 'x', description: 'x', phases: [{detail:'missing title'}]}",
    "[]",
  ])("rejects computed or malformed metadata: %s", literal => {
    expect(() => parseScript(`export const meta = ${literal}; return 1;`)).toThrow(MetaInvalidError);
  });

  test("requires a declaration boundary", () => {
    expect(() => parseScript("export const meta = {name:'a',description:'b'}.name; return 1;")).toThrow(MetaInvalidError);
    expect(parseScript("export const meta = {name:'a',description:'b'}\nreturn 1").body).toEndWith("return 1");
  });

  test("prototype property names are inert literal data", () => {
    const { meta } = parseScript("export const meta = {name:'a',description:'b', '__proto__': {polluted:true}}; return 1;");
    expect(Object.hasOwn(meta, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
