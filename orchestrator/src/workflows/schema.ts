import { z } from 'zod';
import { pluginNodeReference, workflowNodeSpec } from './nodes/registry.js';
import { settingNum } from '../settings.js';
import { refusedMatchesPattern } from './expr.js';
import { apiError, type ApiErrorBody } from '../api-error.js';

const node = z.object({ id:z.string().min(1), type:z.string(), label:z.string().optional(), position:z.object({x:z.number(),y:z.number()}).optional(), config:z.record(z.string(), z.unknown()).default({}) });
const edge = z.object({ id:z.string().min(1), from:z.string(), fromPort:z.string(), to:z.string(), toPort:z.string().default('in'), condition:z.string().nullable().optional(), loop:z.boolean().optional(), maxIterations:z.number().int().positive().optional() });
/** Ceiling on a loop edge's `maxIterations`, whatever the definition says:
 *  every pass may spawn agents, and a typo of 1000 must not cost a thousand. */
export const MAX_LOOP_ITERATIONS = 100;

/** The nodes a loop edge sends back to `pending`: its target and everything
 *  downstream of it through ordinary edges. */
export function loopBody(definition: { edges: Array<{ from: string; to: string; loop?: boolean }> }, target: string): Set<string> {
  const body = new Set<string>([target]); const queue = [target];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const edge of definition.edges) if (edge.from === id && !edge.loop && !body.has(edge.to)) { body.add(edge.to); queue.push(edge.to); }
  }
  return body;
}

/** First zod issues of a node config, as one readable line: an agent reading
 *  "invalid config for skill-1" cannot know WHICH field is missing. */
