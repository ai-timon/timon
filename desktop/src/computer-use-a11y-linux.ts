/**
 * Accessibility backend for linux, over AT-SPI. One FIXED python3 script (PyGObject, `Atspi`) is
 * embedded as a string and started with `python3 -c`: no shell, and everything the agent controls
 * (window, path, action, value) travels as one JSON argument in argv, never inside the script, so
 * nothing it sends can be interpreted as code.
 *
 * The window id is the X11 id (decimal) from list_windows. AT-SPI does not know X ids, so the
 * window is found through what xdotool says about it: its process and its title. Its geometry
 * (xdotool) and client-side shadow (xprop) place the elements of toolkits that only know positions
 * inside their window, as GTK4 does.
 */
import { A11yError, type A11yActArgs, type A11yBackend, type A11yCheck, type A11yRawTree, type A11yTreeArgs } from './computer-use-a11y.js';
import type { SystemCommand } from './computer-use-input.js';
import type { Exec } from './computer-use-windows.js';

/** What to install when the probe says `missing`, for the three usual package managers. */
export const LINUX_A11Y_HINT =
  'Install the AT-SPI bindings: apt install python3-gi gir1.2-atspi-2.0 at-spi2-core (Debian, Ubuntu), '
  + 'dnf install python3-gobject at-spi2-core (Fedora), pacman -S python-gobject at-spi2-core (Arch). '
  + 'The session also needs the accessibility bus (at-spi-bus-launcher).';

