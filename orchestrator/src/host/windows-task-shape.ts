/**
 * What a registered Windows task does, read from its XML definition: the
 * logon it runs under, the program its action starts, its triggers, and
 * whether that combination opens a console window on the user's desktop.
 *
 * Timon writes two shapes only (`renderTaskXml`): S4U with a console program
 * (session 0, nobody sees it), or the interactive token with `Timon.exe`, a
 * GUI program. A task switched to the interactive token after registration
 * (Task Scheduler's "Run only when user is logged on") keeps its console
 * program, and Windows then opens a window at every start, which kills Timon
 * when closed (issue #116). Nothing told it apart until this was read.
 *
 * Source of truth for the desktop's copy, which must stay byte for byte equal
 * (independent packages, as for `agent-name.ts`): no import, no Node API, so
 * the same file compiles and is tested on both sides.
 */

/** `unknown`: absent, or a logon this reading does not judge (a group, a service account, `InteractiveTokenOrPassword`). */
export type WindowsTaskLogon = 'S4U' | 'InteractiveToken' | 'Password' | 'unknown';

export type WindowsTaskTrigger = 'Boot' | 'Logon' | 'Time';

export type WindowsTaskShape = {
  logon: WindowsTaskLogon;
  /** File name of the first action's program, lower case (`node.exe`); `null` when the task has no program action. */
  program: string | null;
  /** The start triggers Timon writes, in document order, each named once. */
  triggers: WindowsTaskTrigger[];
  /** Runs in the user's session and starts a console program: Windows shows its window. */
  consoleVisible: boolean;
};

/**
 * Console-subsystem programs a task of Timon has started or could start.
 * `Timon.exe` and `wscript.exe` are GUI programs: they open no window.
 */
export const WINDOWS_CONSOLE_PROGRAMS: readonly string[] = ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'node.exe', 'conhost.exe'];

const LOGONS: Readonly<Record<string, WindowsTaskLogon>> = { S4U: 'S4U', InteractiveToken: 'InteractiveToken', Password: 'Password' };

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The file name of a task command, lower case: quotes and blanks around it
 * dropped, `.exe` added to a bare name (`cmd` runs `cmd.exe`). Both separators,
 * since a command may be written either way.
 */
export function windowsProgramName(command: string | null | undefined): string | null {
  if (typeof command !== 'string') return null;
  const path = decodeXmlText(command).trim().replace(/^"+|"+$/g, '').trim();
  const name = path.split(/[\\/]/).pop()?.trim().toLowerCase() ?? '';
  if (!name) return null;
  return name.includes('.') ? name : `${name}.exe`;
}

/**
 * Reads the shape of a task definition, as `schtasks /Query /XML` or
 * `Export-ScheduledTask` print it. `null` when the text is not one: a missing
 * task, an error message, nothing at all. Never throws.
 */
export function windowsTaskShape(xml: string | null | undefined): WindowsTaskShape | null {
  if (typeof xml !== 'string' || !/<(Task|LogonType|Exec|Command)\b/.test(xml)) return null;
  const logonText = /<LogonType>\s*([A-Za-z0-9]+)\s*<\/LogonType>/.exec(xml)?.[1];
  const logon: WindowsTaskLogon = (logonText !== undefined ? LOGONS[logonText] : undefined) ?? 'unknown';
  const command = /<Exec\b[^>]*>[\s\S]*?<Command>([\s\S]*?)<\/Command>/.exec(xml)?.[1]
    ?? /<Command>([\s\S]*?)<\/Command>/.exec(xml)?.[1];
  const program = windowsProgramName(command);
  const triggers: WindowsTaskTrigger[] = [];
  for (const match of xml.matchAll(/<(Boot|Logon|Time)Trigger\b/g)) {
    const kind = match[1] as WindowsTaskTrigger;
    if (!triggers.includes(kind)) triggers.push(kind);
  }
  const consoleVisible = logon === 'InteractiveToken' && program !== null && WINDOWS_CONSOLE_PROGRAMS.includes(program);
  return { logon, program, triggers, consoleVisible };
}