function describeIssues(error: z.ZodError): string {
  return error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'config'} ${issue.message}`).join('; ');
}

type ExpressionHolders = { nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>; edges: Array<{ id: string; condition?: string | null }> };

/** Refuses at save every expression whose literal `matches` pattern the safe
 *  regex engine would refuse at run: condition nodes, edge conditions and the
 *  payload filter of trigger nodes. */
function checkExpressions(v: ExpressionHolders, ctx: z.RefinementCtx): void {
  for (const n of v.nodes) {
    const expr = n.type === 'condition' ? n.config.expr : n.type.startsWith('trigger.') ? n.config.filter : undefined;
    if (typeof expr !== 'string') continue;
    const refused = refusedMatchesPattern(expr);
    if (refused) ctx.addIssue({ code: 'custom', message: `${n.id}: ${refused}`, path: ['nodes', n.id] });
  }
  for (const e of v.edges) {
    if (typeof e.condition !== 'string') continue;
    const refused = refusedMatchesPattern(e.condition);
    if (refused) ctx.addIssue({ code: 'custom', message: `edge ${e.id}: ${refused}`, path: ['edges', e.id] });
  }
}

const storedWorkflowDefinitionSchema = z.object({ schemaVersion:z.literal(1), nodes:z.array(node).min(1), edges:z.array(edge).default([]), variables:z.array(z.object({name:z.string(),type:z.enum(['string','number','boolean','json']),default:z.unknown().optional()})).default([]), settings:z.object({browserProfileId:z.string().min(1).nullable().optional(),timeoutMs:z.number().positive().optional(),maxParallel:z.number().int().positive().default(3),maxCostUsd:z.number().nonnegative().optional(),onError:z.enum(['fail','continue']).default('fail'),overlap:z.enum(['skip','queue','parallel']).default('skip')}).default({maxParallel:3,onError:'fail',overlap:'skip'}) });
export const workflowDefinitionSchema = storedWorkflowDefinitionSchema.superRefine((v,ctx) => {
 checkExpressions(v, ctx);
 const ids=new Set<string>(); for(const n of v.nodes){if(ids.has(n.id))ctx.addIssue({code:'custom',message:`duplicate node id: ${n.id}`,path:['nodes',n.id]});ids.add(n.id); const spec=workflowNodeSpec(n.type);if(!spec)ctx.addIssue({code:'custom',message:`unknown node type: ${n.type}`,path:['nodes',n.id]});else {const r=spec.configSchema.safeParse(n.config);if(!r.success)ctx.addIssue({code:'custom',message:`invalid config for ${n.id}: ${describeIssues(r.error)}`,path:['nodes',n.id]});}if((n.type==='agent'||n.type==='skill')&&typeof n.config.timeoutMs==='number'&&n.config.timeoutMs>settingNum('TIMON_REAP_HUNG_MS'))ctx.addIssue({code:'custom',message:`node timeoutMs must not exceed TIMON_REAP_HUNG_MS for ${n.id}`,path:['nodes',n.id]});}
 for (const n of v.nodes) {
   if (pluginNodeReference(n.type)?.kind !== 'executor' || n.config.retries === undefined) continue;
   const retries = n.config.retries;
   if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0 || retries > 10) {
     ctx.addIssue({ code: 'custom', message: `plugin node retries must be an integer between 0 and 10 for ${n.id}`, path: ['nodes', n.id] });
   }
 }
 if(!v.nodes.some(n=>n.type.startsWith('trigger.')))ctx.addIssue({code:'custom',message:'at least one trigger is required'});
 for(const e of v.edges){const a=v.nodes.find(n=>n.id===e.from), b=v.nodes.find(n=>n.id===e.to);if(!a||!b){ctx.addIssue({code:'custom',message:`edge ${e.id} references unknown node`,path:['edges',e.id]});continue;}const ports=workflowNodeSpec(a.type)?.ports.out??[];const routes=(a.type==='agent'||a.type==='skill')&&Array.isArray(a.config.routes)?a.config.routes:[];if(!ports.includes(e.fromPort) && !routes.includes(e.fromPort) && !(a.type==='switch' && (a.config.cases as unknown[] ?? []).some((x)=>typeof x==='object'&&x!==null&&(x as {port?:unknown}).port===e.fromPort)))ctx.addIssue({code:'custom',message:`undeclared output port: ${e.fromPort}`,path:['edges',e.id]});if(e.loop && !e.maxIterations)ctx.addIssue({code:'custom',message:'loop edge requires maxIterations',path:['edges',e.id]});if(e.loop && e.maxIterations && e.maxIterations>MAX_LOOP_ITERATIONS)ctx.addIssue({code:'custom',message:`loop edge maxIterations must not exceed ${MAX_LOOP_ITERATIONS}`,path:['edges',e.id]});
   // The engine re-runs the body from the target up to the source: a loop edge that closes no cycle would have no body holding its source.
   if(e.loop && !loopBody(v,e.to).has(e.from))ctx.addIssue({code:'custom',message:`loop edge ${e.id} must lead back to a node that reaches ${e.from}`,path:['edges',e.id]});}
 const seen=new Set<string>(), stack=new Set<string>(); const visit=(id:string):boolean=>{if(stack.has(id))return true;if(seen.has(id))return false;seen.add(id);stack.add(id);const cycle=v.edges.filter(e=>e.from===id&&!e.loop).some(e=>visit(e.to));stack.delete(id);return cycle;};if(v.nodes.some(n=>visit(n.id)))ctx.addIssue({code:'custom',message:'cycle without loop edge'});
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
/**
 * Draft schema: structure only.
 *
 * A draft is a work in progress — a node just dropped on the canvas has an
 * empty config (an `agent` without a ref, a `skill` without a skillId), and
 * the graph may still be a lone trigger or a cycle being wired. Validating it
 * with the publish schema rejected every fresh node and the whole document was
 * refused with "invalid config for <id>" (the "Save failed" banner). The strict
 * rules belong to publish and run, which freeze a version that must execute.
 */
const workflowDraftStructureSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(node).default([]),
  edges: z.array(edge).default([]),
  variables: z.array(z.object({ name: z.string(), type: z.enum(['string','number','boolean','json']), default: z.unknown().optional() })).default([]),
  settings: z.object({ browserProfileId:z.string().min(1).nullable().optional(), timeoutMs:z.number().positive().optional(), maxParallel:z.number().int().positive().default(3), maxCostUsd:z.number().nonnegative().optional(), onError:z.enum(['fail','continue']).default('fail'), overlap:z.enum(['skip','queue','parallel']).default('skip') }).default({maxParallel:3,onError:'fail',overlap:'skip'}),
}).superRefine((v, ctx) => {
  const ids = new Set<string>();
  for (const n of v.nodes) {
    if (ids.has(n.id)) ctx.addIssue({ code:'custom', message:`duplicate node id: ${n.id}` });
    ids.add(n.id);
    if (!workflowNodeSpec(n.type) && !pluginNodeReference(n.type)) ctx.addIssue({ code:'custom', message:`unknown node type: ${n.type}` });
  }
  for (const e of v.edges) if (!ids.has(e.from) || !ids.has(e.to)) ctx.addIssue({ code:'custom', message:`edge ${e.id} references unknown node` });
});
export const workflowDraftSchema = workflowDraftStructureSchema.superRefine(checkExpressions);

export function parseWorkflowDraft(value: unknown): WorkflowDefinition {
  return workflowDraftSchema.parse(value) as WorkflowDefinition;
}

/** A stored draft, read back without the expression check: a workflow saved
 *  before a pattern became refused must stay deletable. */
export function parseStoredWorkflowDraft(value: unknown): WorkflowDefinition {
  return workflowDraftStructureSchema.parse(value) as WorkflowDefinition;
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition { return workflowDefinitionSchema.parse(value); }

/** Only for immutable versions previously admitted at publication/run creation. */
export function parseStoredWorkflowDefinition(value: unknown): WorkflowDefinition { return storedWorkflowDefinitionSchema.parse(value); }

export type WorkflowIssue = { message: string; nodeId?: string; edgeId?: string };

/** Validation issues of a definition, each tied to the node or edge it blames
 * so the builder can mark it on the canvas; `null` for any other error. */
export function workflowIssues(error: unknown): WorkflowIssue[] | null {
  if (!(error instanceof z.ZodError)) return null;
  return error.issues.map((issue) => {
    const [kind, id] = issue.path;
    const scope = typeof id === 'string' ? (kind === 'nodes' ? { nodeId: id } : kind === 'edges' ? { edgeId: id } : {}) : {};
    return { message: issue.message, ...scope };
  });
}

/** The API body of a refused publish or run: one readable sentence, never a
 * raw zod dump, plus the per-node list when validation is the cause. */
export function describeWorkflowError(error: unknown): ApiErrorBody & { issues?: WorkflowIssue[] } {
  const issues = workflowIssues(error);
  if (!issues || !issues.length) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError('workflow_refused', message, { detail: message });
  }
  const [first] = issues;
  const rest = issues.length - 1;
  const message = rest > 0 ? `${first!.message} (+${rest} more)` : first!.message;
  return { ...apiError('workflow_refused', message, { detail: message }), issues };
}
