#!/usr/bin/env node
/** Computer-use MCP: drives the user's screen, mouse and keyboard through the daemon.
 * Identity comes from the mission token only; the daemon checks that the agent has
 * computer use turned on. Never reads the daemon token and never drives the machine itself. */
import readline from 'node:readline';

const origin = process.env.TIMON_ORCH_URL || 'http://127.0.0.1:3000';
const token = process.env.TIMON_API_TOKEN;
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const num = { type: 'number' };
const SEE_FIRST = ' Coordinates are in the pixels of the latest screenshot.';
// Every tool call is a model turn that re-reads the whole conversation: fewer calls and fewer images cost fewer tokens.
const THRIFT = ' To save tokens, chain the steps you can predict in one computer_actions call, and look at the screen only when the next step depends on it.';
const NO_PASSWORD = ' Never type a password, a one-time code or a payment detail: ask the user to do it.';
// The steps computer_actions accepts: the commands that act or wait, never one that reads.
const BATCH_ACTIONS = ['click', 'double_click', 'move', 'drag', 'type', 'key', 'scroll', 'wait', 'focus_window', 'a11y_action'];
const A11Y_ACTIONS = ['press', 'focus', 'set_value', 'select', 'expand', 'collapse', 'show_menu', 'scroll_into_view'];
// Acting by window id keeps the user's screen and focus theirs; an agent set to the background mode cannot do otherwise.
const NO_FOCUS = ' Prefer acting by windowId with computer_a11y_tree and computer_a11y_action without bringing the window to the front; use computer_focus_window only if needed. The user sets a mode per application. If a call is refused with computer_background_only, that application is allowed in the background only: use computer_list_windows, computer_a11y_tree and computer_a11y_action on its windows (no focus action, no keyboard fallback), never a screenshot, the mouse, the keyboard or computer_focus_window while it is in front. Games and canvas applications have an empty tree: they only work in the foreground, when the user allowed them so.';
// The order to work in: the tree first, pixels only for what the tree does not show.
const A11Y_FIRST = ' Read the window first with computer_a11y_tree and act by element. Take a screenshot and click in pixels only if the element is missing from the tree.' + NO_FOCUS;
const MAX_STEPS = 20;
const tools = [
  { name: 'computer_a11y_tree', description: `Read a window as a tree of elements (buttons, fields, menus...), with no screenshot. One line per element, indented by depth: #id role "name" = value [actions] @x,y. The id is what follows the first "#". Without windowId it reads the window in front. Use query to find an element by part of its name, value or role (case does not matter): the answer keeps the matches and the elements that contain them, and only those count against maxNodes, so a query is the way to search a large window. Roles: button, textfield, textarea, checkbox, radio, combobox, list, listitem, menu, menuitem, menubar, tab, tablist, link, image, text, group, window, toolbar, table, row, cell, slider, scrollbar, other. Ids last as long as the interface does not change: an a11y_element_stale error means read the tree again. Set withBounds only if you need the positions (in screenshot pixels).${A11Y_FIRST}`, inputSchema: schema({
    windowId: { type: 'string', minLength: 1, maxLength: 64 }, query: { type: 'string', maxLength: 200 },
    maxDepth: { type: 'integer', minimum: 1, maximum: 15 }, maxNodes: { type: 'integer', minimum: 1, maximum: 1500 }, withBounds: { type: 'boolean' },
  }) },
  { name: 'computer_a11y_action', description: `Act on one element by the id computer_a11y_tree returned, without moving the mouse or the keyboard. action: ${A11Y_ACTIONS.join(', ')}. press clicks a button or link, set_value writes the value into a field (at most 2000 characters, never log a password: ask the user to do it), select picks a list item or tab, expand and collapse open or close a group, show_menu opens the context menu, scroll_into_view brings the element into sight. An element only accepts the actions in its [brackets]; otherwise the error lists the possible ones.${A11Y_FIRST}${NO_PASSWORD}`, inputSchema: schema({
    id: { type: 'string', minLength: 1, maxLength: 120 }, action: { type: 'string', enum: A11Y_ACTIONS }, value: { type: 'string', maxLength: 2000 },
  }, ['id', 'action']) },
  { name: 'computer_screenshot', description: `Capture the main screen as a JPEG, 1024 px wide by default. Ask for a larger maxWidth only to read small text, a smaller one (768) for a quick look.${THRIFT}`, inputSchema: schema({ maxWidth: { type: 'integer', minimum: 64, maximum: 4096 } }) },
  { name: 'computer_actions', description: `Run several steps in a row, then return one screenshot (unless screenshot is false). Each step is an object with an "action" (click, double_click, move, drag, type, key, scroll, wait, focus_window, a11y_action) and that action's arguments (an a11y_action step names the element action as \"do\": {\"action\":\"a11y_action\",\"id\":\"...\",\"do\":\"press\"}), for example [{"action":"key","keys":"cmd+space"},{"action":"type","text":"TextEdit"},{"action":"key","keys":"Enter"},{"action":"wait","ms":1500}]. Stops at the first failing step and says which.${A11Y_FIRST}${SEE_FIRST}${NO_PASSWORD}`, inputSchema: schema({
    steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { action: { type: 'string', enum: [...BATCH_ACTIONS] } }, required: ['action'] } },
    screenshot: { type: 'boolean' }, maxWidth: { type: 'integer', minimum: 64, maximum: 4096 },
  }, ['steps']) },
  { name: 'computer_click', description: `Click at a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, ['x', 'y']) },
  { name: 'computer_double_click', description: `Double-click at a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num }, ['x', 'y']) },
  { name: 'computer_move', description: `Move the mouse pointer to a point of the screen.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num }, ['x', 'y']) },
  { name: 'computer_drag', description: `Press at one point, drag, and release at another.${SEE_FIRST}`, inputSchema: schema({ fromX: num, fromY: num, toX: num, toY: num }, ['fromX', 'fromY', 'toX', 'toY']) },
  { name: 'computer_type', description: `Type text with the keyboard into the focused field (at most 2000 characters). Click the field first.${NO_PASSWORD}`, inputSchema: schema({ text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']) },
  { name: 'computer_key', description: `Press a key or a shortcut, such as "Enter", "cmd+c" or "ctrl+shift+t".${NO_PASSWORD}`, inputSchema: schema({ keys: { type: 'string', minLength: 1, maxLength: 100 } }, ['keys']) },
  { name: 'computer_scroll', description: `Scroll the wheel at a point of the screen; a positive deltaY scrolls down.${SEE_FIRST}`, inputSchema: schema({ x: num, y: num, deltaX: num, deltaY: num }, ['x', 'y', 'deltaY']) },
  { name: 'computer_list_windows', description: 'List the open windows as [{ id, title, app, focused }]. Use it to find a window id for computer_a11y_tree, or the window to bring to the front with computer_focus_window. The user allows only some applications, each in the foreground or the background mode: screenshots, the mouse and the keyboard are refused unless the application in front is allowed in the foreground mode (computer_app_not_allowed if it is not listed, computer_background_only if it is background-only); computer_a11y_tree and computer_a11y_action work for any allowed application.', inputSchema: schema() },
  { name: 'computer_focus_window', description: 'Bring a window to the front, by the id computer_list_windows returned. Refused when its application is not allowed in the foreground mode (computer_background_only if it is allowed in the background only). Take a screenshot afterwards: the windows may have moved. It takes the focus from the user: prefer computer_a11y_tree with a windowId.', inputSchema: schema({ id: { type: 'string', minLength: 1, maxLength: 64 } }, ['id']) },
  { name: 'computer_cursor_position', description: 'Read the current position of the mouse pointer, in screenshot coordinates.', inputSchema: schema() },
  { name: 'computer_wait', description: `Wait for the screen to settle, at most 10 seconds.${THRIFT}`, inputSchema: schema({ ms: { type: 'integer', minimum: 0, maximum: 10000 } }, ['ms']) },
];
// Tool name -> daemon command: the daemon is the one place that validates the arguments.
const COMMANDS = {
  computer_screenshot: 'screenshot', computer_click: 'click', computer_double_click: 'double_click', computer_move: 'move',
  computer_drag: 'drag', computer_type: 'type', computer_key: 'key', computer_scroll: 'scroll',
  computer_cursor_position: 'cursor_position', computer_list_windows: 'list_windows', computer_focus_window: 'focus_window', computer_wait: 'wait',
  computer_a11y_tree: 'a11y_tree', computer_a11y_action: 'a11y_action',
};
async function command(name, args) {
  if (!token) throw new Error('A mission token is required to control the computer.');
  const response = await fetch(`${origin}/api/computer/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(args), signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const failure = new Error(body.error?.message || body.message || (typeof body.error === 'string' ? body.error : '') || `Computer request failed (${response.status}).`);
    failure.code = body.error?.code ?? body.code;
    throw failure;
  }
  return body.result;
}
/** Runs the steps one after the other through the daemon, which validates each of them as a single call would be. */
async function runActions(args) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (steps.length === 0 || steps.length > MAX_STEPS) throw new Error(`"steps" must hold 1 to ${MAX_STEPS} steps.`);
  let done = 0;
  for (const step of steps) {
    const { action, ...rest } = step && typeof step === 'object' ? step : {};
    if (!BATCH_ACTIONS.includes(action)) throw new Error(`Step ${done + 1}: unknown action ${JSON.stringify(action)}; ${done} step(s) done before it.`);
    try { await command(action, action === 'a11y_action' ? a11yStep(rest) : rest); } catch (error) {
      throw new Error(`Step ${done + 1} (${action}) failed: ${error.message}; ${done} step(s) done before it.`);
    }
    done += 1;
  }
  if (args.screenshot === false) return { steps: done };
  let shot;
  try { shot = await command('screenshot', args.maxWidth === undefined ? {} : { maxWidth: args.maxWidth }); } catch (error) {
    // A background agent never gets a capture of the user's screen: the steps are done, so say so.
    if (error.code === 'computer_background_only') return { steps: done, note: error.message };
    throw error;
  }
  return { ...shot, steps: done };
}
/** The tree as indented text: far fewer tokens than the JSON, and the ids stay readable. */
function renderTree(tree, withBounds) {
  const quote = text => JSON.stringify(String(text));
  // A reading cut at the desktop's deadline: more nodes would not help, a narrower request would.
  const cut = tree.timedOut ? ' - truncated: reading took too long, use query, the windowId of a smaller window or a lower maxDepth'
    : tree.truncated ? ' - truncated: raise maxNodes or maxDepth, or use query' : '';
  const lines = [`window #${tree.window.id} ${quote(tree.window.title)} (${tree.window.app})${cut}`];
  for (const node of Array.isArray(tree.nodes) ? tree.nodes : []) {
    let line = `${'  '.repeat(node.depth)}#${node.id} ${node.role}`;
    if (node.name) line += ` ${quote(node.name)}`;
    if (node.value !== undefined) line += ` = ${quote(node.value)}`;
    if (node.enabled === false) line += ' (disabled)';
    if (node.focused) line += ' (focused)';
    if (Array.isArray(node.actions) && node.actions.length) line += ` [${node.actions.join(',')}]`;
    if (withBounds && node.bounds) line += ` @${node.bounds.x},${node.bounds.y}`;
    lines.push(line);
  }
  return lines.join('\n');
}
/** An element id may be pasted with the "#" it is shown with. */
const bareId = id => typeof id === 'string' && id.startsWith('#') ? id.slice(1) : id;
/** In a step, "action" names the step, so the element action travels as "do": {"action":"a11y_action","id":"...","do":"press"}. */
function a11yStep({ id, do: what, value }) {
  return { id: bareId(id), action: what, ...(value === undefined ? {} : { value }) };
}
async function run(name, args) {
  if (name === 'computer_actions') return runActions(args);
  if (name === 'computer_a11y_tree') {
    const { withBounds, ...rest } = args;
    return { text: renderTree(await command('a11y_tree', rest), withBounds === true) };
  }
  if (name === 'computer_a11y_action') return command('a11y_action', { ...args, id: bareId(args.id) });
  const mapped = COMMANDS[name];
  if (!mapped) throw new Error(`Unknown tool: ${name}`);
  return command(mapped, args);
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  try {
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'timon-computer', version: '1.0.0' } };
    else if (msg.method === 'ping') result = {};
    else if (msg.method === 'tools/list') result = { tools };
    else if (msg.method === 'tools/call') {
      const value = await run(msg.params?.name, msg.params?.arguments ?? {});
      result = { content: typeof value?.text === 'string' && Object.keys(value).length === 1 ? [{ type: 'text', text: value.text }]
        : typeof value?.data === 'string'
        ? [{ type: 'image', data: value.data, mimeType: value.mimeType || 'image/jpeg' },
          { type: 'text', text: JSON.stringify({ width: value.width, height: value.height, ...(value.steps === undefined ? {} : { steps: value.steps }) }) }]
        : [{ type: 'text', text: JSON.stringify(value) }] };
    } else return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
});
