export const commands = {
  workflow: { description: "Design and execute a resumable multi-agent workflow", template: "Read workflow_reference, then design and run a JavaScript workflow for this task. Honor explicit model requests and the size guideline; check null results. Use background for lengthy work. Task: $ARGUMENTS" },
  "workflows-chat": { description: "Chat fallback: list workflow runs and progress", template: "Use workflow_runs with action list to show this session's runs. $ARGUMENTS" },
  "workflow-config-chat": { description: "Chat fallback: choose workflow models and limits", template: "Use workflow_config show to list exact connected provider/model IDs and current settings. Help the user choose allowed models with the question tool if needed, then use workflow_config set. User request: $ARGUMENTS" },
  "workflow-stop": { description: "Stop a workflow", template: "Use workflow_runs stop for the requested run ID, or the latest active run in this session when omitted: $ARGUMENTS" },
};
