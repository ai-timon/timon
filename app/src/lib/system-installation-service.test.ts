import assert from 'node:assert/strict';
import test from 'node:test';
import type { SystemInfo } from './system-info';

const info: SystemInfo = {
  version: '0.2.0',
  dataVersion: '0.2.0',
  dataVersionOrder: 0,
  os: { platform: 'win32', name: 'Windows 11', release: '10.0.26100', arch: 'x64' },
  runtime: { node: '22', electron: '38' },
  daemon: {
    mode: 'embedded', packaged: true, packagedRuntime: true, pid: 1,
    listen: { address: '127.0.0.1', port: 3001 },
    app: { servedByDaemon: true, host: '127.0.0.1', port: 3101 },
  },
  paths: { installDir: 'install', home: 'home', configFile: 'timon.config.json', log: { kind: 'console' } },
  // #116: revision and marker read current, yet the task was switched to a console by hand.
  service: {
    supervisor: 'windows', name: 'TimonOrchestrator', installed: true, running: true, reason: null,
    windows: { revision: '6', expected: '6', launcherMarked: true, opensConsole: true },
    stale: true, action: 'repair', actionHere: true, command: 'timon service install',
  },
  license: { edition: 'beta', plan: null, status: 'valid', channel: 'beta' },
  importCommands: [],
};

// #116: `timon service status` and doctor send this user to Settings › Installation; the repair must be there.
test('installation settings: a Windows task that opens a console says so and offers the repair', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=system/installation' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('navigator', dom.window.navigator);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async () => new Response(JSON.stringify(info), { status: 200 }));
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SystemInstallationSettings } = await import('../components/settings/system-installation-settings');
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => { root.render(React.createElement(SystemInstallationSettings)); });
    const text = document.body.textContent ?? '';
    assert.match(text, /A console window opens: repair the background task/);
    assert.doesNotMatch(text, /Installed, out of date/);
    const repair = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Repair the service');
    assert.ok(repair, 'the repair is offered where the CLI sends the user');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
