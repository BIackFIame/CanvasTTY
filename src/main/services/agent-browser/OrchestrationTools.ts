import type { OrchestrationCommandHandler, OrchestrationRequest } from "./orchestration-protocol.ts";
import { orchestrationBridgeError } from "./orchestration-protocol.ts";
import type { ProviderId, SessionRole } from "../../../shared/contracts.ts";
import { PromptNotDeliveredError, type AgentControlService, type SpawnAgentRequest } from "../AgentControlService.ts";
import type { PluginAgentTools } from "../PluginAgentTools.ts";
import {
  DEFAULT_AGENT_WAIT_SECONDS,
  MAX_AGENT_WAIT_SECONDS,
  ORCHESTRATION_TOOL_DEFINITIONS,
  isPluginOrchestrationTool,
  unknownProviderMessage
} from "../../../agent-browser/orchestration-catalog.mjs";
import { AGENT_PROVIDERS } from "../../../shared/contracts.ts";
import { listProviderDirectory, type ProviderDirectorySources } from "../providerDirectory.ts";
import type { McpToolDefinition } from "../../../agent-browser/orchestration-catalog.mjs";

/**
 * The only bridge between the orchestration MCP surface and session control.
 * Every tool call is scoped to the authenticated orchestrator's own subtree:
 * a foreign session id is a protocol error, never a filtered result, so an
 * orchestrator cannot probe sessions it does not own.
 */
export class ScopedOrchestrationHandler implements OrchestrationCommandHandler {
  private readonly control: AgentControlService;
  private readonly plugins: Pick<PluginAgentTools, "list" | "call"> | null;
  private readonly providers: ProviderDirectorySources;

  constructor(
    control: AgentControlService,
    plugins: Pick<PluginAgentTools, "list" | "call"> | null = null,
    providers: ProviderDirectorySources = { cli: () => null, limits: () => null }
  ) {
    this.control = control;
    this.plugins = plugins;
    this.providers = providers;
  }

  /** Orchestrators see the core tools; every role sees the plugin tools that list it (EP-6). */
  listTools(sessionId: string): McpToolDefinition[] {
    const session = this.control.status(sessionId);
    return [
      ...(session.role === "orchestrator" ? ORCHESTRATION_TOOL_DEFINITIONS : []),
      ...(this.plugins?.list(session.role, session.provider) ?? [])
    ];
  }

