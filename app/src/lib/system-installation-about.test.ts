import assert from 'node:assert/strict';
import test from 'node:test';
import type { SystemInfo } from './system-info';

const info: SystemInfo = {
  version: '0.2.0',
  dataVersion: '0.2.0',
  dataVersionOrder: 0,
  os: { platform: 'linux', name: 'Linux', release: '6', arch: 'x64' },
  runtime: { node: '22', electron: '38' },
  daemon: {
    mode: 'embedded', packaged: true, packagedRuntime: true, pid: 1,
    listen: { address: '127.0.0.1', port: 3001 },
    app: { servedByDaemon: true, host: '127.0.0.1', port: 3101 },
  },
  paths: { installDir: 'install', home: 'home', configFile: 'timon.config.json', log: { kind: 'console' } },
  service: { supervisor: null, name: null, installed: false, running: false, reason: null, windows: null, stale: false, action: null, actionHere: false, command: 'timon service install' },
  license: { edition: 'beta', plan: null, status: 'valid', channel: 'beta' },
  importCommands: [],
};

// TODO #582: Settings › System › Installation leads to "About Timon" and the speech-model licences.
test('installation settings: the About button exists only in a desktop that can open the window, and opens it', async () => {
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
  let root = createRoot(document.getElementById('root')!);
  const remount = async () => {
    await React.act(async () => root.unmount());
    root = createRoot(document.getElementById('root')!);
    await React.act(async () => { root.render(React.createElement(SystemInstallationSettings)); });
  };
  const aboutButton = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'About Timon and third-party licences');
  try {
    await remount();
    assert.ok(document.querySelector('section'), 'the pane rendered');
    assert.equal(aboutButton(), undefined, 'a browser has no desktop window to open');

    window.timonDesktop = { restartAfterSetup: async () => {}, appInfo: async () => ({ version: '0.2.0' }) };
    await remount();
    assert.equal(aboutButton(), undefined, 'an older desktop without the channel shows no dead button');

    let opened = 0;
    window.timonDesktop = { ...window.timonDesktop, openAbout: async () => { opened += 1; } };
    await remount();
    const button = aboutButton();
    assert.ok(button);
    await React.act(async () => button.click());
    assert.equal(opened, 1);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
