<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/hero-light.svg" />
  <img src="assets/hero-light.svg" alt="OpenCode Workflow Engine" width="100%" />
</picture>

### A small script. A real team of agents. A way to pick up where you left off.

Compose multi-agent work in JavaScript.<br />Run it in real OpenCode child sessions. Keep every successful result.

[![OpenCode](https://img.shields.io/badge/OpenCode-1.18.29%2B-86b9d6?style=flat-square&labelColor=1c2229)](#quick-start) [![Bun](https://img.shields.io/badge/built_with-Bun-e7b786?style=flat-square&labelColor=1c2229)](#development) [![License](https://img.shields.io/badge/license-MIT-b8c4b7?style=flat-square&labelColor=1c2229)](LICENSE)

**[Get started](#quick-start)** &nbsp; / &nbsp; **[Usage](#usage)** &nbsp; / &nbsp; **[See a workflow](#one-script-many-moving-parts)** &nbsp; / &nbsp; **[Choose models](#your-team-your-models)** &nbsp; / &nbsp; **[Resume work](#keep-the-work-youve-already-done)**

</div>

<br />

<table>
<tr>
<td width="33%" valign="top">
<sub>01 &nbsp; COMPOSE</sub>
<h3>Think beyond one agent.</h3>
<p>Use loops, branches, parallel tasks, and pipelines. Give each assignment its own OpenCode session.</p>
</td>
<td width="33%" valign="top">
<sub>02 &nbsp; COORDINATE</sub>
<h3>Keep the work in view.</h3>
<p>Choose models, validate handoffs, name phases, and open child sessions. Skip a task or stop the run.</p>
</td>
<td width="33%" valign="top">
<sub>03 &nbsp; CONTINUE</sub>
<h3>Save the progress.</h3>
<p>Successful results are journaled before returning. Resume matching work after interruption or a script edit.</p>
</td>
</tr>
</table>

<p align="center"><sub>Version 0.1.0 · Server plugin and native dialogs available · Live sidebar planned</sub></p>

<br />

## One script. Many moving parts.

Review each file, then verify its findings. Each item moves forward as soon as its own review is ready.

```js
const findings = await pipeline(
  args.files,

  file => agent(`Review ${file}. Include concrete findings and locations.`, {
    label: file,
    phase: "Review",
  }),

  (review, file) => {
    if (review === null) return null;
    return agent(`Verify this review of ${file}:\n${review}`, {
      label: file,
      phase: "Verify",
    });
  },
);

return findings.filter(result => result !== null);
```

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/pipeline-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/pipeline-light.svg" />
  <img src="assets/pipeline-light.svg" alt="Illustrated pipeline: file A has finished review and verification; file B is still being reviewed; file C is being verified. Items advance independently." width="480" />
</picture>

</div>

<p align="center"><sub>Illustrated execution flow. Use <code>parallel()</code> when the next step needs every result.</sub></p>

<br />

## Quick start

**Install with one command**

Requires macOS or Linux, Bash, Git, Bun, GitHub CLI, and OpenCode 1.18.29 or later. Sign in with `gh auth login` using an account with access to this private repository.

```sh
bash -c 'set -e; workflow_installer=$(gh api --hostname github.com repos/pacmm255/opencode-workflow-engine/contents/install.sh -H "Accept: application/vnd.github.raw+json"); bash -c "$workflow_installer"'
```

The command downloads the installer completely before running it. It builds the plugin and enables both the server and native dialogs in your global OpenCode configuration. No manual path editing is needed.

<details>
<summary><strong>Installation, updates, and native dialogs</strong></summary>

Review the [installer](install.sh) and [configuration helper](scripts/configure.ts) before running code from GitHub. The repository is private; an unauthenticated download will not work.

Run the same command again to update from `main`. Each build uses a fresh managed directory; previous builds are retained. Existing plugin entries, options, JSONC comments, and unrelated settings are preserved. Modified configuration files receive unique backups. Invalid configuration stops registration; individual file updates are atomic, but the two-file update is not a transaction.

The installer respects the standard XDG data and configuration locations and registers the default global configuration. Project settings or explicit OpenCode configuration overrides can still take precedence.

`/workflow-config` (also `/workflow_config`) opens native settings in OpenCode's terminal UI. `/workflows` opens run details and child sessions, with stop and skip controls.

For an SSH tunnel, set `remote: true` in the installed TUI plugin entry's options in `tui.json` or `tui.jsonc`; retain the generated entry. Remote dialogs prepare requests for the server tools. Local dialogs manage local configuration and run files.

</details>

<br />

## Usage

Restart OpenCode after installation or an update. In the terminal UI, open the workflow settings page:

```text
/workflow-config
```

`/workflow_config` is an alias for the same page. It opens directly—no chat prompt or model call.

1. Select **Connected providers and model pool**.
2. Choose an OpenCode connection, or **All connected models**.
3. Select models to toggle them in the pool. `[x]` marks selected models; changes save immediately to the chosen project or global scope.

**Default model** uses the same connection and model lists. The page also controls strict mode, advisory workflow size, and save scope. Its catalog comes from the same live provider data as OpenCode's `/models`, with deprecated models excluded. If the list is empty, use `/connect`, check `/models`, and reopen the workflow settings.

The installer includes the native TUI plugin. For an explicitly chat-based fallback without it, use `/workflow-config-chat` or `/workflows-chat`; those commands intentionally ask the model to use server tools.

Then give the workflow a task:

```text
/workflow Review the current changes from correctness and test-coverage perspectives, then verify the findings.
```

The model reads the authoring reference, writes a workflow, and runs it. Configuration is optional: child agents inherit the invoking session's model by default.

| Command | Action |
| :--- | :--- |
| `/workflow-config` or `/workflow_config` | Open native settings and select connected providers/models. |
| `/workflow <task>` | Author and execute a workflow. |
| `/workflows` | View this session's runs and child sessions; use native stop and skip controls. |
| `/workflow-stop [runId]` | Request stopping a specific run, or the latest active run in this session. |

<details>
<summary><strong>Run your own script</strong></summary>

Save the earlier example as `review.js`, then ask the model to call the `workflow` tool with:

```json
{
  "scriptPath": "review.js",
  "args": { "files": ["package.json", "README.md"] },
  "background": true,
  "tokenBudget": 20000
}
```

Supply exactly one source: inline `script`, `scriptPath`, or a saved workflow `name`. Scripts run in an async body with top-level `await` and `return`. Optional `export const meta` accepts literal metadata.

Always await dispatched work and handle `null` results. Any unfinished child calls are cancelled when the script returns.

</details>

<br />

## Your team. Your models.

Use the session's model to get started. Open `/workflow-config` when you want an allowed pool or a different default. The catalog comes from OpenCode's configured providers and includes their model variants. Set aliases and hard execution limits through `workflow_config` or configuration JSON.

**Explicit choice → selected agent's model → workflow default → session model.**

Exact model IDs, aliases, unique short IDs, and variants are supported. Ambiguous names produce an error with candidates.

<details>
<summary><strong>Configure a model pool and execution limits</strong></summary>

```json
{
  "models": {
    "allowed": [],
    "default": "session",
    "strict": false,
    "aliases": {}
  },
  "limits": { "maxConcurrency": 4 },
  "defaults": { "retries": 1 },
  "sizeGuideline": 15
}
```

This example inherits the session model without restricting the pool. Choose exact IDs from `workflow_config show` before adding allowed models or aliases. Global and project settings each use `workflow.json` in their respective OpenCode configuration directories.

Project fields override global fields. Arrays replace; aliases merge by name. In strict mode, explicit choices and explicitly selected `agentType` models must belong to the allowed pool. Aliases cannot bypass it. Inherited session and workflow defaults remain usable.

`models.default` sets the model for ordinary workflow agents. `sizeGuideline` is advisory; `limits.maxAgents` is the hard cap. A configured provider can still fail because of credentials or quota.

</details>

<br />

## Keep the work you've already done.

Each successful agent result is **appended and synced before it returns**. If a run stops, ask OpenCode to resume using the saved script, run ID, and original arguments from the run report:

```text
Resume the interrupted workflow using its saved script and original arguments.
```

Matching prompts and semantic options reuse successful results. Changed work runs again. Labels, phases, timeouts, and retry settings can change without losing a match; cached results add no token spend.

> [!IMPORTANT]
> Replay reuses earlier results. Source changes and updated model/config defaults do not automatically invalidate them. Supply the script's arguments again, and omit `resumeFromRunId` when you need fresh results.

<details>
<summary><strong>Inside a saved run</strong></summary>

Each saved run includes `script.js`, `args.json`, `run.json`, `journal.jsonl`, and `result.json`, plus individual agent records with prompts, options, sessions, and results.

Runs are stored in OpenCode's local workflow data directory. Records contain prompts and results; keep them local and private.

Repeated identical calls consume cached successes in invocation order. Failed/skipped calls are never cached as successes. Prompt, schema, model options, agent type, system text, isolation, and tool choices affect matching.

Runs whose owning process has exited are marked interrupted. Recovery never restarts them automatically.

</details>

<br />

## A few good starting points.

| Workflow | What happens | Input |
| :--- | :--- | :--- |
| **[`review-changes`](workflows/review-changes.js)** | Review from three perspectives, then verify each set of findings. | `{ "task": "optional focus" }` |
| **[`research`](workflows/research.js)** | Research a question, then check and synthesize the evidence. | `{ "question": "…" }` |
| **[`audit`](workflows/audit.js)** | Inspect failure handling, persistence, and resource cleanup. | `{ "target": "optional target" }` |
| **[`implement-plan`](workflows/implement-plan.js)** | Implement ordered tasks, stop on failure, and review the result. | `{ "tasks": ["…", "…"] }` |

Call the `workflow` tool with a saved name:

```json
{
  "name": "review-changes",
  "args": { "task": "Review the current changes. Focus on cancellation." },
  "background": true
}
```

<details>
<summary><strong>The scripting API</strong></summary>

| API | Purpose |
| :--- | :--- |
| `agent(prompt, options?)` | Run a child; receive text, a validated object, or `null` on failure/skip/timeout. |
| `parallel(thunks)` | Run independent tasks and collect results in input order. |
| `pipeline(items, ...stages)` | Advance each item through stages independently. |
| `workflow(nameOrRef, args)` | Run one nested workflow with shared concurrency, caps, and budget. |
| `phase(title)` / `log(value)` | Organize phases and record progress. |
| `args` | Access the supplied JSON arguments. |
| `budget` | Read the configured total, spend, and remaining output tokens. |

Read `workflow_reference` in OpenCode for schemas, variants, timers, nesting, failure behavior, and replay semantics.

</details>

<details>
<summary><strong>Tools, controls, and execution behavior</strong></summary>

The tools are `workflow`, `workflow_reference`, `workflow_runs`, `workflow_saved`, and `workflow_config`. `workflow_runs` provides list/status/stop/skip actions. Deleting a saved script with `workflow_saved` archives it for recovery.

**Foreground** waits for completion and follows the invoking tool's cancellation signal. **Background** owns its own signal, survives the end of that step, and reports when the parent is observed idle.

- **Outcomes:** failures after retries, skips, and agent timeouts return `null`; deterministic model/schema errors reject. Parallel/pipeline item exceptions become `null`.
- **Budgets:** output and reasoning across all attempts count toward spend. Exhaustion stops new dispatches; already-running agents can overshoot.
- **Cancellation:** workers and children are stopped. `STOP` and `SKIP_a_1` files in the run directory also provide controls.
- **Delivery:** the parent retains its current model and agent. Another turn can race the idle check; reports remain on disk if notification fails.
- **Worktrees:** `{ isolation: "worktree" }` is experimental. Created worktrees are retained; merge and remove them manually.
- **Trust:** the worker and VM provide stability for trusted model-authored scripts, not a security boundary for hostile JavaScript. Child agents retain OpenCode permissions.

</details>

<br />

## Tested where the work happens.

<table>
<tr>
<td width="33%" align="center"><h2>199</h2><p>unit tests passed</p></td>
<td width="33%" align="center"><h2>8</h2><p>real-server integration tests passed</p></td>
<td width="33%" align="center"><h2>1.18.30</h2><p>OpenCode version verified</p></td>
</tr>
</table>

The integration harness starts a real OpenCode server with isolated configuration and a local deterministic model fixture. It checks actual child sessions, native structured output, resume, background survival, stop/skip, parent cancellation, and a retained git worktree.

**7 real-terminal checks** exercise both configuration command spellings, connected-provider and model pages, persisted pool/default selections, and global scope. They also verify that opening settings creates no chat sessions or model API requests.

<details>
<summary><strong>Verification scope</strong></summary>

Recorded on September 9, 2026 with Bun 1.4.2 and OpenCode 1.18.30. These are recorded test results, not live CI indicators.

Unit coverage includes model/config policy, schemas, replay, cancellation, timed-out transports, late replies, missing-worker initialization, plugin registration, native dialog APIs, and installer preservation/failure handling.

The installer is also checked in an isolated environment with a real dependency install and build, including a repeat install that preserves configuration without duplicate entries.

Paid-provider behavior, plan quotas, terminal run-management interactions, and the web UI have not been tested. The live sidebar is not implemented.

</details>

<br />

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

For the isolated OpenCode suite and package contents:

```sh
bun run test:integration
npm pack --dry-run
```

For real keyboard-and-screen verification of the settings pages, install `tmux` and OpenCode, then:

```sh
bun run test:tui
```

The TUI checks use isolated configuration and fixture connections; they do not use your provider credentials or make paid model calls.

<details>
<summary><strong>Find your way around the source</strong></summary>

```text
src/
├── server.ts          Commands, hooks, and tools
├── tui.ts             Native configuration and run dialogs
└── core/
    ├── config.ts      Validated, layered settings
    ├── models.ts      Connected catalog and model policy
    ├── reference.ts   Workflow authoring contract
    ├── script/        Literal metadata and syntax validation
    ├── runtime/       Worker, VM, and host protocol
    └── run/           Execution, persistence, replay, reporting
```

`test/` contains unit tests. `e2e/` contains the real-server harness and local model fixture. `workflows/` contains the built-in scripts.

Builds produce the server, TUI, worker, and runtime authoring guide in the distribution directory. Generated files and local AI configuration are excluded from GitHub.

</details>

<br />

---

<div align="center">

### Build together. Keep the progress.

**[Start your first workflow](#quick-start)** &nbsp; · &nbsp; [Explore the source](src) &nbsp; · &nbsp; [MIT license](LICENSE)

<sub>OPENCODE WORKFLOW ENGINE &nbsp; / &nbsp; v0.1.0</sub>

</div>
