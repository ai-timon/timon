import { isValidAgentName } from '../../agent-name.js';
import { dbApi } from '../../db.js';
import { resolveBrowserProfile } from '../../browser-profiles.js';
import { resolveBrowserProject } from '../../browser-project.js';
import { getBackend } from '../../backends/index.js';
import { activeProfiles } from '../../backends/registry.js';
import { loadConfig, spawnAgent, type AgentConfig } from '../../agent.js';
import type { WorkflowDefinition } from '../schema.js';
import { interpolateTemplate } from '../template.js';

export type AgentNodeContext = Record<string, unknown>;

type NodeConfig = {
  ref?: string; identity?: { name?: string; instructions?: string; backend?: string; model?: string; reasoningEffort?: string | null; skills?: string[]; mcpServers?: string[]; allowedTools?: string[]; permissionMode?: string; browserProfileId?: string | null; cwd?: string; project?: string };
  input?: string; completion?: 'turn' | 'explicit'; timeoutMs?: number; retries?: number; routes?: string[];
  backend?: string; model?: string; reasoningEffort?: string | null; skills?: string[]; mcpServers?: string[]; allowedTools?: string[]; permissionMode?: string; browserProfileId?: string | null;
};

export function workflowAgentName(slug: string, nodeId: string): string {
  const name = `wf.${slug}.${nodeId}`;
  if (!isValidAgentName(name)) throw new Error(`inline workflow agent name is invalid: ${name}`);
  return name;
}

export function outputContract(): string {
  return 'When finished, optionally return a ```json timon:output block with a route and structured output; otherwise your final text is sent to done.';
}

/** Effective runtime of a node: unset inline settings inherit the pilot
 * (backend, model, mission overrides, profile defaults); referenced agents
 * keep their configured runtime. */
export function workflowNodeRuntime(missionId: string, node: WorkflowDefinition['nodes'][number]) {
  const mission = dbApi.getMission(missionId);
  if (!mission) throw new Error('workflow coordinator mission missing');
  const pilot = loadConfig(mission.agent_name);
  const config = node.config as NodeConfig;
  const ref = config.ref ? loadConfig(config.ref) : undefined;
  const backend = getBackend(mission.backend_override ?? pilot.backend).name;
  const defaultModel = (id: string) => activeProfiles().find(({ profile }) => profile.id === id)?.profile.defaultModel ?? null;
  const model = mission.model_override ?? pilot.model ?? defaultModel(backend);
  const nodeBackend = getBackend(config.backend ?? config.identity?.backend ?? ref?.backend ?? backend).name;
  const nodeModel = config.model ?? config.identity?.model ?? ref?.model ?? (nodeBackend === backend ? model : defaultModel(nodeBackend));
  const run = mission.workflow_run_id ? dbApi.getWorkflowRun(mission.workflow_run_id) : null;
  const workflow = run ? dbApi.getWorkflow(run.workflow_id) : null;
  const version = run ? dbApi.getWorkflowVersion(run.workflow_id, run.version) : null;
  const settings = version ? (JSON.parse(version.definition) as WorkflowDefinition).settings : undefined;
  const selection = config.browserProfileId !== undefined ? config.browserProfileId
    : config.identity?.browserProfileId !== undefined ? config.identity.browserProfileId
    : settings?.browserProfileId;
  const agentName = config.ref ?? (workflow ? workflowAgentName(workflow.slug, node.id) : mission.agent_name);
  const profile = resolveBrowserProfile({ ownerUserId: mission.owner_user_id, agentName,
    project: resolveBrowserProject({
      agentProject: ref?.project || config.identity?.project || pilot.project, workflowProject: workflow?.project,
      agentCwd: ref?.cwd ?? config.identity?.cwd ?? pilot.cwd }),
    workflowSlug: workflow?.slug, selection });
  return { backend: nodeBackend, model: nodeModel, browserProfileId: profile?.id ?? null };
}

export async function spawnWorkflowAgent(input: { parentMissionId?: string; ownerUserId?: string | null; runId: string; nodeId: string; attempt: number; slug: string; node: WorkflowDefinition['nodes'][number]; context: AgentNodeContext; skillId?: string; extraSkillIds?: string[] }): Promise<string> {
  const config = input.node.config as NodeConfig;
  const identity = config.identity;
  const agentName = config.ref ?? (identity ? workflowAgentName(input.slug, input.nodeId) : undefined);
  if (!agentName) throw new Error('agent node requires a ref or published inline identity');
  const cfg: AgentConfig = loadConfig(agentName);
  const runtime = input.parentMissionId ? workflowNodeRuntime(input.parentMissionId, input.node) : null;
  const briefBody = interpolateTemplate(String(config.input ?? ''), input.context);
  const skillPrefix = input.skillId ? `Apply skill ${input.skillId} to: ` : '';
  const brief = `${skillPrefix}${briefBody}\n\n${outputContract()}`;
  const extraSkills = [...new Set([...(identity?.skills ?? []), ...(config.skills ?? []), ...(input.skillId ? [input.skillId] : []), ...(input.extraSkillIds ?? [])])];
  const extraMcpServers = [...new Set([...(identity?.mcpServers ?? []), ...(config.mcpServers ?? [])])];
  const extraAllowedTools = [...new Set([...(identity?.allowedTools ?? []), ...(config.allowedTools ?? [])])];
  return spawnAgent(agentName, brief, { channel: 'workflow', meta: { workflow_run_id: input.runId, workflow_node_id: input.nodeId, workflow_node_attempt: input.attempt } }, {
    traceId: input.runId,
    parentMissionId: input.parentMissionId,
    ownerUserId: input.ownerUserId,
    workflow: { runId: input.runId, nodeId: input.nodeId },
    browserProfileId: runtime ? runtime.browserProfileId
      : config.browserProfileId !== undefined ? config.browserProfileId : identity?.browserProfileId,
    explicitResume: null,
    extraSkills,
    extraMcpServers,
    extraAllowedTools,
    backendOverride: runtime?.backend ?? config.backend ?? identity?.backend ?? cfg.backend ?? null,
    modelOverride: runtime ? runtime.model : config.model ?? identity?.model ?? cfg.model ?? null,
    permissionModeOverride: config.permissionMode ?? identity?.permissionMode ?? cfg.permission_mode ?? null,
    reasoningEffort: config.reasoningEffort ?? identity?.reasoningEffort ?? cfg.reasoningEffort ?? null,
    origin: { kind: 'workflow', from: input.slug },
    // The node names its mission (`preset`): its label, else the workflow and node ids.
    title: input.node.label?.trim() ? `${input.slug}: ${input.node.label.trim()}` : `${input.slug}: ${input.nodeId}`,
  });
}

export function parseAgentOutput(value: unknown): { output: unknown; port: string } {
  const text = finalText(value);
  const block = /```json\s+timon:output\s*\n([\s\S]*?)\n```/i.exec(text);
  if (!block) return { output: { text }, port: 'done' };
  let parsed: unknown;
  try { parsed = JSON.parse(block[1]!); } catch { return { output: { text }, port: 'done' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { output: { text }, port: 'done' };
  const { route, ...output } = parsed as Record<string, unknown>;
  return { output, port: typeof route === 'string' && route ? route : 'done' };
}

function finalText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'result', 'output']) if (typeof item[key] === 'string') return item[key] as string;
  const message = item.message;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => typeof part === 'object' && part && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text : '').join('');
  }
  return '';
}
