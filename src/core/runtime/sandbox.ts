import vm from "node:vm";
import type { RuntimeLimits } from "./protocol.ts";

export interface SandboxBridge {
  call(method: "agent" | "workflow", payload: string): Promise<string>;
  emit(type: "log" | "phase", value: string): void;
  timer(callback: () => void, delay: number): number;
  clearTimer(id: number): void;
  spent(): number;
}

/** VM isolation protects runtime stability; node:vm is not a security boundary. */
export function executeSandbox(input: {
  body: string;
  argsJSON: string;
  limits: RuntimeLimits;
  tokenBudget: number | null;
  group?: string;
  bridge: SandboxBridge;
}): Promise<string> {
  const { bridge } = input;
  const context = vm.createContext(Object.assign(Object.create(null), {
    __call: bridge.call,
    __emit: bridge.emit,
    __timer: bridge.timer,
    __clearTimer: bridge.clearTimer,
    __spent: bridge.spent,
    __argsJSON: input.argsJSON,
    __limitJSON: JSON.stringify(input.limits),
    __total: input.tokenBudget,
    __group: input.group,
  }), { codeGeneration: { strings: false, wasm: false } });

  new vm.Script(`"use strict";
    (() => {
      const call = __call, emit = __emit, timer = __timer, clearTimer = __clearTimer, spent = __spent;
      const limits = JSON.parse(__limitJSON), group = __group;
      const total = __total;
      const NativeDate = Date;
      const deterministicError = () => { throw new Error('Clock and randomness are unavailable in deterministic workflows'); };
      Date = new Proxy(NativeDate, {
        apply: deterministicError,
        construct(target, values) { if (!values.length) return deterministicError(); return Reflect.construct(target, values); },
        get(target, key) { return key === 'now' ? deterministicError : Reflect.get(target, key); }
      });
      // Also guard construction through an instance's inherited constructor.
      Object.defineProperty(NativeDate.prototype, 'constructor', { value: Date });
      Math.random = deterministicError;
      let currentPhase;
      const fail = (name, message) => { const error = new Error(message); error.name = name; throw error; };
      const encode = value => { const json = JSON.stringify(value) ?? 'null'; if (json.length > 5000000) fail('SerializationError', 'Value exceeds 5 MB'); return json; };
      const invoke = async (method, value) => {
        const envelope = JSON.parse(await call(method, encode(value)));
        if (envelope.error) fail(envelope.error.name, envelope.error.message);
        return envelope.value;
      };
      globalThis.args = JSON.parse(__argsJSON);
      globalThis.agent = async (prompt, opts = {}) => {
        if (typeof prompt !== 'string') fail('TypeError', 'agent() prompt must be a string');
        if (!opts || typeof opts !== 'object' || Array.isArray(opts)) fail('TypeError', 'agent() options must be an object');
        const options = { ...opts };
        if (group !== undefined) options.phase = group;
        else if (options.phase === undefined && currentPhase !== undefined) options.phase = currentPhase;
        return invoke('agent', [prompt, options]);
      };
      const items = value => {
        if (!Array.isArray(value)) fail('TypeError', 'Expected an array');
        if (value.length > limits.maxItems) fail('ItemCapError', 'A parallel()/pipeline() call accepts at most ' + limits.maxItems + ' items');
      };
      globalThis.parallel = async thunks => {
        items(thunks);
        return Promise.all(thunks.map(async thunk => { try { return await thunk(); } catch { return null; } }));
      };
      globalThis.pipeline = async (values, ...stages) => {
        items(values);
        return Promise.all(values.map(async (original, index) => {
          let value = original;
          try { for (const stage of stages) value = await stage(value, original, index); return value; }
          catch { return null; }
        }));
      };
      globalThis.log = value => emit('log', String(value));
      globalThis.phase = title => {
        if (typeof title !== 'string' || !title.trim()) fail('TypeError', 'phase() title must be a nonempty string');
        if (group !== undefined) return;
        currentPhase = title;
        emit('phase', title);
      };
      globalThis.budget = Object.freeze({ total, spent: () => spent(), remaining: () => total === null ? Infinity : Math.max(0, total - spent()) });
      globalThis.workflow = async (reference, value = null) => {
        if (group !== undefined) fail('WorkflowNestingError', 'Nested workflows cannot invoke workflow()');
        if (!((typeof reference === 'string' && reference.trim()) ||
          (reference && typeof reference === 'object' && !Array.isArray(reference) && typeof reference.scriptPath === 'string' && reference.scriptPath.trim())))
          fail('WorkflowNotFoundError', 'workflow() requires a saved workflow name or {scriptPath}');
        return invoke('workflow', [reference, value]);
      };
      globalThis.setTimeout = (callback, delay = 0, ...values) => {
        if (typeof callback !== 'function') fail('TypeError', 'Timer callback must be a function');
        if (!Number.isFinite(delay) || delay < 0 || delay > Math.min(limits.runTimeoutMs, 2147483647)) fail('TimerLimitError', 'Timer delay is outside the run limits');
        return timer(() => callback(...values), delay);
      };
      globalThis.clearTimeout = id => clearTimer(id);
      globalThis.sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
      globalThis.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
      delete globalThis.__call; delete globalThis.__emit; delete globalThis.__timer; delete globalThis.__clearTimer;
      delete globalThis.__argsJSON; delete globalThis.__limitJSON; delete globalThis.__total; delete globalThis.__group; delete globalThis.__spent;
    })();
  `, { filename: "workflow-bootstrap.js" }).runInContext(context, { timeout: input.limits.syncTimeoutMs });

  const program = new vm.Script(`(async () => {\n"use strict";\n${input.body}\n})().then(value => {
    const json = JSON.stringify(value) ?? "null";
    if (json.length > 5000000) { const error = new Error('Workflow result exceeds 5 MB'); error.name = 'SerializationError'; throw error; }
    return json;
  })`, { filename: "workflow.js" });
  return program.runInContext(context, { timeout: input.limits.syncTimeoutMs }) as Promise<string>;
}
