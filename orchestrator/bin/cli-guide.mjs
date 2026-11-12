/**
 * What `timon` says to someone who has just installed it: the overview printed
 * by `timon` alone, and the message of a command whose daemon does not answer.
 *
 * Pure functions over a state the CLI gathers: the tests feed them states
 * without a daemon, a service or a network.
 */

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

/** A `fetch` that never reached a daemon, as opposed to a daemon that answered an error. */
export function isDaemonUnreachable(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const code = error.cause?.code ?? error.code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
  return error.name === 'TypeError' && error.message === 'fetch failed';
}

/**
 * `local`: the address is this machine's own daemon. `serviceInstalled`:
 * `timon service install` (or the onboarding) left its marker in this home.
 */
export function unreachableLines({ api, local, serviceInstalled }) {
  const lines = [`timon: no Timon daemon answers at ${api}.`];
  if (!local) {
    lines.push('  Check the address, and that the machine is on and runs Timon.');
    return lines;
  }
  if (serviceInstalled) {
    lines.push('  Timon is installed as a background service. See why it does not answer:');
    lines.push('    timon service status');
    lines.push('    timon doctor');
  } else {
    lines.push('  Run Timon in the background (starts at boot, keeps running after you log out):');
    lines.push('    timon service install');
    lines.push('  Or open the Timon app on this machine.');
  }
  return lines;
}

/**
 * The state of `timon` alone.
 * - `version`: this CLI's Timon version, or null.
 * - `reachable`: the daemon answered `/api/health` as Timon.
 * - `needsSetup`: true before the first account, false after, null unknown.
 * - `appUrl`: the web interface of this machine, or null.
 * - `appLocalOnly`: that address only answers on this machine.
 * - `ssh`: { user, host } when the CLI runs in an SSH session, else null.
 */
export function overviewLines(state) {
  const {
    version = null, api, local = true, reachable, serviceInstalled = false, needsSetup = null,
    appUrl = null, appLocalOnly = true, ssh = null,
  } = state;
  const lines = [version ? `Timon ${version}` : 'Timon', ''];
  const row = (label, value) => lines.push(`  ${label.padEnd(15)}${value}`);

  if (!reachable) {
    row('Daemon', `not answering at ${api}`);
    if (local) row('Service', serviceInstalled ? 'installed' : 'not installed');
    lines.push('');
    if (!local) {
      lines.push('Check the address, and that the machine is on and runs Timon.');
    } else if (serviceInstalled) {
      lines.push('Next: see why the service does not answer');
      lines.push('  timon service status');
      lines.push('  timon doctor');
    } else {
      lines.push('Next: run Timon in the background (starts at boot, keeps running after you log out)');
      lines.push('  timon service install');
      lines.push('Or open the Timon app on this machine.');
    }
    lines.push('', 'All commands: timon help');
    return lines;
  }

  row('Daemon', `running at ${api}`);
  row('Account', needsSetup === true ? 'not created yet' : needsSetup === false ? 'created' : 'unknown');
  if (appUrl) row('Web interface', appLocalOnly ? `${appUrl} (this machine only)` : appUrl);

  const next = [];
  if (needsSetup === true) {
    next.push('Next: create your account', '  timon init');
    if (appUrl && !ssh) next.push(`Or open ${appUrl} in a browser.`);
  } else if (appUrl && ssh && appLocalOnly) {
    const port = new URL(appUrl).port || '80';
    next.push(
      'Open the web interface from your computer through an SSH tunnel:',
      `  ssh -N -L ${port}:127.0.0.1:${port} ${ssh.user}@${ssh.host}`,
      `  then http://127.0.0.1:${port}`,
    );
  } else if (appUrl) {
    next.push(`Open ${appUrl} in a browser.`);
  }
  if (next.length) lines.push('', ...next);
  lines.push('', 'All commands: timon help');
  return lines;
}

/** `http://host:port` of a listener, the loopback standing in for a wildcard. */
export function listenUrl(listen) {
  if (!listen || typeof listen.port !== 'number') return null;
  let host = typeof listen.host === 'string' && listen.host ? listen.host : '127.0.0.1';
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    return new URL(`http://${authority}:${listen.port}`).origin;
  } catch {
    return null;
  }
}

export function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host ?? '');
}

/**
 * The AI command-line tools of `GET /api/host/provider-clis` (`SetupBackend`
 * of `src/onboarding.ts`), told from the terminal: what is ready, what to
 * sign in, and what to install when nothing is there.
 */
export function aiToolLines(backends) {
  const list = Array.isArray(backends) ? backends : [];
  const found = list.filter((b) => b && typeof b.path === 'string' && b.path);
  const lines = ['AI tools (your agents work through them, under this account):'];
  const signIn = (b) => `${b.signInCommand}${b.signInThen ? `, then ${b.signInThen}` : ''}`;
  for (const b of found) {
    const label = String(b.label ?? b.name).padEnd(14);
    if (b.signedIn === true) lines.push(`  ${label}ready`);
    else if (b.signedIn === false) lines.push(`  ${label}not signed in: ${signIn(b)}`);
    else lines.push(`  ${label}found; to sign in: ${signIn(b)}`);
  }
  if (!found.length) {
    lines.push('  None found. Install one, then sign in to it:');
    for (const b of list.filter((entry) => entry?.seedsMainAgent)) {
      const how = b.installCommand ?? b.installDocs;
      if (how) lines.push(`  ${String(b.label ?? b.name).padEnd(14)}${how}`);
    }
  }
  return lines;
}
