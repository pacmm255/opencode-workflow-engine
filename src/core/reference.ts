export const reference = `Write a small plain JavaScript script and call workflow with exactly one of script, scriptPath, or saved name.
The script body is async; top-level await and return are supported. Optional metadata is a pure literal:
export const meta = {name: 'Review', description: 'Review changed files', phases: [{title: 'Review'}]};

API:
- agent(prompt, {label?, phase?, schema?, model?, effort?, variant?, agentType?, isolation?: 'worktree', timeoutMs?, retries?, schemaRetries?, tools?, system?}) returns a final string, validated structured object, or null on agent failure/skip/timeout.
- parallel([() => agent(...), ...]) waits for all items, preserving order. A throwing thunk becomes null.
- pipeline(items, ...stages) runs each item through stages without a stage-wide barrier. A stage receives (previous, originalItem, index); null or an exception stops that item. Prefer pipeline when tasks can progress independently.
- phase(title), log(value), console.log/warn/error. Phase state is global; use opts.phase inside concurrent stages to avoid races. Metadata phase model/detail are display only.
- args contains the supplied JSON arguments. sleep(ms), setTimeout, clearTimeout exist with bounded delays.
- budget.total is tokenBudget or null. budget.spent() counts this run's output + reasoning tokens including retries/skips; cached work costs zero. remaining() is Infinity without a budget.
- workflow('saved-name', childArgs) or workflow({scriptPath:'file.js'}, childArgs) runs one nested workflow sharing slots, caps and budget. Further nesting throws.

Model choice: omit model to inherit the session, unless an explicitly selected agentType has a configured model or workflow_config changes the default. Explicit model wins. Copy provider/model IDs from the tool description/config catalog; aliases are supported. Honor the user's explicit model assignment. In strict mode aliases and explicit agent models must resolve into the allowed pool. Unknown/ambiguous IDs and invalid variants throw before launching a child. Model availability means configured and connected, not guaranteed quota.

Schema: root must be type:'object' with properties; required must be a subset. Invalid or obviously contradictory schemas throw before dispatch. Returned values are validated, with correction attempts. Failed agents return null; check before accessing fields.

Limits: schema/model errors, budget exhaustion, agent/item caps, unknown workflows, and nesting errors throw. parallel/pipeline catch thrown item errors as null. Run abort/timeout terminates the worker and children. The size guideline in the tool description is advisory; maxAgents is the hard cap. A token budget prevents new dispatches once exhausted; already-running agents may exceed it.

Resume: workflow({scriptPath: '.../script.js', resumeFromRunId: 'wf_...'}). Successful calls are a multiset keyed by prompt and raw semantic options, consumed in original invocation order; labels, phases, timeout and retry changes do not invalidate cache. Script/argument changes only miss where they change an agent call. Cached results can be stale after source/config/model changes; omit resumeFromRunId for fresh work. Never cache failures as successful nulls.

Foreground waits for completion. Use background:true for lengthy work: it survives the invoking tool step. Results are delivered when the parent is idle, with its current agent/model preserved. After launching, continue unrelated work; do not duplicate it or sleep/poll to occupy a turn. workflow_runs list/status/stop/skip manages runs. STOP and SKIP_a_N files in a run directory also work.

Await every agent/orchestration call; unfinished children are cancelled when the script returns. No filesystem, network, process, imports, eval or dynamic code generation in scripts. Date.now(), Math.random() and argumentless Date throw for deterministic replay. The VM is for trusted model-authored orchestration and stability, not a security boundary for hostile scripts. Agents retain OpenCode permissions. Worktree isolation is experimental and retained for review; never assume changes are merged.

Example:
const results = await pipeline(args.files,
  (file) => agent('Review ' + file + ' and return concrete findings.', {label: file, phase: 'Review'}),
  (review, file) => agent('Verify these findings for ' + file + ': ' + review, {phase: 'Verify'})
);
return results.filter(x => x !== null);
`;
