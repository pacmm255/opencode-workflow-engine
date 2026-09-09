import type { TuiCommand, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { loadConfig } from "../core/config";
import { effectiveUltracode, UltracodeSessionStore, ultracodeOriginKey, ultracodeOptOutKey,
  type UltracodeSessionOverride } from "../core/ultracode";

type RequestBridge = {
  use(handler: (request: Request) => Promise<Request>): number;
  eject(id: number): void;
};

/** Terminal-client attestation; preserve explicit automation origins and synthetic parts. */
export function registerUltracodeControls(api: TuiPluginApi, input: {
  local: boolean;
  perform: (action: () => void | Promise<void>) => Promise<void>;
  remoteRequest: (title: string, request: string) => void;
}): { commands: TuiCommand[]; dispose: () => void } {
  let pending: UltracodeSessionOverride | undefined;
  let dismissNext = false;
  let disposed = false;
  const sessionID = () => api.route.current.name === "session" ? api.route.current.params?.sessionID as string | undefined : undefined;
  const store = () => new UltracodeSessionStore(api.state.path.directory);
  const transport = api.client as unknown as { client?: { interceptors?: { request: RequestBridge } }; _client?: { interceptors?: { request: RequestBridge } } };
  const bridge = (transport.client ?? transport._client)?.interceptors?.request;
  const interceptor = bridge?.use(async request => {
    if (disposed || request.method !== "POST") return request;
    const match = /\/session\/([^/]+)\/(message|prompt_async|command)$/.exec(new URL(request.url).pathname);
    if (!match) return request;
    const body = await request.clone().json() as { parts?: Array<{ type: string; text?: string; synthetic?: boolean; ignored?: boolean; metadata?: Record<string, unknown> }> };
    const humanParts = body.parts?.filter(part => part.type === "text" && !part.synthetic && !part.ignored && part.text?.trim()
      && (part.metadata?.[ultracodeOriginKey] === undefined || part.metadata[ultracodeOriginKey] === "human"));
    if (!humanParts?.length && match[2] !== "command") return request;
    if (pending && input.local) { await store().set(decodeURIComponent(match[1]!), pending); pending = undefined; }
    if (!humanParts?.length) return request;
    for (const part of humanParts) part.metadata = { ...part.metadata, [ultracodeOriginKey]: "human", ...(dismissNext ? { [ultracodeOptOutKey]: true } : {}) };
    dismissNext = false;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return new Request(request, { headers, body: JSON.stringify(body) });
  });

  async function menu() {
    if (!input.local) {
      input.remoteRequest("Ultracode on a remote server", "Use workflow_mode with action show, then help me enable or disable automatic workflows for this session.");
      return;
    }
    const id = sessionID();
    const parent = id ? api.state.session.get(id) : undefined;
    if (parent?.parentID) {
      api.ui.dialog.replace(() => api.ui.DialogAlert({ title: "Ultracode", message: "Return to the parent session to change automatic workflows." }));
      return;
    }
    const config = await loadConfig(api.state.path.directory, api.state.path.config);
    const settings = effectiveUltracode(config, id ? await store().get(id) : pending);
    api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
      title: `Ultracode — ${settings.enabled ? "on" : "off"} (${id ? "this session" : "next session"})`,
      options: [
        { title: "Enable Ultracode", value: "on", description: "Automatic workflows; exact xhigh where supported" },
        { title: "Enable with current effort", value: "current", description: "Automatic workflows; keep the model's current effort" },
        { title: "Disable Ultracode", value: "off", description: "Stop automatic orchestration for future requests" },
        { title: "Use high effort", value: "high", description: "Automatic mode off; exact high where supported" },
        { title: "Use configured default", value: "reset", description: "Clear this session override" },
        { title: `${dismissNext ? "Restore" : "Dismiss"} trigger for next prompt`, value: "dismiss", description: "One prompt only; session settings stay unchanged" },
        { title: "Done", value: "done" },
      ],
      onSelect: entry => input.perform(async () => {
        if (entry.value === "done") { api.ui.dialog.clear(); return; }
        if (entry.value === "dismiss") dismissNext = !dismissNext;
        else if (entry.value === "reset") {
          if (id) await store().clear(id);
          else pending = undefined;
        } else {
          const value: UltracodeSessionOverride = { enabled: entry.value === "on" || entry.value === "current",
            effort: entry.value === "on" ? "xhigh" : entry.value === "high" ? "high" : null };
          if (id) await store().set(id, value);
          else pending = value;
        }
        await menu();
      }),
    }));
    api.ui.dialog.setSize?.("large");
  }

  return {
    commands: [
      { title: "Configure Ultracode automatic workflows", value: "workflow.ultracode", category: "Workflow",
        slash: { name: "ultracode" }, onSelect: () => input.perform(menu) },
      { title: "Dismiss or restore workflow trigger for next prompt", value: "workflow.ultracode.dismiss", category: "Workflow",
        slash: { name: "workflow-dismiss" }, onSelect: () => input.perform(() => {
          dismissNext = !dismissNext;
          api.ui.dialog.clear();
          api.ui.toast({ variant: "info", message: dismissNext ? "Automatic workflow trigger dismissed for the next prompt." : "Automatic workflow trigger restored." });
        }) },
    ],
    dispose: () => { disposed = true; if (interceptor !== undefined) bridge?.eject(interceptor); },
  };
}
