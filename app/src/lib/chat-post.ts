/**
 * The messages an agent posts in its chat through a tool call: the
 * `chat_post_message` tool, or the `message` field of `question` and
 * `kanban_plan` (`orchestrator/src/chat-post.ts`).
 *
 * The daemon writes that text as an ordinary `assistant` event, so the thread
 * draws it as the agent's prose with nothing to add here. What is left to the
 * client is the call's chip: its detail is the input as JSON, and the report
 * would show a second time there, cut at 200 characters, right above itself.
 */

const POST_TOOL = /^mcp__timon__chat_post_message$/;
/** The forms server, under its current and its former name. */
const FORM_TOOL = /^mcp__(?:timon_ask|timon_permission)__(?:question|kanban_plan|ask_user|ask_series_plan)$/;

/** The input a tool chip describes: without the text the thread already shows. */
export function chipInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const field = POST_TOOL.test(name) ? 'text' : FORM_TOOL.test(name) ? 'message' : null;
  if (!field || !(field in input)) return input;
  const rest = { ...input };
  delete rest[field];
  return rest;
}
