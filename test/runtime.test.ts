import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runScript, type RunScriptOptions } from "../src/core/runtime/host.ts";

function run(script: string, overrides: Partial<RunScriptOptions> = {}): Promise<unknown> {
  return runScript({
    script,
    signal: new AbortController().signal,
    limits: { syncTimeoutMs: 200, scriptIdleTimeoutMs: 500, runTimeoutMs: 5_000, maxItems: 4096 },
    onAgent: async prompt => prompt,
    onLog() {},
    onPhase() {},
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("isolated script runtime", () => {
  test("runs async JavaScript and clones args and responses into the VM realm", async () => {
    const args = { values: [1, 2] };
    const result = await run(`
      args.values.push(3);
      const reply = await agent('read', { schema: {type:'object',properties:{}} });
      return { args: args.values, array: Array.isArray(reply.values), instance: reply.values instanceof Array, ordinary: Object.getPrototypeOf(reply) === Object.prototype };
    `, { args, onAgent: async () => ({ values: [4] }) });
    expect(result).toEqual({ args: [1, 2, 3], array: true, instance: true, ordinary: true });
    expect(args.values).toEqual([1, 2]);
  });

  test("parallel preserves positions and converts thrown thunks to null", async () => {
    expect(await run(`return parallel([() => agent('ok'), () => {throw new Error('bad')}, () => agent('fail')]);`, {
      onAgent: async prompt => { if (prompt === "fail") throw Object.assign(new Error("budget exhausted"), { name: "BudgetExceededError" }); return prompt; },
    })).toEqual(["ok", null, null]);
  });

  test("pipeline starts later stages without waiting for other items", async () => {
    const slow = deferred<string>();
    const calls: string[] = [];
    const result = await run(`
      return pipeline(['slow','fast'],
        (previous, original, index) => agent(previous),
        (previous, original, index) => agent('next:' + previous + ':' + original + ':' + index));
    `, {
      onAgent: async prompt => {
        calls.push(prompt);
        if (prompt === "slow") return slow.promise;
        if (prompt === "next:fast:fast:1") slow.resolve("slow-result");
        return prompt;
      },
    });
    expect(result).toEqual(["next:slow-result:slow:0", "next:fast:fast:1"]);
    expect(calls.indexOf("next:fast:fast:1")).toBeLessThan(calls.indexOf("next:slow-result:slow:0"));
  });

  test("pipeline drops only throwing items and skips their remaining stages", async () => {
    expect(await run(`
      const visited = [];
      const result = await pipeline([1,2,3], value => { if(value===2) throw new Error('drop'); return value*2; }, (value,original,index) => {visited.push(original);return [value,original,index]});
      return {result,visited};
    `)).toEqual({ result: [[2, 1, 0], null, [6, 3, 2]], visited: [1, 3] });
  });

  test.each(["parallel([() => agent('bad'), () => agent('bad')])", "pipeline([1,2], () => agent('bad'))"])("item caps reject before any work: %s", async expression => {
    let called = false;
    await expect(run(`return ${expression}`, { limits: { syncTimeoutMs: 200, scriptIdleTimeoutMs: 500, runTimeoutMs: 5000, maxItems: 1 }, onAgent: async () => { called = true; } })).rejects.toMatchObject({ name: "ItemCapError" });
    expect(called).toBe(false);
  });

  test("captures phase synchronously at agent invocation and honors explicit phase", async () => {
    const captured: Record<string, unknown>[] = [];
    const phases: string[] = [];
    expect(await run(`phase('A'); const first=agent('one'); phase('B'); const second=agent('two', {phase:'Explicit',label:'Label'}); await Promise.all([first,second]); return 'ok'`, {
      onAgent: async (_prompt, opts) => { captured.push(opts); return 1; }, onPhase: title => { phases.push(title); },
    })).toBe("ok");
    expect(captured).toEqual([{ phase: "A" }, { phase: "Explicit", label: "Label" }]);
    expect(phases).toEqual(["A", "B"]);
  });

  test("refreshes spent tokens after callbacks and exposes an unlimited budget", async () => {
    let spent = 2;
    expect(await run(`const initial=budget.spent(); await agent('x'); return [budget.total, initial, budget.spent(), budget.remaining()];`, {
      tokenBudget: 10, getSpent: () => spent, onAgent: async () => { spent += 3; return "ok"; },
    })).toEqual([10, 2, 5, 5]);
    expect(await run("return [budget.total, budget.remaining()===Infinity]")).toEqual([null, true]);
  });

  test("nested workflows isolate args, share agent callbacks/budget, and use child groups", async () => {
    let spent = 0;
    const captured: unknown[] = [];
    const result = await run(`
      const child = await workflow('child', args);
      const next = await workflow('child', {value:2});
      return {child,next,original:args.value,spent:budget.spent()};
    `, {
      args: { value: 1 }, getSpent: () => spent,
      onWorkflow: async () => `args.value++; phase('ignored'); await agent('child', {phase:'override'}); return args.value;`,
      onAgent: async (_prompt, opts) => { spent++; captured.push(opts.phase); return null; },
    });
    expect(result).toEqual({ child: 2, next: 3, original: 1, spent: 2 });
    expect(captured).toEqual(["▸ child", "▸ child #2"]);
  });

  test("child nesting, missing workflow and syntax errors remain catchable", async () => {
    expect(await run(`try { await workflow('child') } catch(error) { return error.name }`, { onWorkflow: async () => `return workflow('grandchild')` })).toBe("WorkflowNestingError");
    expect(await run(`try { await workflow('missing') } catch(error) { return error.name }`)).toBe("WorkflowNotFoundError");
    expect(await run(`try { await workflow('bad') } catch(error) { return error.name }`, { onWorkflow: async () => "const = broken" })).toBe("ScriptSyntaxError");
  });

  test("nested workflow scriptPath references are delegated and metadata supplies the group", async () => {
    const references: unknown[] = [];
    const groups: unknown[] = [];
    expect(await run("return workflow({scriptPath:'child.js'}, {value:4})", {
      onWorkflow: async reference => { references.push(reference); return "export const meta = {name:'Named child',description:'Example'}; return agent(String(args.value));"; },
      onAgent: async (prompt, options) => { groups.push(options.phase); return prompt; },
    })).toBe("4");
    expect(references).toEqual([{ scriptPath: "child.js" }]);
    expect(groups).toEqual(["▸ Named child"]);
  });

  test("bounds JSON result size and argument depth", async () => {
    await expect(run("return 'x'.repeat(5000001)")).rejects.toMatchObject({ name: "SerializationError" });
    let args: unknown = 0;
    for (let index = 0; index < 65; index++) args = [args];
    await expect(run("return args", { args })).rejects.toMatchObject({ name: "SerializationError" });
  });

  test("permits explicit dates and forbids nondeterministic clock and random access", async () => {
    const hostDate = Date.now;
    const hostRandom = Math.random;
    expect(await run(`return [new Date('2020-01-02').toISOString(), Date.parse('2020-01-02'), typeof process, typeof require, typeof fetch]`)).toEqual(["2020-01-02T00:00:00.000Z", 1577923200000, "undefined", "undefined", "undefined"]);
    for (const expression of ["Date.now()", "new Date()", "Date()", "Math.random()", "new (new Date(0).constructor)()", "eval('1+1')", "new Function('return 1')"]) {
      expect(await run(`try { ${expression}; return false } catch { return true }`)).toBe(true);
    }
    expect(Date.now).toBe(hostDate);
    expect(Math.random).toBe(hostRandom);
  });

  test("bounds timers and supports cancellation and sleep", async () => {
    expect(await run(`let called=false; const timer=setTimeout(()=>{called=true},20); clearTimeout(timer); await sleep(40); return called`)).toBe(false);
    await expect(run("await sleep(-1)")).rejects.toMatchObject({ name: "TimerLimitError" });
    await expect(run("await sleep(5001)")).rejects.toMatchObject({ name: "TimerLimitError" });
  });

  test("an agent can remain pending longer than the script idle timeout", async () => {
    expect(await run("return await agent('wait')", {
      limits: { syncTimeoutMs: 100, scriptIdleTimeoutMs: 120, runTimeoutMs: 3000, maxItems: 4096 },
      onAgent: async () => { await Bun.sleep(300); return "done"; },
    })).toBe("done");
  });

  test("terminates a synchronous loop without blocking the host", async () => {
    await expect(run("while(true) {}", { limits: { syncTimeoutMs: 30, scriptIdleTimeoutMs: 300, runTimeoutMs: 2000, maxItems: 4096 } })).rejects.toThrow(/timed out|progress/);
  });

  test("terminates a microtask loop even with an unawaited host agent pending", async () => {
    await expect(run("agent('pending'); while(true) await Promise.resolve();", {
      limits: { syncTimeoutMs: 100, scriptIdleTimeoutMs: 120, runTimeoutMs: 2000, maxItems: 4096 },
      onAgent: () => new Promise(() => {}),
    })).rejects.toMatchObject({ name: "ScriptStalledError" });
  });

  test("detects a script waiting forever without any pending work", async () => {
    await expect(run("await new Promise(() => {})", { limits: { syncTimeoutMs: 100, scriptIdleTimeoutMs: 120, runTimeoutMs: 2000, maxItems: 4096 } })).rejects.toMatchObject({ name: "ScriptStalledError" });
  });

  test("run timeout is fatal even when agent work is pending", async () => {
    await expect(run("await agent('wait')", { limits: { syncTimeoutMs: 100, scriptIdleTimeoutMs: 500, runTimeoutMs: 150, maxItems: 4096 }, onAgent: () => new Promise(() => {}) })).rejects.toMatchObject({ name: "RunTimeoutError" });
  });

  test("aborting terminates execution and discards late callbacks", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const reply = deferred<string>();
    const logs: string[] = [];
    const result = run("await agent('wait'); log('late'); return 'late'", { signal: controller.signal, onAgent: () => { started.resolve(); return reply.promise; }, onLog: message => { logs.push(message); } });
    await started.promise;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "RunAbortedError" });
    reply.resolve("done");
    await Bun.sleep(30);
    expect(logs).toEqual([]);
  });

  test("invalid configuration, cyclic args and prior abort fail before any agent", async () => {
    let calls = 0;
    const onAgent = async () => { calls++; };
    await expect(run("agent('x')", { onAgent, limits: { syncTimeoutMs: 0, scriptIdleTimeoutMs: 500, runTimeoutMs: 5000, maxItems: 4096 } })).rejects.toMatchObject({ name: "RuntimeConfigError" });
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    await expect(run("agent('x')", { onAgent, args: cyclic })).rejects.toMatchObject({ name: "SerializationError" });
    await expect(run("agent('x')", { onAgent, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "RunAbortedError" });
    expect(calls).toBe(0);
  });

  test("a missing packaged worker fails closed without running callbacks inline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflow-worker-missing-"));
    let called = false;
    try {
      const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/core/runtime/host.ts")], outdir: directory, naming: "host.js", target: "bun", format: "esm" });
      expect(built.success).toBe(true);
      const { runScript: packagedRun } = await import(pathToFileURL(join(directory, "host.js")).href) as { runScript: typeof runScript };
      await expect(packagedRun({ script: "return agent('never')", signal: new AbortController().signal,
        limits: { syncTimeoutMs: 200, scriptIdleTimeoutMs: 500, runTimeoutMs: 5000, maxItems: 4096 },
        onAgent: async () => { called = true; }, onLog() {}, onPhase() {},
      })).rejects.toMatchObject({ name: "WorkerInitializationError" });
      expect(called).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