  async execute(sessionId: string, request: OrchestrationRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      if (signal?.aborted) throw canceledError();
      const session = this.control.status(sessionId);
      if (isPluginOrchestrationTool(request.tool)) return await this.plugin(sessionId, session, request);
      // Plugin tools may reach other roles' sessions through the same bridge; the core tools never do.
      if (session.role !== "orchestrator") {
        throw orchestrationBridgeError("INVALID_REQUEST", "Only orchestrator sessions can use CanvasTTY's agent tools.", false);
      }
      switch (request.tool) {
        case "list_providers":
          return this.listProviders(session);
        case "wait_for_agent":
          return await this.wait(sessionId, request.arguments, signal);
        case "spawn_agent":
          return await this.spawn(sessionId, request.arguments, signal);
        case "send_to_agent":
          return await this.send(sessionId, request.arguments);
        case "observe_agent":
          return this.observe(sessionId, request.arguments);
        case "get_agent_result":
          return this.result(sessionId, request.arguments);
        case "cancel_agent":
          return this.cancel(sessionId, request.arguments);
        case "list_agents":
          return this.list(sessionId);
        default:
          throw orchestrationBridgeError("INVALID_REQUEST", "Unsupported orchestration tool.", false);
      }
    } catch (error) {
      if (error && typeof error === "object" && "bridgeError" in error) throw error;
      // The launch was refused, cancelled or superseded: retrying the same call would not deliver it either.
      if (error instanceof PromptNotDeliveredError) throw orchestrationBridgeError("INVALID_REQUEST", error.message, false);
      throw orchestrationBridgeError(
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : "Orchestration command failed.",
        true
      );
    }
  }

  private async plugin(
    sessionId: string,
    session: { role: SessionRole; provider: ProviderId },
    request: OrchestrationRequest
  ): Promise<Record<string, unknown>> {
    if (!this.plugins?.list(session.role, session.provider).some((tool) => tool.name === request.tool)) {
      throw orchestrationBridgeError("INVALID_REQUEST", "That plugin tool is not available to this session.", false);
    }
    try {
      const result = await this.plugins.call(sessionId, session.role, request.tool, request.arguments);
      return { pluginTool: true, text: result.content, isError: result.isError };
    } catch (error) {
      throw orchestrationBridgeError("INVALID_REQUEST", error instanceof Error ? error.message : "The plugin tool failed.", false);
    }
  }

  private listProviders(session: { role: SessionRole; provider: ProviderId }): Record<string, unknown> {
    const pluginTools = this.plugins?.list(session.role, session.provider).map((tool) => tool.name) ?? [];
    return listProviderDirectory(this.providers, pluginTools) as unknown as Record<string, unknown>;
  }

  private async wait(orchestratorId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const target = args.sessionId as string;
    // Its own session is in its subtree, but waiting on itself would only ever time out.
    if (target === orchestratorId) {
      throw orchestrationBridgeError("INVALID_REQUEST", "wait_for_agent waits for a subagent, not for this session.", false);
    }
    this.requireOwned(orchestratorId, target);
    const seconds = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : DEFAULT_AGENT_WAIT_SECONDS;
    try {
      const result = await this.control.waitFor(target, {
        timeoutMs: Math.min(MAX_AGENT_WAIT_SECONDS, Math.max(1, seconds)) * 1_000,
        ...(signal ? { signal } : {})
      });
      return { ...result };
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw canceledError();
      throw error;
    }
  }

  private async spawn(orchestratorId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!(AGENT_PROVIDERS as readonly unknown[]).includes(args.provider)) {
      throw orchestrationBridgeError("INVALID_REQUEST", unknownProviderMessage(args.provider), false);
    }
    const created = await this.control.spawn({
      parentSessionId: orchestratorId,
      provider: args.provider as never,
      cwd: args.cwd as string,
      ...(args.title !== undefined ? { title: args.title as string } : {}),
      ...(args.prompt !== undefined ? { initialPrompt: args.prompt as string } : {}),
      ...(args.launchOptions !== undefined ? { launchOptions: args.launchOptions as SpawnAgentRequest["launchOptions"] } : {})
    });
    if (signal?.aborted) {
      // Canceled while the agent was starting: nobody will receive its id, so close it.
      try {
        this.control.cancel(created.id);
      } catch {
        // It already ended.
      }
      throw canceledError();
    }
    return {
      sessionId: created.id,
      provider: created.provider,
      status: created.status,
      title: created.title
    };
  }

  private async send(orchestratorId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    await this.control.send(
      args.sessionId as string,
      args.prompt as string,
      args.submit === undefined ? true : Boolean(args.submit)
    );
    return { sessionId: args.sessionId as string, sent: true };
  }

  private observe(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    const observation = this.control.observe(
      args.sessionId as string,
      args.maxChars as number | undefined
    );
    return { sessionId: observation.sessionId, status: observation.status, output: observation.output };
  }

  private result(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    const result = this.control.result(args.sessionId as string);
    return {
      sessionId: result.sessionId,
      state: result.state,
      exitCode: result.exitCode,
      output: result.output
    };
  }

  private cancel(orchestratorId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.requireOwned(orchestratorId, args.sessionId as string);
    this.control.cancel(args.sessionId as string);
    return { sessionId: args.sessionId as string, canceled: true };
  }

  private list(orchestratorId: string): Record<string, unknown> {
    return {
      agents: this.control.children(orchestratorId).map((session) => ({
        sessionId: session.id,
        provider: session.provider,
        status: session.status,
        title: session.title
      }))
    };
  }

  private requireOwned(orchestratorId: string, sessionId: string): void {
    if (!this.control.isInSubtree(orchestratorId, sessionId)) {
      throw orchestrationBridgeError(
        "INVALID_REQUEST",
        "That session is not part of this orchestrator's subtree.",
        false
      );
    }
  }
}

function canceledError(): Error {
  return orchestrationBridgeError("CANCELED", "Orchestration command was canceled.", true);
}
