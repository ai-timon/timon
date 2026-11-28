/**
 * The frameless main window, in a real Electron on Windows: the top bar of a
 * page laid in a WebContentsView moves the window, its controls stay
 * clickable, the edges still resize, and a page kept alive under the one on
 * screen (another machine's), which the page leaves without `data-timon-drag`,
 * adds no drag area. Electron 33 does apply a HIDDEN view's drag areas: that
 * is why the shell tells each page whether it is the one on screen. The drag rules are the app's
 * own stylesheet block, read from `app/src/styles/globals.css`; the page around
 * them is a fixture. Windows only: the hit test asks the window what it would
 * do under the pointer (WM_NCHITTEST), without moving the person's mouse.
 *
 * With `TIMON_SMOKE_CAPTURE=<file.png>`, the window is also captured there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

/** Win32 hit-test answers. */
const HT = { client: '1', caption: '2', right: '11' } as const;

async function frameRules(): Promise<string> {
  const css = await readFile(new URL('../../app/src/styles/globals.css', import.meta.url), 'utf8');
  const start = css.indexOf('/* The desktop window without the system\'s title bar');
  assert.ok(start >= 0, 'the frame block of globals.css');
  return css.slice(start);
}

function page(rules: string, active: boolean): string {
  const attributes = active ? ' data-timon-frame="drawn" data-timon-drag' : ' data-timon-frame="drawn"';
  // The fixture's own look: the theme's chrome colours are not built here.
  const look = `body{margin:0;font:13px system-ui;background:#16181d;color:#e6e6e6}
.timon-topbar-bar{display:flex;align-items:center;gap:12px;height:48px;padding:0 calc(16px + var(--timon-window-controls-w)) 0 16px;background:#0f1115}
.widget-frame{padding:4px 10px;border-radius:8px;background:#22252c}.grow{flex:1}
button{background:none;border:0;color:inherit;border-radius:6px;height:36px;min-width:40px}
.timon-window-controls{position:fixed;right:0;top:0;height:48px;display:flex;align-items:center;gap:2px;padding-right:6px}`;
  return `<!doctype html><html${attributes}><style>${rules}\n${look}</style><body>
<div aria-hidden="true" class="timon-window-strip"></div>
<header class="timon-topbar-bar"><strong>Timon</strong><span>Office VPS</span><div class="grow"></div><div class="widget-frame">Working agents</div><button id="page-control">Settings</button></header>
<main style="padding:24px">Page content</main>
<div role="group" class="timon-window-controls"><button aria-label="Minimize">&#8212;</button><button aria-label="Maximize">&#9633;</button><button aria-label="Close">&#10005;</button></div>
</body></html>`;
}

test('the top bar of a page moves the frameless window, its controls and edges keep working, and a page put away drags nothing', {
  skip: process.env.TIMON_ELECTRON_SMOKE !== '1' || process.platform !== 'win32', timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'timon-frame-smoke-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  const rules = await frameRules();
  try {
    await writeFile(join(home, 'on-screen.html'), page(rules, true));
    await writeFile(join(home, 'put-away.html'), page(rules, false));
    await writeFile(join(home, 'smoke.cjs'), `
const {app,BrowserWindow,WebContentsView,screen}=require('electron');const {execFile}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const fail=(e)=>{fs.writeSync(2,(e&&e.stack||String(e))+'\\n');app.exit(1)};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
app.on('window-all-closed',()=>{});app.setPath('userData',path.join(process.env.TIMON_HOME,'shell'));
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
// portability: Windows-only hit test, the test is skipped elsewhere
const hit=(hwnd,x,y)=>new Promise((res,rej)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern System.IntPtr SendMessage(System.IntPtr h,uint m,System.IntPtr w,System.IntPtr l);';"
  +"[N.W]::SendMessage([System.IntPtr]"+hwnd+",0x84,[System.IntPtr]0,[System.IntPtr]((("+y+" -band 0xffff) -shl 16) -bor ("+x+" -band 0xffff)))"],
  {timeout:20000},(e,o)=>e?rej(e):res(String(o).trim())));
(async()=>{
await app.whenReady();
const w=new BrowserWindow({x:120,y:120,width:900,height:480,frame:false,backgroundColor:'#16181d',webPreferences:{sandbox:true}});
const {width,height}=w.getContentBounds();
const view=async(file)=>{const v=new WebContentsView({webPreferences:{sandbox:true}});w.contentView.addChildView(v);v.setBounds({x:0,y:0,width,height});await v.webContents.loadFile(path.join(process.env.TIMON_HOME,file));return v};
// The shell's order: the page put away is built first and hidden, the one on screen above it.
const away=await view('put-away.html');away.setVisible(false);
const shown=await view('on-screen.html');
await wait(800);
const buf=w.getNativeWindowHandle();const hwnd=buf.length===8?buf.readBigUInt64LE(0):buf.readUInt32LE(0);
const cb=w.getContentBounds();const sf=screen.getDisplayMatching(cb).scaleFactor;
const at=async(dx,dy)=>hit(hwnd,Math.round((cb.x+dx)*sf),Math.round((cb.y+dy)*sf));
const rect=(sel)=>shown.webContents.executeJavaScript('(()=>{const r=document.querySelector('+JSON.stringify(sel)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
const probe={};
probe.bar=await at(300,24);
for(const [k,sel] of [['pageControl','#page-control'],['widget','.widget-frame'],['minimize','[aria-label=Minimize]'],['close','[aria-label=Close]']]){const p=await rect(sel);probe[k]=await at(p.x,p.y)}
probe.content=await at(300,240);
probe.rightEdge=await at(cb.width-2,240);
if(process.env.TIMON_SMOKE_CAPTURE)fs.writeFileSync(process.env.TIMON_SMOKE_CAPTURE,(await shown.webContents.capturePage()).toPNG());
// A layer a portal lays over the bar, as a sheet or a popover does, with no control under the pointer.
await shown.webContents.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<div role=\\\\'dialog\\\\' style=\\\\'position:fixed;top:0;left:380px;width:200px;height:200px;background:#22252c\\\\'>Sheet</div>')");
await wait(500);
probe.layer=await at(480,24);
probe.barBesideLayer=await at(300,24);
console.log('FRAME_SMOKE '+JSON.stringify(probe));
app.exit(0);
})().catch(fail);
`);
    // An empty ELECTRON_RUN_AS_NODE still counts as set on Windows: drop the key so Electron starts as an app.
    const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: home };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(electron, [join(home, 'smoke.cjs')], {
      env, timeout: 80_000, maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => { throw new Error(`frame smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = /FRAME_SMOKE (.*)/.exec(result.stdout)?.[1];
    assert.ok(line, result.stdout);
    const probe = JSON.parse(line) as Record<string, string>;
    assert.equal(probe.bar, HT.caption, 'the top bar moves the window');
    for (const control of ['pageControl', 'widget', 'minimize', 'close']) assert.equal(probe[control], HT.client, `${control} stays clickable`);
    assert.equal(probe.content, HT.client, 'the page content is no drag area, and the page put away under it adds none');
    assert.equal(probe.rightEdge, HT.right, 'the edges still resize the window');
    assert.equal(probe.layer, HT.client, 'a layer laid over the bar takes the click instead of moving the window');
    assert.equal(probe.barBesideLayer, HT.caption, 'the bar around it still moves the window');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
