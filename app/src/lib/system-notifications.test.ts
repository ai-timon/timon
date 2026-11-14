import assert from 'node:assert/strict';
import test from 'node:test';
import en from '../locales/en/systemNotifications.json';
import zh from '../locales/zh-CN/systemNotifications.json';
import { getLocale, registerLocale, setLocale } from './i18n';
import { settingsPath } from './settings-path';
import { systemNotificationText, type PresentableNotification } from './system-notifications';

const notice: PresentableNotification = {
  title: 'English daemon diagnostic',
  body: '**Action needed:** daemon diagnostic',
  presentation: {
    kind: 'backend-binary', cmd: 'C:\\AI tools\\agent-cli.exe', backends: ['provider-id', 'custom-profile'],
    pinned: false, installCommand: 'npm install -g @vendor/agent-cli --prefix "D:\\AI tools"',
  },
};

for (const [locale, dictionary] of [['en-x-system-test', en], ['zh-CN-x-system-test', zh]] as const) {
  test(`${locale}: backend CLI warning localizes only its prose and preserves operational values`, () => {
    const previous = getLocale();
    registerLocale(locale, dictionary);
    setLocale(locale);
    try {
      const display = systemNotificationText(notice);
      assert.ok(display.title.includes(notice.presentation!.cmd));
      assert.ok(display.title.includes('provider-id, custom-profile'));
      assert.ok(display.body?.includes(notice.presentation!.installCommand!));
      assert.ok(display.body?.includes(`host.binaries.${notice.presentation!.cmd}`));
      assert.doesNotMatch(`${display.title}\n${display.body}`, /\*\*|systemNotifications\./);
      assert.ok(display.body?.includes(settingsPath('models', 'backends')));
      assert.ok(display.body?.includes(dictionary.systemNotifications.backendBinary.recheck));
      if (locale.startsWith('zh')) {
        assert.match(display.title, /未找到/);
        assert.match(display.body!, /需要处理/);
        assert.doesNotMatch(display.body!, /Action needed|Install command on this machine/);
      }
    } finally { setLocale(previous); }
  });
}

test('pinned repair uses the pinned variant and no missing install command is fabricated', () => {
  const previous = getLocale();
  registerLocale('zh-CN-x-system-test', zh);
  setLocale('zh-CN-x-system-test');
  try {
    const display = systemNotificationText({ ...notice, presentation: { ...notice.presentation!, pinned: true, installCommand: null } });
    assert.match(display.body!, /未指向可执行文件/);
    assert.doesNotMatch(display.body!, /安装命令|npm install|重新检查/);
  } finally { setLocale(previous); }
});

test('notifications without recognized metadata remain byte-for-byte unchanged', () => {
  for (const original of [
    { title: 'Backend my-cli', body: '**user content** `D:\\My Files`' },
    { title: 'My provider notes', body: null },
  ]) assert.deepEqual(systemNotificationText(original), original);
});