/** Fixed text: read it, never build it from input. */
const SCRIPT = String.raw`
import sys, json, time
from collections import deque
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

ROLES = {
  'push button': 'button', 'button': 'button', 'toggle button': 'button', 'entry': 'textfield', 'password text': 'textfield',
  'text': 'text', 'label': 'text', 'static': 'text', 'paragraph': 'text', 'heading': 'text',
  'check box': 'checkbox', 'check menu item': 'checkbox', 'radio button': 'radio', 'radio menu item': 'radio',
  'combo box': 'combobox', 'list': 'list', 'list box': 'list', 'list item': 'listitem', 'menu': 'menu', 'popup menu': 'menu',
  'menu item': 'menuitem', 'menu bar': 'menubar', 'page tab': 'tab', 'page tab list': 'tablist', 'link': 'link',
  'image': 'image', 'icon': 'image', 'panel': 'group', 'section': 'group', 'filler': 'group', 'grouping': 'group',
  'frame': 'window', 'window': 'window', 'dialog': 'window', 'tool bar': 'toolbar', 'table': 'table', 'tree table': 'table',
  'table row': 'row', 'table cell': 'cell', 'slider': 'slider', 'scroll bar': 'scrollbar',
}
PRESS = ('click', 'press', 'activate', 'jump', 'toggle', 'check', 'uncheck', 'open')

def has(state_set, state):
    return state_set.contains(state)

def interfaces(acc):
    try:
        found = set(acc.get_interfaces())
    except Exception:
        found = set()
    # Chromium's cached interface list can miss EditableText, while the interface itself answers:
    # ask for each one directly (the typed getters return None when it is not implemented).
    for name, getter in (('EditableText', 'get_editable_text_iface'), ('Text', 'get_text_iface'),
                         ('Action', 'get_action_iface'), ('Component', 'get_component_iface'),
                         ('Value', 'get_value_iface'), ('Selection', 'get_selection_iface')):
        if name in found:
            continue
        try:
            if getattr(acc, getter)() is not None:
                found.add(name)
        except Exception:
            pass
    return found

def action_names(acc):
    names = []
    try:
        for i in range(Atspi.Action.get_n_actions(acc)):
            names.append(Atspi.Action.get_action_name(acc, i).lower())
    except Exception:
        pass
    return names

def find_action(acc, words):
    for i, name in enumerate(action_names(acc)):
        if any(w in name for w in words):
            return i
    return None

def kind_of(acc, role, ifaces, states):
    kind = ROLES.get(role, 'other')
    if kind == 'textfield' and has(states, Atspi.StateType.MULTI_LINE):
        return 'textarea'
    if role == 'text' and 'EditableText' in ifaces:
        return 'textarea' if has(states, Atspi.StateType.MULTI_LINE) else 'textfield'
    return kind

def possible(acc, kind, ifaces, states, parent_ifaces):
    out = []
    names = action_names(acc)
    if find_action(acc, PRESS) is not None:
        out.append('press')
    if 'Component' in ifaces and has(states, Atspi.StateType.FOCUSABLE):
        out.append('focus')
    if 'EditableText' in ifaces or (has(states, Atspi.StateType.EDITABLE) and kind in ('textfield', 'textarea')):
        out.append('set_value')
    if 'Selection' in parent_ifaces or has(states, Atspi.StateType.SELECTABLE):
        out.append('select')
    if has(states, Atspi.StateType.EXPANDABLE) or find_action(acc, ('expand', 'contract', 'collapse')) is not None:
        out.extend(['expand', 'collapse'])
    if find_action(acc, ('menu',)) is not None:
        out.append('show_menu')
    if 'Component' in ifaces:
        out.append('scroll_into_view')
    return out

def describe(acc, path, parent_ifaces):
    states = acc.get_state_set()
    ifaces = interfaces(acc)
    role = acc.get_role_name().lower()
    kind = kind_of(acc, role, ifaces, states)
    node = {'path': path, 'role': kind, 'name': acc.get_name() or '',
            'enabled': has(states, Atspi.StateType.ENABLED) or has(states, Atspi.StateType.SENSITIVE),
            'actions': possible(acc, kind, ifaces, states, parent_ifaces)}
    value = None
    try:
        if kind in ('textfield', 'textarea') and 'Text' in ifaces:
            value = Atspi.Text.get_text(acc, 0, 2000)
        elif kind == 'slider' and 'Value' in ifaces:
            value = str(Atspi.Value.get_current_value(acc))
        elif kind in ('checkbox', 'radio'):
            value = 'true' if has(states, Atspi.StateType.CHECKED) else 'false'
    except Exception:
        value = None
    if value:
        node['value'] = value
    if has(states, Atspi.StateType.FOCUSED):
        node['focused'] = True
    if 'Component' in ifaces:
        bounds = extents(acc)
        if bounds is not None:
            node['bounds'] = bounds
    return node, ifaces

# Where the window being read sits on the screen, from xdotool and the CSD shadow (set by main).
PLACE = {'window': None, 'frame': None, 'root': None, 'origin': False}

def window_origin():
    """Screen position of the window's content: the X11 window's corner plus the left and top of its
    client-side shadow (_GTK_FRAME_EXTENTS). Without the shadow read, it is assumed even on both
    sides, from the size the toolkit gives its root. None when the window's place is unknown."""
    if PLACE['origin'] is not False:
        return PLACE['origin']
    origin = None
    geo = PLACE['window']
    if geo is not None:
        frame = PLACE['frame']
        if frame is not None:
            origin = (geo['x'] + frame[0], geo['y'] + frame[2])
        else:
            dx, dy = 0, 0
            try:
                r = Atspi.Component.get_extents(PLACE['root'], Atspi.CoordType.WINDOW)
                if 0 < r.width <= geo['width'] and 0 < r.height <= geo['height']:
                    dx, dy = (geo['width'] - r.width) // 2, (geo['height'] - r.height) // 2
            except Exception:
                pass
            origin = (geo['x'] + dx, geo['y'] + dy)
    PLACE['origin'] = origin
    return origin

def extents(acc):
    """Screen extents. GTK4 answers 0,0 for every element in SCREEN coordinates (it cannot know
    where its window is): then the WINDOW extents plus the window's origin, and no position at all
    when that origin is unknown, rather than a false 0,0."""
    try:
        r = Atspi.Component.get_extents(acc, Atspi.CoordType.SCREEN)
    except Exception:
        return None
    if r.width <= 0 or r.height <= 0:
        return None
    if r.x != 0 or r.y != 0:
        return {'x': r.x, 'y': r.y, 'width': r.width, 'height': r.height}
    origin = window_origin()
    if origin is None:
        return None
    try:
        w = Atspi.Component.get_extents(acc, Atspi.CoordType.WINDOW)
    except Exception:
        return None
    return {'x': origin[0] + w.x, 'y': origin[1] + w.y, 'width': r.width, 'height': r.height}

def children_of(acc):
    out = []
    try:
        for i in range(acc.get_child_count()):
            child = acc.get_child_at_index(i)
            if child is not None:
                out.append(child)
    except Exception:
        pass
    return out

def app_pid(app):
    try:
        return app.get_process_id()
    except Exception:
        return None

def find_window(req, seen):
    """Electron's AT-SPI application may carry another pid or name than the X11 window, so the title
    is tried first, then the pid, then a looser title; what was seen is returned for diagnostics."""
    pid = req.get('pid')
    title = req.get('title') or ''
    frames = []
    for app in children_of(Atspi.get_desktop(0)):
        names = []
        for win in children_of(app):
            frames.append((app, win))
            names.append(win.get_name() or '')
        seen.append({'app': app.get_name() or '', 'pid': app_pid(app), 'frames': names[:8]})
    exact = [f for f in frames if title and (f[1].get_name() or '') == title]
    if exact:
        for app, win in exact:
            if pid is not None and app_pid(app) == pid:
                return win
        return exact[0][1]
    if pid is not None:
        mine = [f for f in frames if app_pid(f[0]) == pid]
        for app, win in mine:
            if title and title.lower() in (win.get_name() or '').lower():
                return win
        for app, win in mine:
            if has(win.get_state_set(), Atspi.StateType.SHOWING):
                return win
        if mine:
            return mine[0][1]
    if len(title) >= 3:
        low = title.lower()
        for app, win in frames:
            name = (win.get_name() or '').lower()
            if name and (low in name or name in low):
                return win
    return None

def at_path(win, path):
    acc = win
    for part in path.split('.')[1:]:
        index = int(part)
        if index >= acc.get_child_count():
            return None
        acc = acc.get_child_at_index(index)
        if acc is None:
            return None
    return acc

# What a name or a value keeps: the tree caps text at 200 characters, one more marks the cut.
CLIP = 201
# Roles whose kind or value is only known after reading the element fully: a query checks them in full.
RICH_ROLES = ('entry', 'password text', 'text', 'slider', 'check box', 'check menu item', 'radio button', 'radio menu item')

def clip(text):
    return text[:CLIP] if text else text

def shown(acc):
    """Hidden pages (the other tabs of a notebook) can hold thousands of elements: never enter them."""
    try:
        states = acc.get_state_set()
        return has(states, Atspi.StateType.SHOWING) and has(states, Atspi.StateType.VISIBLE)
    except Exception:
        return False

def matches(node, query):
    return any(query in (text or '').lower() for text in (node.get('name'), node.get('value'), node.get('role')))

class Entry:
    __slots__ = ('acc', 'path', 'depth', 'parent', 'node', 'ifaces', 'kept')
    def __init__(self, acc, path, depth, parent):
        self.acc, self.path, self.depth, self.parent = acc, path, depth, parent
        self.node = None
        self.ifaces = None
        self.kept = False

def ifaces_of(entry):
    if entry is None:
        return set()
    if entry.ifaces is None:
        entry.ifaces = interfaces(entry.acc)
    return entry.ifaces

def read(entry):
    if entry.node is not None:
        return entry.node
    try:
        node, entry.ifaces = describe(entry.acc, entry.path, ifaces_of(entry.parent))
    except Exception:
        # The element vanished while it was read: it keeps its place, with nothing to act on.
        node = {'path': entry.path, 'role': 'other', 'name': '', 'enabled': False, 'actions': []}
    node['name'] = clip(node['name'])
    if 'value' in node:
        node['value'] = clip(node['value'])
    entry.node = node
    return node

def hit(entry, query):
    """Name and role are cheap to read; only the roles that may carry a value are read in full."""
    try:
        role = entry.acc.get_role_name().lower()
        name = clip(entry.acc.get_name() or '')
    except Exception:
        return False
    if role in RICH_ROLES:
        return matches(read(entry), query)
    return matches({'name': name, 'role': ROLES.get(role, 'other')}, query)

def walk(win, max_depth, max_nodes, query=None, deadline_ms=10000, max_visits=10000):
    """Breadth first, so the toolbars and the visible controls come before the deep content. Without a
    query, max_nodes counts every element read; with one, only the matches and their ancestors, while
    max_visits and the deadline bound the search. Reaching the deadline answers what was found so far."""
    deadline = time.monotonic() + deadline_ms / 1000.0
    kept = []
    truncated = False
    timed_out = False
    visits = 0
    queue = deque([Entry(win, '0', 0, None)])
    while queue:
        if time.monotonic() >= deadline:
            truncated = timed_out = True
            break
        if visits >= max_visits or (not query and len(kept) >= max_nodes):
            truncated = True
            break
        entry = queue.popleft()
        visits += 1
        if not query:
            read(entry)
            kept.append(entry.node)
        elif hit(entry, query):
            # The match and those of its ancestors not kept yet: a hit is read in its place.
            chain = []
            up = entry
            while up is not None and not up.kept:
                chain.append(up)
                up = up.parent
            if len(kept) + len(chain) > max_nodes:
                truncated = True
                break
            for item in reversed(chain):
                kept.append(read(item))
                item.kept = True
        try:
            count = entry.acc.get_child_count()
        except Exception:
            count = 0
        if count <= 0:
            continue
        if entry.depth + 1 >= max_depth:
            truncated = True
            continue
        for index in range(count):
            try:
                child = entry.acc.get_child_at_index(index)
            except Exception:
                child = None
            if child is not None and shown(child):
                queue.append(Entry(child, entry.path + '.' + str(index), entry.depth + 1, entry))
    # Parents before their children, siblings in order: the order the tree is read in.
    kept.sort(key=lambda node: [int(part) for part in node['path'].split('.')])
    out = {'truncated': truncated, 'nodes': kept}
    if timed_out:
        out['timedOut'] = True
    return out

def write_text(acc, text, background=False):
    """EditableText.set_text_contents first; when the toolkit refuses, focus the field and replace
    its text by deleting then inserting."""
    try:
        if Atspi.EditableText.set_text_contents(acc, text):
            return True
    except Exception:
        pass
    if background:
        # Moving the focus could raise the window over the user's work.
        return False
    try:
        Atspi.Component.grab_focus(acc)
        count = Atspi.Text.get_character_count(acc)
        if count > 0:
            Atspi.EditableText.delete_text(acc, 0, count)
        return bool(Atspi.EditableText.insert_text(acc, 0, text, len(text.encode('utf-8'))))
    except Exception:
        return False

def act(win, req):
    acc = at_path(win, req['path'])
    if acc is None:
        return {'error': 'stale'}
    action = req['action']
    parent = acc.get_parent()
    states = acc.get_state_set()
    ifaces = interfaces(acc)
    parent_ifaces = interfaces(parent) if parent is not None else set()
    # The same kind as the tree computed: with an empty one an editable text field never offered
    # set_value here although the tree had announced it (CI run 46005658583).
    kind = kind_of(acc, acc.get_role_name().lower(), ifaces, states)
    can = possible(acc, kind, ifaces, states, parent_ifaces)
    if action not in can:
        return {'error': 'unsupported', 'actions': can}
    ok = False
    if action == 'press':
        ok = Atspi.Action.do_action(acc, find_action(acc, PRESS))
    elif action == 'focus':
        ok = Atspi.Component.grab_focus(acc)
    elif action == 'set_value':
        ok = write_text(acc, req.get('value') or '', bool(req.get('background')))
    elif action == 'select':
        index = acc.get_index_in_parent()
        if 'Selection' in parent_ifaces:
            ok = Atspi.Selection.select_child(parent, index)
        else:
            i = find_action(acc, ('select', 'click', 'press'))
            ok = i is not None and Atspi.Action.do_action(acc, i)
    elif action == 'expand':
        i = find_action(acc, ('expand', 'open'))
        if i is None:
            i = find_action(acc, ('contract',))
        ok = i is not None and Atspi.Action.do_action(acc, i)
    elif action == 'collapse':
        i = find_action(acc, ('collapse', 'contract', 'close'))
        ok = i is not None and Atspi.Action.do_action(acc, i)
    elif action == 'show_menu':
        ok = Atspi.Action.do_action(acc, find_action(acc, ('menu',)))
    elif action == 'scroll_into_view':
        ok = Atspi.Component.scroll_to(acc, Atspi.ScrollType.ANYWHERE)
    return {'ok': True} if ok else {'error': 'failed'}

def main():
    req = json.loads(sys.argv[1])
    op = req['op']
    if op == 'probe':
        out = {'ok': Atspi.get_desktop(0).get_child_count() >= 0}
    else:
        seen = []
        win = find_window(req, seen)
        if win is None:
            out = {'error': 'stale', 'seen': seen}
        elif op == 'tree':
            PLACE.update(window=req.get('window'), frame=req.get('frame'), root=win)
            out = walk(win, req['maxDepth'], req['maxNodes'], (req.get('query') or '').lower() or None, req.get('deadlineMs') or 10000)
        else:
            out = act(win, req)
    sys.stdout.write(json.dumps(out, separators=(',', ':')))

main()
`;

