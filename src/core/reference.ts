export const reference = `Normal workflow requests use a declarative plan, NOT a script-writing tool call:
workflow({plan:{summary:'Build and verify the feature',tasks:[{id:'build',label:'Implement',task:'Implement the requested feature within scope.',reason:'This model has the reasoning needed for the implementation.',model:'EXACT_CONNECTED_ID'},{id:'verify',label:'Verify',task:'Run the relevant tests and inspect the actual result. Report concrete evidence and remaining issues.',reason:'Use an appropriate lower-cost checker if capability and actual price data support it.',model:'EXACT_CONNECTED_ID',dependsOn:['build']}]}}).
This is an illustrative shape, not a required two-agent template. Decide how many agents are sufficient for the actual task. Every task needs its own model and selection reason. Choose automatic models from the allowed pool; if empty use the effective default/session model. Use actual configured subagent roles. userRequestedModel:true is only for a model explicitly requested by the user; strict pool policy still applies. Dependency IDs must form an acyclic graph. Independent tasks run concurrently; dependent tasks receive completed results as data. A failed dependency prevents its downstream task from starting. The engine validates the entire plan and creates the orchestration artifact privately. Show a short team explanation, never the generated code or script-write diff. Plans run in the background by default, with live sidebar status and a final result notification.

The reference is self-contained for orchestration. Do not read unrelated .claude loop/Ralph scheduling skills to run a workflow. User-requested or relevant task-specific skills remain applicable.

Persistent goals: /workflow-goal <objective> or workflow_goal start creates a durable supervisor. It fixes acceptance criteria, creates fresh declarative workflows for remaining work, independently verifies current evidence, and repeats until accepted. No goal-wide token, cost, workflow-count, or duration ceiling; per-operation safeguards still apply. workflow_goal status/history/pause/resume/stop/edit and native /workflow-goals manage it. Pause cancels owned work while retaining a resumable goal; stop permanently cancels. Stopping a goal-owned run also pauses its goal. A goal owns scheduling for this project; do not start a competing parent workflow, write independently, or install another recurring supervisor. Ultracode settings are compatible and remain unchanged. No tool can manually mark a goal complete. Respect blockers and user permissions; unlimited continuation does not broaden scope. Goals run only while the OpenCode project server is running and reconcile persisted work after restart.

Ultracode controls: /ultracode opens native session settings; workflow_mode show/set/reset is the server-side equivalent. Persistent defaults are workflow_config ultracode.enabled and ultracode.keyword. A one-shot human keyword request never changes these settings or reasoning effort. Session mode asks the model to use workflows only when useful, and to continue necessary investigation/implementation/verification stages until the requested result is verified. Respect stop, skip, opt-out, later user instructions, and approvals. Do not start recurring idle loops. Exact xhigh/high preferences are applied only on models advertising those variants; never label a mapped max/thinking variant as xhigh.

Advanced/custom orchestration: call workflow with exactly one of script, scriptPath, or saved name, and no plan. Use this only when custom JavaScript control flow is requested or the declarative dependency plan cannot express the task; keep source out of the normal chat and do not write a temporary script through a visible write tool. Inline script input is available for advanced use.
The script body is async; top-level await and return are supported. Optional metadata is a pure literal:
export const meta = {name: 'Review', description: 'Review changed files', phases: [{title: 'Review'}]};

API:
- agent(prompt, {label?, phase?, selectionReason?, schema?, model?, effort?, variant?, agentType?, isolation?: 'worktree', timeoutMs?, retries?, schemaRetries?, tools?, system?}) returns a final string, validated structured object, or null on agent failure/skip/timeout.
- Children inherit their parent's session permission rules and cannot launch workflows or tasks. tools flags may disable more tools; true never grants access or overrides existing permission/approval rules.
- parallel([() => agent(...), ...]) waits for all items, preserving order. A throwing thunk becomes null.
- pipeline(items, ...stages) runs each item through stages without a stage-wide barrier. A stage receives (previous, originalItem, index); null or an exception stops that item. Prefer pipeline when tasks can progress independently.
- phase(title), log(value), console.log/warn/error. Phase state is global; use opts.phase inside concurrent stages to avoid races. Metadata phase model/detail are display only.
- args contains the supplied JSON arguments. sleep(ms), setTimeout, clearTimeout exist with bounded delays.
- budget.total is tokenBudget or null. budget.spent() counts this run's output + reasoning tokens including retries/skips; cached work costs zero. remaining() is Infinity without a budget.
- workflow('saved-name', childArgs) or workflow({scriptPath:'file.js'}, childArgs) runs one nested workflow sharing slots, caps and budget. Further nesting throws.

Model choice: omit model to inherit the session, unless an explicitly selected agentType has a configured model or workflow_config changes the default. Explicit model wins. Copy provider/model IDs from the tool description/config catalog; aliases are supported. Honor the user's explicit model assignment. In strict mode aliases and explicit agent models must resolve into the allowed pool. Unknown/ambiguous IDs and invalid variants throw before launching a child. Model availability means configured and connected, not guaranteed quota.

Schema: root must be type:'object' with properties; required must be a subset. Invalid or obviously contradictory schemas throw before dispatch. Returned values are validated, with correction attempts. Failed agents return null; check before accessing fields.

Limits: schema/model errors, budget exhaustion, agent/item caps, unknown workflows, and nesting errors throw. parallel/pipeline catch thrown item errors as null. Run abort/timeout terminates the worker and children. The size guideline in the tool description is advisory; maxAgents is the hard cap. A token budget prevents new dispatches once exhausted; already-running agents may exceed it.

Resume a planned run using workflow({resumeFromRunId: RUN_ID}); the original plan is revalidated against current configuration before cached successes are reused. Advanced script runs also require their script source. Successful calls are a multiset keyed by prompt and raw semantic options, consumed in original invocation order; labels, phases, timeout and retry changes do not invalidate cache. Script/argument changes only miss where they change an agent call. Cached results can be stale after source/config/model changes; omit resumeFromRunId for fresh work. Never cache failures as successful nulls.

Foreground waits for completion. Use background:true for lengthy work: it survives the invoking tool step. Results are delivered when the parent is idle, with its current agent/model preserved. After launching, continue unrelated work; do not duplicate it or sleep/poll to occupy a turn. workflow_runs list/status/stop/skip manages runs. STOP and SKIP_a_N files in a run directory also work.

Await every agent/orchestration call; unfinished children are cancelled when the script returns. No filesystem, network, process, imports, eval or dynamic code generation in scripts. Date.now(), Math.random() and argumentless Date throw for deterministic replay. The VM is for trusted model-authored orchestration and stability, not a security boundary for hostile scripts. Agents retain OpenCode permissions. Worktree isolation is experimental and retained for review; never assume changes are merged.

Example:
const results = await pipeline(args.files,
  (file) => agent('Review ' + file + ' and return concrete findings.', {label: file, phase: 'Review'}),
  (review, file) => agent('Verify these findings for ' + file + ': ' + review, {phase: 'Verify'})
);
return results.filter(x => x !== null);
`;
