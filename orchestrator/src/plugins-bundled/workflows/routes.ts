import { automationOriginOf, emitAutomationEvent } from '../../plugins/automation-events.js';
import { ensureWorkflowCoordinator, removeWorkflowCoordinator } from '../../workflows/coordinator.js';
import { randomUUID } from 'node:crypto';
import type { Request, Router } from 'express';
import { dbApi, type WorkflowRow } from '../../db.js';
import { answerWorkflowHuman, cancelRun, completeWorkflowNode, startWorkflowRun as createRun, provisionInlineWorkflowAgents, removeInlineWorkflowAgents } from '../../workflows/engine.js';
import { describeWorkflowError, parseStoredWorkflowDefinition, parseStoredWorkflowDraft, parseWorkflowDefinition, parseWorkflowDraft } from '../../workflows/schema.js';
import { existsSync } from 'node:fs';
import { agentDir } from '../../paths.js';
import { armWorkflowTriggers, disarmWorkflowTriggers, dropWorkflowTriggers } from '../../workflows/triggers.js';
import { checkWorkflowTriggers, workflowNodeTriggers } from '../../workflows/native-facade.js';
import { viewerFromRequest } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { pluginNodeReference, workflowNodeSpecs } from '../../workflows/nodes/registry.js';
import { assertHttpNodesAllowed } from '../../workflows/nodes/http.js';
import { thirdPartyPluginVisible } from '../../users/surfaces.js';
import { convertRoutine, importAgent, importPipeline } from '../../workflows/import.js';
import { nativeBindings } from '../../workflows/native-bindings.js';
import { entryNodes } from '../../workflows/native-triggers.js';
import { acceptWorkflowProposal, listWorkflowProposals, proposeWorkflow, rejectWorkflowProposal } from '../../workflows/proposals.js';
import { SCRIPT_NODE_AGENT_REFUSAL, assertScriptNodesAllowed, changedScriptNodes } from '../../workflows/nodes/script.js';
import { apiError } from '../../api-error.js';
type WorkflowNodes = Array<{ id: string; type: string; config: Record<string, unknown> }>;
/** Mission, plugin and system tokens: none of them is a person at a screen. */
function callerIsAgent(req: Request): boolean { return req.auth?.kind === 'api-token'; }
/** A stored draft or version that no longer parses holds no script a caller could keep. */
function storedNodes(raw: string | undefined): WorkflowNodes {
 try { const parsed = JSON.parse(raw ?? '{}') as { nodes?: unknown }; return Array.isArray(parsed.nodes) ? parsed.nodes.filter((node): node is WorkflowNodes[number] => !!node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string' && typeof (node as { type?: unknown }).type === 'string').map((node) => ({ ...node, config: node.config ?? {} })) : []; } catch { return []; }
}
function publishedNodes(wf: WorkflowRow): WorkflowNodes {
 return wf.published_version ? storedNodes(dbApi.getWorkflowVersion(wf.id, wf.published_version)?.definition) : [];
}
/**
 * A script runs a program on the host: an agent never adds or changes one,
 * nor publishes or runs one a person has not published (TODO #685, the rule
 * of a trigger's script action). A script node kept as it was passes.
 */
class ScriptAuthorRefused extends Error {}
function refuseAgentScripts(req: Request, next: WorkflowNodes, previous: WorkflowNodes): void {
 if (!callerIsAgent(req)) return;
 const changed = changedScriptNodes(next, previous);
 if (changed.length) throw new ScriptAuthorRefused(`${SCRIPT_NODE_AGENT_REFUSAL} (${changed.join(', ')})`);
}
function workflowError(res: { status: (code: number) => { json: (body: unknown) => void } }, e: unknown): void {
 if (e instanceof ScriptAuthorRefused) { res.status(403).json({ error: e.message }); return; }
 res.status(400).json(describeWorkflowError(e));
}
/** An assigned agent must exist: the pilot is woken for every run and chat. */
function assignedAgent(value: unknown, required: boolean): string | undefined {
 if (value === undefined || value === null) { if (required) throw new Error('agent_name required'); return undefined; }
 if (typeof value !== 'string' || !value.trim()) throw new Error('agent_name required');
 if (!existsSync(agentDir(value))) throw new Error(`agent ${value} not found`);
 return value;
}
/** Spans the run view gets at most, payloads left out: a run of a few thousand
 *  tool calls answered several megabytes at every refresh (TODO #547). */
export const RUN_SPANS_DEFAULT=2000;
export const RUN_SPANS_MAX=5000;
function runSpans(runId:string,raw:unknown):{spans:unknown[];spans_total:number;spans_truncated:boolean}{
 const asked=Number(raw);
 const limit=Number.isInteger(asked)&&asked>0?Math.min(asked,RUN_SPANS_MAX):RUN_SPANS_DEFAULT;
 const page=dbApi.listSpanSummariesByRun(runId,limit);
 return {spans:page.spans,spans_total:page.total,spans_truncated:page.truncated};
}
export function registerRoutes(app:Router):void{
 // The gallery paints each card with its last run: one query per workflow is
 // cheap here (a handful of rows), and it spares the client N round trips.
 app.get('/api/workflows',(req,res)=>{const scope=scopedDb(viewerFromRequest(req));res.json({workflows:scope.listWorkflows().map((workflow)=>{const runs=scope.listWorkflowRuns(workflow.id);const last=runs[0];return {...workflow,run_count:runs.length,last_run:last?{id:last.id,status:last.status,started_at:last.started_at,ended_at:last.ended_at}:null};})});});
 // Recent runs across every visible workflow, newest first (cockpit widget).
 app.get('/api/workflows/runs',(req,res)=>{const scope=scopedDb(viewerFromRequest(req));const limit=Math.min(100,Math.max(1,Number(req.query.limit)||20));const names=new Map(scope.listWorkflows().map((workflow)=>[workflow.id,{slug:workflow.slug,name:workflow.name}]));const runs=[...names.keys()].flatMap((id)=>scope.listWorkflowRuns(id)).sort((a,b)=>b.started_at-a.started_at).slice(0,limit).map((run)=>({...run,context:undefined,workflow:names.get(run.workflow_id)??null}));res.json({runs});});
 app.post('/api/workflows/import/pipeline/:id',(req,res)=>{if(callerIsAgent(req)){res.status(403).json({error:`${SCRIPT_NODE_AGENT_REFUSAL} (a pipeline imports as a script node)`});return;}try{const body=req.body as {agent_name?:unknown};res.status(201).json({workflow:importPipeline(req.params.id,viewerFromRequest(req)?.id??null,assignedAgent(body?.agent_name,false),viewerFromRequest(req))});}catch(e){res.status(400).json({error:(e as Error).message});}});
 app.post('/api/workflows/import/agent/:name',(req,res)=>{try{res.status(201).json({workflow:importAgent(req.params.name,viewerFromRequest(req)?.id??null)});}catch(e){res.status(400).json({error:(e as Error).message});}});
 app.post('/api/workflows/import/routine/:id',(req,res)=>{try{res.status(201).json({workflow:convertRoutine(req.params.id,viewerFromRequest(req)?.id??null)});}catch(e){res.status(400).json({error:(e as Error).message});}});
 app.post('/api/workflows/:id/proposals',(req,res)=>{try{const missionId=req.auth?.missionId;if(!missionId){res.status(401).json({error:'mission token required'});return;}const body=req.body as {definition?:unknown;rationale?:unknown};res.status(201).json({proposal:proposeWorkflow(req.params.id,missionId,body.definition,body.rationale)});}catch(e){const msg=(e as Error).message;res.status(msg.includes('not found')?404:400).json({error:msg});}});
 app.get('/api/workflows/:id/proposals',(req,res)=>{const workflow=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!workflow){res.status(404).json(apiError('not_found', 'not found'));return;}res.json({proposals:listWorkflowProposals(workflow.id)});});
 app.post('/api/workflows/:id/proposals/:pid/accept',(req,res)=>{const wf=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!wf){res.status(404).json(apiError('not_found', 'not found'));return;}try{res.json({workflow:acceptWorkflowProposal(wf.id,req.params.pid,(definition,current)=>refuseAgentScripts(req,definition.nodes,storedNodes(current.draft)))});}catch(e){if(e instanceof ScriptAuthorRefused){res.status(403).json({error:e.message});return;}const msg=(e as Error).message;res.status(msg.includes('not found')?404:400).json({error:msg});}});
 app.post('/api/workflows/:id/proposals/:pid/reject',(req,res)=>{const wf=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!wf){res.status(404).json(apiError('not_found', 'not found'));return;}try{rejectWorkflowProposal(wf.id,req.params.pid);res.json({ok:true});}catch(e){const msg=(e as Error).message;res.status(msg.includes('not found')?404:400).json({error:msg});}});
 // The client must discover this registry instead of carrying a second,
 // inevitably stale list of workflow nodes and ports.
 app.get('/api/workflows/node-types',(req,res)=>{const viewer=viewerFromRequest(req);res.json({nodeTypes:workflowNodeSpecs().filter((spec)=>{const ref=pluginNodeReference(spec.type);return !ref||thirdPartyPluginVisible(viewer,ref.pluginId);}).map((spec)=>({type:spec.type,ports:spec.ports}))});});
 app.post('/api/workflows',(req,res)=>{try{const b=req.body as Record<string,unknown>;const draft=parseWorkflowDraft(b.draft);refuseAgentScripts(req,draft.nodes,[]);const now=Date.now();const row={id:randomUUID(),slug:String(b.slug??''),name:String(b.name??''),description:typeof b.description==='string'?b.description:null,project:typeof b.project==='string'?b.project:null,owner_user_id:viewerFromRequest(req)?.id??null,draft:JSON.stringify(draft),published_version:null,enabled:1,created_at:now,updated_at:now,agent_name:assignedAgent(b.agent_name,true)!};if(!/^[a-z0-9._-]{1,64}$/.test(row.slug)||!row.name)throw new Error('valid slug and name required');dbApi.insertWorkflow(row);res.status(201).json({workflow:row});}catch(e){res.status(e instanceof ScriptAuthorRefused?403:400).json(describeWorkflowError(e));}});
 // A run executes a frozen version: the client must draw THAT definition, not
 // the current draft (PRD §12.7), so the version travels with the run.
 app.get('/api/workflows/runs/:runId',(req,res)=>{const run=scopedDb(viewerFromRequest(req)).getWorkflowRun(req.params.runId);if(!run){res.status(404).json(apiError('not_found', 'not found'));return;}const workflow=dbApi.getWorkflow(run.workflow_id);const version=dbApi.getWorkflowVersion(run.workflow_id,run.version);let definition:unknown=null;try{definition=version?JSON.parse(version.definition):null;}catch{definition=null;}res.json({run,workflow:workflow?{id:workflow.id,slug:workflow.slug,name:workflow.name,published_version:workflow.published_version}:null,definition,nodes:dbApi.listWorkflowRunNodes(run.id),...runSpans(run.id,req.query.spans_limit)});});
 // The payloads of one span of the run, read when it is opened: the run view carries none.
 app.get('/api/workflows/runs/:runId/spans/:spanId',(req,res)=>{const run=scopedDb(viewerFromRequest(req)).getWorkflowRun(req.params.runId);const span=run?dbApi.getRunSpan(run.id,req.params.spanId):undefined;if(!span){res.status(404).json(apiError('not_found', 'not found'));return;}res.json({span});});
 app.post('/api/workflows/runs/:runId/cancel',(req,res)=>{if(!scopedDb(viewerFromRequest(req)).getWorkflowRun(req.params.runId)){res.status(404).json(apiError('not_found', 'not found'));return;}const cancelled=cancelRun(req.params.runId);const after=dbApi.getWorkflowRun(req.params.runId);if(cancelled&&after)emitAutomationEvent({kind:'workflow_run_cancelled',run:after,origin:automationOriginOf(req)});res.json({ok:cancelled});});
 app.post('/api/workflows/runs/:runId/nodes/:nodeId/done',(req,res)=>{const missionId=req.auth?.missionId;if(!missionId){res.status(401).json({error:'mission token required'});return;}const row=dbApi.listWorkflowRunNodes(req.params.runId).find((item)=>item.node_id===req.params.nodeId);if(!row||row.mission_id!==missionId){res.status(403).json({error:'mission token does not own this workflow node'});return;}const body=req.body as {output?:unknown;route?:unknown};if(typeof body.route!=='undefined'&&typeof body.route!=='string'){res.status(400).json({error:'route must be a string'});return;}if(!completeWorkflowNode(req.params.runId,req.params.nodeId,body.output??{},body.route??'done')){res.status(409).json({error:'workflow node is no longer active'});return;}res.json({ok:true});});
 app.get('/api/workflows/:id/runs',(req,res)=>{const scope=scopedDb(viewerFromRequest(req));const wf=scope.getWorkflow(req.params.id);if(!wf){res.status(404).json(apiError('not_found', 'not found'));return;}res.json({runs:scope.listWorkflowRuns(wf.id)});});
 app.post('/api/workflows/:id/publish',(req,res)=>{try{const wf=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!wf){res.status(404).json(apiError('not_found', 'not found'));return;}ensureWorkflowCoordinator(wf);const definition=parseWorkflowDefinition(JSON.parse(wf.draft));refuseAgentScripts(req,definition.nodes,publishedNodes(wf));assertScriptNodesAllowed(definition.nodes,wf.owner_user_id);assertHttpNodesAllowed(definition.nodes,wf.owner_user_id);checkWorkflowTriggers(wf,definition);provisionInlineWorkflowAgents(wf.slug,definition);const version=(wf.published_version??0)+1;dbApi.insertWorkflowVersion({workflow_id:wf.id,version,definition:JSON.stringify(definition),published_at:Date.now(),published_by:null});armWorkflowTriggers(wf.id);res.json({version});}catch(e){workflowError(res,e);}});
 app.post('/api/workflows/:id/run',(req,res)=>{try{const wf=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!wf){res.status(404).json(apiError('not_found', 'not found'));return;}const b=req.body as {input?:unknown;draft?:boolean};const published=publishedNodes(wf);const running=b.draft?storedNodes(wf.draft):published;refuseAgentScripts(req,running,published);assertScriptNodesAllowed(running,wf.owner_user_id);assertHttpNodesAllowed(running,wf.owner_user_id);const run=createRun(wf.id,{trigger:{kind:'api'},input:b.input,draft:b.draft});emitAutomationEvent({kind:'workflow_run_started',run,origin:automationOriginOf(req)});res.status(201).json({run});}catch(e){workflowError(res,e);}});
 app.post('/api/workflows/:id/chat-agent',(req,res)=>{
  const workflow=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);
  if(!workflow){res.status(404).json(apiError('not_found', 'not found'));return;}
  try { res.json({agent:ensureWorkflowCoordinator(workflow)}); }
  catch(error){res.status(400).json({error:(error as Error).message});}
 });
 app.get('/api/workflows/:id',(req,res)=>{const workflow=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!workflow){res.status(404).json(apiError('not_found', 'not found'));return;}res.json({workflow});});
 // `native`: the native triggers whose `workflow` action starts this workflow (TODO #216).
 // `triggers`: the native trigger behind each published façade node; `native`: every native trigger whose `workflow` action starts this workflow (façades included).
 app.get('/api/workflows/:id/triggers',(req,res)=>{const wf=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!wf){res.status(404).json(apiError('not_found', 'not found'));return;}res.json({triggers:workflowNodeTriggers(wf.id),native:nativeBindings(wf.id)});});
 app.get('/api/workflows/:id/entry-nodes',(req,res)=>{const wf=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!wf){res.status(404).json(apiError('not_found', 'not found'));return;}res.json({nodes:entryNodes(wf.id)});});
 app.get('/api/human/:id',(req,res)=>{const run=scopedDb(viewerFromRequest(req)).getWorkflowRun(req.params.id);if(!run){res.status(404).json(apiError('not_found', 'not found'));return;}res.json({run,nodes:dbApi.listWorkflowRunNodes(run.id).filter(n=>n.status==='waiting')});});
 app.post('/api/human/:id/answer',(req,res)=>{if(!scopedDb(viewerFromRequest(req)).getWorkflowRun(req.params.id)){res.status(404).json(apiError('not_found', 'not found'));return;}const b=req.body as {node_id?:unknown;answer?:unknown};if(typeof b.node_id!=='string'||typeof b.answer!=='string'||!answerWorkflowHuman(req.params.id,b.node_id,b.answer)){res.status(409).json({error:'human node is no longer waiting'});return;}res.json({ok:true});});
 app.put('/api/workflows/:id',(req,res)=>{try{const owned=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!owned){res.status(404).json(apiError('not_found', 'not found'));return;}const b=req.body as Record<string,unknown>;if(b.draft!==undefined)refuseAgentScripts(req,parseWorkflowDraft(b.draft).nodes,storedNodes(owned.draft));const workflow=dbApi.updateWorkflow(owned.id,{name:typeof b.name==='string'?b.name:undefined,description:typeof b.description==='string'?b.description:undefined,draft:b.draft===undefined?undefined:JSON.stringify(b.draft),enabled:typeof b.enabled==='boolean'?(b.enabled?1:0):undefined,agent_name:assignedAgent(b.agent_name,false)});if(!workflow){res.status(404).json(apiError('not_found', 'not found'));return;}if(workflow.enabled===0)disarmWorkflowTriggers(workflow.id);else if(typeof b.enabled==='boolean')armWorkflowTriggers(workflow.id);res.json({workflow});}catch(e){res.status(e instanceof ScriptAuthorRefused?403:400).json(describeWorkflowError(e));}});
 app.delete('/api/workflows/:id',(req,res)=>{const workflow=scopedDb(viewerFromRequest(req)).getWorkflow(req.params.id);if(!workflow){res.status(404).json(apiError('not_found', 'not found'));return;}const definitions=[parseStoredWorkflowDraft(JSON.parse(workflow.draft)),...Array.from({length:workflow.published_version??0},(_,index)=>dbApi.getWorkflowVersion(workflow.id,index+1)).filter((version):version is NonNullable<typeof version>=>!!version).map((version)=>parseStoredWorkflowDefinition(JSON.parse(version.definition)))];for(const run of dbApi.listWorkflowRuns(workflow.id))cancelRun(run.id);removeWorkflowCoordinator(workflow.id);removeInlineWorkflowAgents(workflow.slug,definitions);dropWorkflowTriggers(workflow.id);dbApi.deleteWorkflow(workflow.id);res.json({ok:true});});
}