const python = (request: Record<string, unknown>): SystemCommand => ({ file: 'python3', args: ['-c', SCRIPT, JSON.stringify(request)] });
const xdotool = (...args: string[]): SystemCommand => ({ file: 'xdotool', args });

/**
 * How long the reader walks a tree before answering what it found: well under the 20 s the executor
 * and the daemon give the whole command, which also lists the windows first.
 */
export const LINUX_A11Y_DEADLINE_MS = 10_000;

/** The executor killed the reader (its time ran out) or cut its output: the tree is too large to read whole. */
function tooLarge(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { killed, signal, code } = error as { killed?: unknown; signal?: unknown; code?: unknown };
  return killed === true || signal === 'SIGTERM' || code === 'ETIMEDOUT' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

/** The X11 geometry of a window, and its CSD shadow as _GTK_FRAME_EXTENTS orders it: left, right, top, bottom. */
type WindowPlace = { window?: { x: number; y: number; width: number; height: number }; frame?: number[] };

const ACTIONS = ['press', 'focus', 'set_value', 'select', 'expand', 'collapse', 'show_menu', 'scroll_into_view'] as const;

export function linuxA11yBackend(exec: Exec): A11yBackend {
  /** The window's process and title, which is how AT-SPI is asked for it. A missing one is left out. */
  async function windowRef(windowId: string): Promise<{ pid?: number; title?: string }> {
    if (!/^\d{1,12}$/.test(windowId)) throw new A11yError('stale', 'No such window.');
    const ref: { pid?: number; title?: string } = {};
    try { const pid = Number((await exec(xdotool('getwindowpid', windowId))).stdout.trim()); if (Number.isInteger(pid) && pid > 0) ref.pid = pid; } catch { /* the title may still find it */ }
    try { const title = (await exec(xdotool('getwindowname', windowId))).stdout.replace(/\n$/, ''); if (title) ref.title = title; } catch { /* same */ }
    if (ref.pid === undefined && ref.title === undefined) throw new A11yError('stale', 'No such window.');
    return ref;
  }

  /**
   * Where the window sits, for the toolkits that give element positions only relative to it (GTK4):
   * its X11 geometry, and the client-side shadow drawn inside it. Each part is left out when unread;
   * a frame of zeros means xprop answered and the window has no such shadow.
   */
  async function windowPlace(windowId: string): Promise<WindowPlace> {
    const place: WindowPlace = {};
    try {
      const shell = (await exec(xdotool('getwindowgeometry', '--shell', windowId))).stdout;
      const field = (name: string): number => Number(new RegExp(`^${name}=(-?\\d+)$`, 'm').exec(shell)?.[1] ?? Number.NaN);
      const geo = { x: field('X'), y: field('Y'), width: field('WIDTH'), height: field('HEIGHT') };
      if (Object.values(geo).every(Number.isInteger) && geo.width > 0 && geo.height > 0) place.window = geo;
    } catch { /* positions relative to the window are then left out */ }
    if (place.window === undefined) return place;
    try {
      const out = (await exec({ file: 'xprop', args: ['-id', windowId, '_GTK_FRAME_EXTENTS'] })).stdout;
      const sides = /=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/.exec(out);
      if (sides) place.frame = sides.slice(1, 5).map(Number);
      else if (/not found/.test(out)) place.frame = [0, 0, 0, 0];
    } catch { /* no xprop: the reader estimates the shadow */ }
    return place;
  }

  async function run(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    let stdout: string;
    try { stdout = (await exec(python(request))).stdout; }
    catch (error) {
      if (request.op === 'tree' && tooLarge(error)) throw new A11yError('too_large', 'The accessibility tree of this window is too large to read in time.');
      throw new A11yError('failed', 'Reading the accessibility tree failed. Is the accessibility bus running?');
    }
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* falls through */ }
    throw new A11yError('failed', 'The accessibility reader answered something unreadable.');
  }

  function refuse(out: Record<string, unknown>): void {
    if (out.error === 'stale') {
      // Diagnostic mode only: which AT-SPI applications and frames were there, to see why none matched.
      if (process.env.TIMON_COMPUTER_USE_DEBUG === '1' && out.seen !== undefined) console.error(`[computer-use] AT-SPI found no frame for the window; applications seen: ${JSON.stringify(out.seen ?? []).slice(0, 1500)}`);
      throw new A11yError('stale', 'That element or window no longer exists.');
    }
    if (out.error === 'unsupported') {
      const possible = Array.isArray(out.actions) ? out.actions.filter((a): a is typeof ACTIONS[number] => (ACTIONS as readonly unknown[]).includes(a)) : [];
      throw new A11yError('unsupported', 'That element cannot do this.', possible);
    }
    if (out.error !== undefined) throw new A11yError('failed', 'The accessibility action failed.');
  }

  return {
    async probe(): Promise<A11yCheck> {
      try { return (await run({ op: 'probe' })).ok === true ? 'ok' : 'missing'; } catch { return 'missing'; }
    },
    async tree(args: A11yTreeArgs): Promise<A11yRawTree> {
      const ref = await windowRef(args.windowId);
      const query = args.query?.trim().toLowerCase();
      const place = await windowPlace(args.windowId);
      const out = await run({ op: 'tree', ...ref, ...place, maxDepth: args.maxDepth, maxNodes: args.maxNodes, ...(query ? { query } : {}), deadlineMs: LINUX_A11Y_DEADLINE_MS });
      refuse(out);
      if (!Array.isArray(out.nodes)) throw new A11yError('failed', 'The accessibility reader answered something unreadable.');
      return { truncated: out.truncated === true || out.timedOut === true, nodes: out.nodes as A11yRawTree['nodes'], ...(out.timedOut === true ? { timedOut: true } : {}) };
    },
    async act(args: A11yActArgs): Promise<void> {
      const ref = await windowRef(args.windowId);
      refuse(await run({ op: 'act', ...ref, path: args.path, action: args.action, ...(args.value === undefined ? {} : { value: args.value }), ...(args.background ? { background: true } : {}) }));
    },
  };
}
