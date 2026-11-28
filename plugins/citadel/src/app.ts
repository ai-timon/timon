// Citadel: 3D view of the Timon agents, driven by the live state (GET /state). Fully unmountable.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { N8AOPass } from 'n8ao';
import { buildModel, structureKey, transitions, summarize } from './mapping.js';
import type { AgentStateName, JournalRow, Model, ModelAgent, ModelProject, ModelSpace, ProjectSummary, StateInput } from './mapping.js';
import { t as tr, locale } from './i18n.js';
import { loadTim3D, createTims } from './tim3d.js';
import { bindUniforms } from './uniforms.js';
import type { Tim } from './tim3d.js';

const POLL_MS = 5000;
const CSS = `
.atl{--bg:#d9d6d0;--glass:rgba(255,255,255,.74);--glass-2:rgba(255,255,255,.92);--ink:#1d1d1f;--ink-2:#6e6e73;--ink-3:#a1a1a6;--line:rgba(0,0,0,.08);--work:#30a46c;--wait:#e8930c;--err:#e5484d;--rest:#c7c7cc;
 position:absolute;inset:0;overflow:hidden;background:var(--bg);color:var(--ink);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none}
.atl *{box-sizing:border-box}
.atl .at-scene{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.atl button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;margin:0}
.atl .at-glass{background:var(--glass);border:1px solid var(--line);border-radius:14px;backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 30px rgba(0,0,0,.07)}
.atl .at-hud{position:absolute;z-index:5}
.atl .at-eyebrow{font-size:10.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.atl img.at-av{border-radius:50%;object-fit:cover;background:#fff;display:block}
.atl .at-mono{border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;letter-spacing:.02em}
.atl .at-brand{top:18px;left:20px;display:flex;align-items:baseline;gap:10px}
.atl .at-mark{font-size:15px;font-weight:700;letter-spacing:.22em}
.atl .at-sub{font-size:13px;color:var(--ink-2)}
.atl .at-live{font-size:12px;color:var(--ink-2);display:flex;align-items:center;gap:6px;margin-left:6px}
.atl .at-live i{width:6px;height:6px;border-radius:50%;background:#34c759;box-shadow:0 0 0 3px rgba(52,199,89,.18)}
.atl .at-live.off i{background:var(--err);box-shadow:0 0 0 3px rgba(229,72,77,.18)}
.atl .at-status{top:14px;left:50%;transform:translateX(-50%);display:flex;gap:2px;padding:4px}
.atl .at-status span{padding:5px 12px;border-radius:10px;font-size:12.5px;color:var(--ink-2);white-space:nowrap}
.atl .at-status b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums;margin-right:4px}
.atl .at-status .at-k b{color:var(--work)}.atl .at-status .at-w b{color:var(--wait)}.atl .at-status .at-e b{color:var(--err)}
.atl .at-controls{top:14px;right:18px;display:flex;gap:8px}
.atl .at-seg{display:flex;padding:3px;gap:2px}
.atl .at-seg button{padding:5px 12px;border-radius:9px;font-size:12.5px;color:var(--ink-2)}
.atl .at-seg button.at-on{background:var(--glass-2);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.12)}
.atl .at-seg button:hover{color:var(--ink)}
.atl .at-toast{top:64px;left:50%;transform:translate(-50%,-12px);opacity:0;pointer-events:none;transition:all .45s cubic-bezier(.2,.8,.2,1);display:flex;align-items:center;gap:12px;padding:7px 7px 7px 10px;max-width:calc(100% - 40px)}
.atl .at-toast.at-on{opacity:1;transform:translate(-50%,0);pointer-events:auto}
.atl .at-who{font-weight:600}.atl .at-what{color:var(--ink-2)}
.atl .at-btn{background:var(--ink);color:var(--bg);padding:6px 12px;border-radius:9px;font-weight:600;font-size:12.5px}
.atl .at-ring{border-radius:50%;box-shadow:0 0 0 2px var(--wait);animation:at-beat 1.6s infinite}
@keyframes at-beat{50%{box-shadow:0 0 0 5px rgba(232,147,12,.25)}}
.atl .at-districts{left:20px;top:74px;width:230px;padding:10px;max-height:calc(100% - 260px);overflow:auto}
.atl .at-dist{display:block;width:100%;text-align:left;padding:9px 10px;border-radius:10px}
.atl .at-dist:hover,.atl .at-dist.at-on{background:var(--glass-2)}
.atl .at-row{display:flex;justify-content:space-between;align-items:baseline}
.atl .at-name{font-weight:600}
.atl .at-n{font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.atl .at-icons{display:flex;margin-top:6px;flex-wrap:wrap;row-gap:2px}
.atl .at-icons>*{width:18px;height:18px;margin-right:-4px;border:1.5px solid var(--glass-2);font-size:8px}
.atl .at-icons .at-st-on{box-shadow:0 0 0 1.5px var(--work)}.atl .at-icons .at-st-w{box-shadow:0 0 0 1.5px var(--wait)}.atl .at-icons .at-st-e{box-shadow:0 0 0 1.5px var(--err)}
.atl .at-card{right:18px;top:66px;width:320px;max-width:calc(100% - 36px);max-height:calc(100% - 160px);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateX(12px);pointer-events:none;transition:all .4s cubic-bezier(.2,.8,.2,1)}
.atl .at-card.at-on{opacity:1;transform:none;pointer-events:auto}
.atl .at-head{padding:16px 18px 14px;border-bottom:1px solid var(--line);position:relative;display:flex;gap:12px;align-items:center}
.atl .at-head .at-t{font-size:19px;font-weight:700;letter-spacing:-.02em}
.atl .at-head .at-s{color:var(--ink-2);font-size:12.5px}
.atl .at-close{position:absolute;top:10px;right:10px;width:26px;height:26px;border-radius:50%;color:var(--ink-2)}
.atl .at-close:hover{background:var(--glass-2)}
.atl .at-list{overflow:auto;padding:6px}
.atl .at-ag{display:flex;gap:10px;align-items:center;padding:7px 10px;border-radius:10px;width:100%;text-align:left}
.atl .at-ag:hover,.atl .at-ag.at-on{background:var(--glass-2)}
.atl .at-pic{position:relative;flex:none}
.atl .at-ag .at-pic i{position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;border-radius:50%;border:2px solid var(--glass-2)}
.atl .at-nm{font-weight:500}.atl .at-tx{color:var(--ink-2);font-size:12px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atl .at-journal{left:20px;bottom:18px;width:400px;max-width:calc(100% - 40px);padding:12px 14px}
.atl .at-rows{margin-top:6px;display:flex;flex-direction:column;gap:4px}
.atl .at-r{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--ink-2);white-space:nowrap;overflow:hidden;animation:at-in .5s}
.atl .at-r b{color:var(--ink);font-weight:500}.atl .at-r .at-tm{font-variant-numeric:tabular-nums;color:var(--ink-3)}
.atl .at-r .at-empty{color:var(--ink-3)}
@keyframes at-in{from{opacity:0;transform:translateY(4px)}}
.atl .at-labels{position:absolute;inset:0;pointer-events:none;z-index:3;overflow:hidden}
.atl .at-badge{position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;display:flex;align-items:center;gap:8px;padding:4px;border-radius:999px;background:var(--glass-2);border:1px solid var(--line);box-shadow:0 4px 16px rgba(0,0,0,.14);transition:padding .25s,opacity .25s;white-space:nowrap}
.atl .at-badge .at-pic{border-radius:50%}
.atl .at-badge .at-pic.at-ring-work{box-shadow:0 0 0 2px var(--work)}
.atl .at-badge .at-pic.at-ring-wait{box-shadow:0 0 0 2px var(--wait);animation:at-beat 1.6s infinite}
.atl .at-badge .at-pic.at-ring-err{box-shadow:0 0 0 2px var(--err)}
.atl .at-cnt{position:absolute;top:-6px;right:-8px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:10px;font-weight:700;display:grid;place-items:center;color:#fff;background:var(--work)}
.atl .at-cnt.at-w{background:var(--wait)}.atl .at-cnt.at-e{background:var(--err)}
.atl .at-txt{display:none;padding-right:10px;line-height:1.25}
.atl .at-txt b{font-size:12.5px;font-weight:600;display:block}
.atl .at-txt span{font-size:11.5px;color:var(--ink-2);display:block;max-width:230px;overflow:hidden;text-overflow:ellipsis}
.atl .at-badge.at-big .at-txt{display:block}
.atl .at-dchip{position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;display:flex;align-items:center;gap:9px;padding:4px 13px 4px 4px;border-radius:999px;background:var(--ink);color:var(--bg);box-shadow:0 6px 22px rgba(0,0,0,.22);white-space:nowrap}
.atl .at-dchip b{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;display:block}
.atl .at-dchip small{font-size:11px;opacity:.72;display:block;margin-top:-1px}
.atl .at-dchip small .at-w{color:var(--wait);opacity:1;font-weight:700}.atl .at-dchip small .at-e{color:var(--err);opacity:1;font-weight:700}
.atl .at-dchip.at-hero{padding:6px 18px 6px 6px;gap:12px}
.atl .at-dchip.at-hero b{font-size:15px;letter-spacing:.16em}
.atl .at-dchip.at-hero small{font-size:12px}
.atl .at-say{position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;white-space:nowrap;padding:5px 11px 5px 9px;border-radius:999px;font-size:12px;background:rgba(255,255,255,.94);color:#1d1d1f;box-shadow:0 4px 16px rgba(0,0,0,.13);display:flex;gap:7px;align-items:center;max-width:320px;overflow:hidden;text-overflow:ellipsis;transition:opacity .3s}
.atl .at-say i{width:7px;height:7px;border-radius:50%;flex:none}
.atl .at-say.at-w{box-shadow:0 0 0 1.5px var(--wait),0 4px 16px rgba(0,0,0,.13)}.atl .at-say.at-e{box-shadow:0 0 0 1.5px var(--err),0 4px 16px rgba(0,0,0,.13)}
.atl .at-tip{position:absolute;z-index:6;pointer-events:none;display:none;padding:8px 11px;font-size:12px;align-items:center;gap:9px}
.atl .at-hint{position:absolute;bottom:22px;left:50%;transform:translateX(-50%);z-index:4;font-size:11.5px;color:var(--ink-3);white-space:nowrap;pointer-events:none}
.atl .at-notice{position:absolute;inset:0;z-index:4;display:none;place-items:center;text-align:center;color:var(--ink-2);pointer-events:none}
.atl .at-notice.at-on{display:grid}
.atl.at-mordor{--bg:#0b0807;--glass:rgba(16,11,10,.78);--glass-2:rgba(22,14,12,.94);--ink:#efe2d6;--ink-2:#b39a8a;--ink-3:#7d6a5f;--line:rgba(255,90,40,.18)}
.atl.at-mordor .at-dchip{background:rgba(14,9,8,.88);color:#f1dfd2;box-shadow:0 0 0 1px rgba(255,80,30,.45),0 8px 26px rgba(0,0,0,.6),0 0 22px rgba(255,60,20,.18)}
`;

type Api = (path: string) => Promise<Response>;
export interface MountOptions {
  /** 'mordor': dark mood (black rock, glowing ash sky, haze, embers). */
  theme?: 'light' | 'mordor';
}

/** Debug and test handle left on the container while mounted. */
export interface CitadelDebug { readonly fps: number; quality: { ao: boolean; pr: number } | null; readonly world: World | null; poll(): Promise<void> }
type MountedRoot = HTMLElement & { __citadel?: CitadelDebug };

/* ---------- Scene graph (what the layout builds and the loop animates) ---------- */
interface Placement { m: THREE.Matrix4; c: THREE.Color }
export interface Desk { a: AgentNode; group: THREE.Group; screen: THREE.Mesh; glow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; seat: THREE.Vector3 }
export interface SpaceNode {
  key: string; name: string; tint: number; model: ModelSpace; projects: ProjectNode[];
  a0: number; a1: number; mid: number; podium: THREE.Vector3; center: THREE.Vector3;
  bridge: THREE.Mesh | null; captain: AgentNode | null; chip: HTMLElement | null;
}
export interface ProjectNode {
  slug: string; name: string; color: string; icon: string | null; orphan: boolean;
  space: SpaceNode; pilot: AgentNode | null; crew: AgentNode[]; cols: number; W: number; D: number;
  angle: number; x: number; z: number; bench: THREE.Vector3[]; desks: Desk[]; pilotSpot: THREE.Vector3;
  g: THREE.Group; inner: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; badge: HTMLElement | null; anchor: THREE.Vector3 | null;
}
export interface AgentNode extends Omit<ModelAgent, 'space'> {
  p: ProjectNode | null; space: SpaceNode | null; fig: THREE.Group | null; t3: Tim | null;
  doneUntil: number; big: number; home: THREE.Vector3; homeFace: number; baseY: number; phase: number;
  desk: Desk | null; deskFace: number; benchPos: THREE.Vector3; benchFace: number; deskPos: THREE.Vector3; atDesk: boolean;
  path: { to: THREE.Vector3; face: number } | null;
}
type FigAgent = AgentNode & { fig: THREE.Group; t3: Tim };
interface Pulse { line: THREE.Line; head: THREE.Sprite; path: THREE.CurvePath<THREE.Vector3>; N: number; t: number; len: number }
interface Satellite { s: THREE.Sprite; ring: THREE.Mesh<THREE.TorusGeometry>; r: number; speed: number; ph: number }
interface HomeView { pos: THREE.Vector3; target: THREE.Vector3; k: number }
interface MordorDecor { update(t: number, dt: number): void; dispose(): void }
export interface World {
  group: THREE.Group; model: Model; spaces: SpaceNode[]; projects: ProjectNode[]; agents: AgentNode[]; figAgents: FigAgent[];
  A: Map<string, AgentNode>; P: Map<string, ProjectNode>; streams: Map<string, Record<'time' | 'amount' | 'color', THREE.IUniform>>;
  pulses: Pulse[]; pavHit: THREE.Mesh[]; figHit: THREE.Mesh[]; satellites: Satellite[]; orbitRings: THREE.Mesh[];
  hero: AgentNode | null; heroChip: HTMLElement | null; RING: number; R_IN: number; R_OUT: number; TOP: number; homeView: HomeView;
  beaconAvatar: THREE.Sprite; beaconRing: THREE.Sprite; merged: number;
  mordor: MordorDecor | null; eyeLight: THREE.PointLight | null; lavaTime: THREE.IUniform | null;
  embers: THREE.Points | null; ash: THREE.Points | null;
  colorOf(a: AgentNode): string; iconOf(a: AgentNode): string | null; labelOf(a: AgentNode): string;
}
/** Cached layout measurements of a floating label (reading them forces a layout). */
interface Meas { w: number | null; h: number; big: boolean | null; html: string }

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const initials = (s: string): string => String(s).replace(/[^A-Za-z\u00C0-\u00FF0-9 .-]/g, '').split(/[ .-]/).filter(Boolean).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || '?';
const picHTML = (src: string | null, color: string, label: string, size: number): string => src ? `<img class="at-av" src="${esc(src)}" style="width:${size}px;height:${size}px" alt="">`
  : `<span class="at-mono" style="width:${size}px;height:${size}px;background:${esc(color)};font-size:${Math.round(size * 0.38)}px">${esc(initials(label))}</span>`;
const fmt = (d: Date): string => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(d);
const COL: Record<AgentStateName, string> = { work: 'var(--work)', wait: 'var(--wait)', err: 'var(--err)', rest: 'var(--rest)' };
/** Translated job title of a role, when the messages have one. */
const roleLabel = (role: string | null): string | undefined => (role && /^[a-z]+$/.test(role) && tr('roles.' + role) !== 'roles.' + role ? tr('roles.' + role) : undefined);
const SPACE_TINTS = [0xf3ead9, 0xece6f3, 0xf5e6ea, 0xe4ebf2, 0xe1efec, 0xe9e8e5, 0xeef0dc, 0xe3eef5];
const MORDOR_TINTS = [0x5a4a42, 0x4d4550, 0x5a4446, 0x454c54, 0x434e49, 0x524b44, 0x4f4d40, 0x444b55];
const decodeGlb = async (api: Api, name: string): Promise<ArrayBuffer> => {
  const r = await api('assets/' + name);
  if (!r.ok) throw new Error(`Asset ${name} unavailable (${r.status})`);
  return r.arrayBuffer();
};
const parseGlb = (buf: ArrayBuffer): Promise<GLTF> => new Promise((res, rej) => { new GLTFLoader().parse(buf, '', res, rej); });
const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D => {
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  return g;
};
/** The materials of a mesh, whether it has one or several. */
const materialsOf = (o: THREE.Mesh | THREE.Line | THREE.Points | THREE.Sprite): THREE.Material[] => (Array.isArray(o.material) ? o.material : [o.material]);
type Rect = [number, number, number, number];
const overlaps = (r: Rect, o: Rect, margin = 0): boolean => r[0] < o[2] + margin && r[2] > o[0] - margin && r[1] < o[3] + margin && r[3] > o[1] - margin;

/**
 * Mounts the 3D scene in `root` and starts polling the state; resolves to a function that tears everything down.
 * `opts.theme === 'mordor'` selects the dark mood.
 */
export async function mountCitadel(root: MountedRoot, api: Api, opts: MountOptions = {}): Promise<() => void> {
  let disposed = false;
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
  const MORDOR = opts.theme === 'mordor';
  const wrap = document.createElement('div'); wrap.className = MORDOR ? 'atl at-mordor' : 'atl';
  wrap.innerHTML = `<style>${CSS}</style><canvas class="at-scene"></canvas><div class="at-labels"></div>
<div class="at-brand at-hud"><span class="at-mark">CITADEL</span><span class="at-sub">${esc(tr('tagline'))}</span><span class="at-live"><i></i><span class="at-clock"></span></span></div>
<div class="at-status at-hud at-glass"></div>
<div class="at-controls at-hud"><div class="at-seg at-glass"><button class="at-tour">${esc(tr('tour'))}</button><button class="at-home">${esc(tr('plan'))}</button></div></div>
<div class="at-toast at-hud at-glass"><span class="at-tpic"></span><span><span class="at-who"></span> <span class="at-what"></span></span><button class="at-btn">${esc(tr('see'))}</button></div>
<div class="at-districts at-hud at-glass"><div class="at-eyebrow" style="padding:4px 10px 6px">${esc(tr('spaces'))}</div><div class="at-dlist"></div></div>
<div class="at-card at-hud at-glass"><div class="at-head"><span class="at-cpic"></span><div><div class="at-eyebrow at-ceye"></div><div class="at-t"></div><div class="at-s"></div></div><button class="at-close">✕</button></div><div class="at-list"></div></div>
<div class="at-journal at-hud at-glass"><div class="at-eyebrow">${esc(tr('journal'))}</div><div class="at-rows"></div></div>
<div class="at-tip at-glass"></div>
<div class="at-hint">${esc(tr('hint'))}</div>
<div class="at-notice"></div>`;
  root.appendChild(wrap);
  const $ = <E extends HTMLElement = HTMLElement>(s: string): E => {
    const e = wrap.querySelector<E>(s);
    if (!e) throw new Error('Citadel markup is missing ' + s);
    return e;
  };
  const canvas = $<HTMLCanvasElement>('.at-scene'), labelsEl = $('.at-labels'), tip = $('.at-tip'), notice = $('.at-notice');
  const el = { brand: $('.at-brand'), status: $('.at-status'), controls: $('.at-controls'), districts: $('.at-districts'), journal: $('.at-journal'), toast: $('.at-toast'), card: $('.at-card') };
  const showNotice = (msg: string): void => { notice.textContent = msg; notice.classList.toggle('at-on', !!msg); };
  const W = (): number => Math.max(1, root.clientWidth), H = (): number => Math.max(1, root.clientHeight);
  const meas = new WeakMap<HTMLElement, Meas>();
  const measOf = (e: HTMLElement): Meas => { let m = meas.get(e); if (!m) { m = { w: null, h: 0, big: null, html: '' }; meas.set(e, m); } return m; };

  // Binary assets served by the host, read in parallel
  let officeG: GLTF, tim3dData: Awaited<ReturnType<typeof loadTim3D>>;
  try { [officeG, tim3dData] = await Promise.all([decodeGlb(api, 'office.glb').then(parseGlb), loadTim3D(api)]); }
  catch (e) { wrap.remove(); throw e; }
  if (disposed) { wrap.remove(); return () => {}; }

  /* ---------- Rendering ---------- */
  const shared = new WeakSet<object>();            // geometries, materials, textures that survive a scenery rebuild
  const share = <T extends object>(o: T): T => (shared.add(o), o);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let PR = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(PR);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  { const pm = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment(); scene.environment = pm.fromScene(room, 0.03).texture; pm.dispose(); room.dispose(); }
  const fog = new THREE.Fog(0xd9d6d0, 260, 600);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(24, 1, 1, 500);
  camera.layers.enable(1);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.07, maxPolarAngle: 1.15, minPolarAngle: 0.15, minDistance: 6, maxDistance: 130, zoomToCursor: true, screenSpacePanning: false, rotateSpeed: 0.5 });
  let reach = 30;
  const onControlsChange = (): void => { const r = Math.hypot(controls.target.x, controls.target.z); if (r > reach) controls.target.multiplyScalar(reach / r); controls.target.y = 0; };
  controls.addEventListener('change', onControlsChange);
  const HOME = { pos: new THREE.Vector3(0, 68, 60), target: new THREE.Vector3(0, 0, 2.5) };
  camera.position.copy(HOME.pos); controls.target.copy(HOME.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xd8d4cc, 0.32); scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 3.4);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 4; key.shadow.blurSamples = 16; key.shadow.bias = -0.0003;
  key.position.set(-46, 34, 30); scene.add(key, key.target);

  const M = {
    ground: new THREE.MeshStandardMaterial({ color: 0xcfccc5, roughness: 1 }),
    plinth: new THREE.MeshStandardMaterial({ color: 0xf7f6f3, roughness: 0.85 }),
    white: new THREE.MeshStandardMaterial({ color: 0xfbfaf8, roughness: 0.8 }),
    screenOff: new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.35, metalness: 0.2 }),
    tree: new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.9 }),
    stem: new THREE.MeshStandardMaterial({ color: 0xdedbd4, roughness: 0.9 }),
  };
  Object.values(M).forEach(share);
  const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, r = 0): THREE.Mesh => {
    const m = new THREE.Mesh(r ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = m.receiveShadow = true;
    return m;
  };
  const canvasTex = (w: number, h: number, draw: (g: CanvasRenderingContext2D, c: HTMLCanvasElement) => void, own = false): THREE.CanvasTexture => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(ctx2d(c), c);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return own ? tex : share(tex);
  };
  const glowTex = canvasTex(128, 128, g => { const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.3, 'rgba(255,255,255,.45)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); });
  const ringTex = canvasTex(128, 128, g => { g.strokeStyle = '#fff'; g.lineWidth = 10; g.beginPath(); g.arc(64, 64, 56, 0, 7); g.stroke(); });
  function engraved(text: string, { size = 0.5, weight = 600, spacing = 0.18, color = '#3a3a3c', opacity = 0.7 } = {}): THREE.Mesh {
    const px = 96, c = document.createElement('canvas'), g = ctx2d(c);
    const font = `${weight} ${px}px -apple-system, "SF Pro Display", Inter, sans-serif`;
    g.font = font; g.letterSpacing = `${spacing * px}px`; c.width = Math.ceil(g.measureText(text).width) + px; c.height = px * 1.4;
    g.font = font; g.letterSpacing = `${spacing * px}px`; g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, px / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size * c.width / px, size * c.height / px), new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity, roughness: 1, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.receiveShadow = true;
    return m;
  }
  // Round avatar (icon or monogram) for badges and labels
  const avatarCache = new Map<string, THREE.CanvasTexture>();
  function avatarTexture(src: string | null, color: string, label: string): THREE.CanvasTexture {
    const k = src || color + label, known = avatarCache.get(k);
    if (known) return known;
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = ctx2d(c);
    const tex = share(new THREE.CanvasTexture(c)); tex.colorSpace = THREE.SRGBColorSpace; avatarCache.set(k, tex);
    const frame = (): void => { g.save(); g.beginPath(); g.arc(64, 64, 60, 0, 7); g.closePath(); g.lineWidth = 8; g.strokeStyle = '#fff'; g.stroke(); g.restore(); tex.needsUpdate = true; };
    const mono = (): void => { g.fillStyle = color; g.fillRect(0, 0, 128, 128); g.fillStyle = '#fff'; g.font = '700 50px -apple-system, Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(initials(label), 64, 68); };
    g.save(); g.beginPath(); g.arc(64, 64, 60, 0, 7); g.clip();
    g.fillStyle = color; g.fillRect(0, 0, 128, 128);
    if (src) { const img = new Image(); img.onload = () => { if (disposed) return; g.save(); g.beginPath(); g.arc(64, 64, 60, 0, 7); g.clip(); g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 128); g.drawImage(img, 0, 0, 128, 128); g.restore(); frame(); }; img.src = src; }
    else mono();
    g.restore(); frame();
    return tex;
  }
  const treeGeo = share(new THREE.SphereGeometry(0.3, 20, 14)), stemGeo = share(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), M.ground);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -1.2; ground.receiveShadow = true; scene.add(ground);

  /* ---------- Furniture (GLB served by the host) ---------- */
  const S = 0.38;
  const KIT = new Map<string, THREE.Object3D>();
  officeG.scene.children.forEach(o => { KIT.set(o.name, o); });
  officeG.scene.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    share(o.geometry);
    for (const m of materialsOf(o)) {
      share(m);
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      if (m.name === 'Fabric') m.color.set(0xffffff); else if (MORDOR) m.color.lerp(new THREE.Color(0x2a2624), 0.75);
    }
  });
  const screenGeo = ((): THREE.BufferGeometry => {
    let g: THREE.BufferGeometry | null = null;
    KIT.get('Monitor_Screen')?.traverse(o => { if (o instanceof THREE.Mesh) g = o.geometry; });
    if (!g) throw new Error('office.glb has no Monitor_Screen mesh');
    return g;
  })();
  const OAK_FLOOR = new THREE.Color(MORDOR ? 0x8a7262 : 0xf3eee6);   // Mordor: warm stone slabs, so the desks stand out from the basalt
  const screenCache = new Map<string, THREE.MeshBasicMaterial>();
  type ScreenKind = 'work' | 'wait' | 'err';
  function screenMat(color: string, state: ScreenKind): THREE.MeshBasicMaterial {
    const k = color + state, known = screenCache.get(k);
    if (known) return known;
    const tex = canvasTex(256, 148, (g, c) => {
      const Wd = c.width, Hd = c.height, rnd = (() => { let s = color.length * 97 + state.length; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
      if (state === 'wait') {
        g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, Wd, Hd);
        g.fillStyle = '#ffffff'; g.strokeStyle = '#e8930c'; g.lineWidth = 4; g.beginPath(); g.roundRect(34, 30, Wd - 68, Hd - 60, 10); g.fill(); g.stroke();
        g.fillStyle = '#e8930c'; g.beginPath(); g.arc(60, 58, 9, 0, 7); g.fill();
        g.fillStyle = '#3a3a3c'; g.fillRect(78, 52, 110, 10); g.fillStyle = '#b8b8bc'; g.fillRect(52, 78, 150, 7);
        g.fillStyle = '#1d1d1f'; g.beginPath(); g.roundRect(Wd - 112, Hd - 52, 64, 18, 6); g.fill();
      } else {
        g.fillStyle = state === 'err' ? '#2a0f12' : '#14161b'; g.fillRect(0, 0, Wd, Hd);
        g.fillStyle = '#2a2d35'; g.fillRect(0, 0, Wd, 16);
        ['#ff5f57', '#febc2e', '#28c840'].forEach((cc, i) => { g.fillStyle = cc; g.beginPath(); g.arc(12 + i * 12, 8, 3.5, 0, 7); g.fill(); });
        const syntax = [color, '#9aa4b2', '#5f6b7a', '#e6e6e6'];
        for (let l = 0; l < 10; l++) {
          let x = 14 + (rnd() < 0.5 ? 0 : 14 * Math.ceil(rnd() * 3)); const y = 26 + l * 12;
          for (let w = 0; w < 1 + rnd() * 4; w++) {
            const len = 12 + rnd() * 46; if (x + len > Wd - 10) break;
            g.fillStyle = state === 'err' ? (l === 4 ? '#ff4d4f' : '#7a3a3f') : syntax[Math.floor(rnd() * 4)] ?? color;
            g.fillRect(x, y, len, 5); x += len + 6;
          }
        }
        if (state === 'err') { g.fillStyle = '#ff4d4f'; g.fillRect(14, 74, Wd - 28, 12); }
      }
    });
    const mat = share(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(0.92, 0.92, 0.92) }));
    screenCache.set(k, mat);
    return mat;
  }

  /* ---------- 3D Tims (Timon mascot engine, src/tim3d.ts) ---------- */
  const FLOOR_Y = 0.08, TIM_H = 0.62;     // TIM_H: height of a team Tim in the scene (scenery units)
  const tims3d = createTims(tim3dData);
  const seedOf = (str: string): number => { let h = 0; for (const c of str) h = (31 * h + c.charCodeAt(0)) % 9973; return h % 97 + 1; };
  // Citadel state → Tim state (as in the app); a finished task: 3 s of joy
  const TIM_STATE: Record<AgentStateName, string> = { work: 'working', wait: 'waiting', err: 'error', rest: 'idle' };
  const timState = (a: AgentNode): string => performance.now() / 1000 < a.doneUntil ? 'done' : a.state === 'work' && /coder/.test(a.role) ? 'coding' : TIM_STATE[a.state];

  /* ---------- Sky, pool, post-processing ---------- */
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color('#9fbbd8') }, mid: { value: new THREE.Color('#f4efe8') }, bottom: { value: new THREE.Color('#d6d2cb') }, stars: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform vec3 top, mid, bottom; uniform float stars; varying vec3 vDir;
      void main(){ float y = vDir.y; vec3 c = y > 0.0 ? mix(mid, top, pow(clamp(y, 0.0, 1.0), 0.55)) : mix(mid, bottom, clamp(-y * 3.0, 0.0, 1.0)); gl_FragColor = vec4(c, 1.0); }`,
  });
  const skyU = bindUniforms(skyMat, ['top', 'mid', 'bottom'] as const);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(320, 48, 24), skyMat);
  sky.renderOrder = -10; sky.userData.dynamic = true; scene.add(sky);
  fog.color.set(0xd9d6d0); M.ground.color.set(0xcfccc5);
  hemi.color.set(0xffffff); hemi.groundColor.set(0xd8d4cc); hemi.intensity = 0.32;
  scene.environmentIntensity = 0.22;
  if (MORDOR) {                                     // Mordor: black sky over a burning horizon, basalt, cold moonlight; the eye lights the scene
    skyU.top.value.set('#040304'); skyU.mid.value.set('#4a0f06'); skyU.bottom.value.set('#080505');
    fog.color.set(0x140805); fog.near = 90; fog.far = 400; M.ground.color.set(0x070505);
    M.plinth.color.set(0x34302e); M.white.color.set(0x423c39); M.white.roughness = M.plinth.roughness = 0.92;
    M.tree.color.set(0x161312); M.stem.color.set(0x100d0c); M.screenOff.color.set(0x0c0a09);
    hemi.color.set(0x6a3a2c); hemi.groundColor.set(0x050303); hemi.intensity = 0.3;
    key.color.set(0xb4bad8); key.intensity = 3.0; scene.environmentIntensity = 0.05;
  }

  const composer = new EffectComposer(renderer);
  const basePass = new RenderPass(scene, camera); composer.addPass(basePass);
  let aoPass: N8AOPass | null = null;
  try {
    aoPass = new N8AOPass(scene, camera, W(), H());
    Object.assign(aoPass.configuration, { aoRadius: 1.4, distanceFalloff: 0.6, intensity: 2.4, halfRes: true, gammaCorrection: false, color: new THREE.Color(0x2a2620) });
    aoPass.setQualityMode('Low');
    composer.addPass(aoPass); basePass.enabled = false;
  } catch { aoPass = null; basePass.enabled = true; }
  const setAO = (on: boolean): void => { if (!aoPass) return; aoPass.enabled = on; basePass.enabled = !on; };
  const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), MORDOR ? 0.55 : 0.22, 0.5, MORDOR ? 0.9 : 1.0);
  composer.addPass(bloom);
  const finish = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, focus: { value: 0.5 }, amount: { value: 0.6 }, res: { value: new THREE.Vector2(1, 1) }, vig: { value: MORDOR ? 0.55 : 0.2 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float focus, amount, vig; uniform vec2 res; varying vec2 vUv;
      void main(){
        float d = smoothstep(0.22, 0.6, abs(vUv.y - focus)) * amount;
        vec4 c = vec4(0.0); float ws = 0.0;
        if (d < 0.02) { c = texture2D(tDiffuse, vUv); ws = 1.0; } else for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) { vec2 o = vec2(float(i), float(j)) / res * d * 3.0; float w = exp(-float(i*i + j*j) / 2.0); c += texture2D(tDiffuse, vUv + o) * w; ws += w; }
        c /= ws;
        c.rgb *= mix(1.0, smoothstep(1.05, 0.3, length((vUv - 0.5) * vec2(1.1, 1.0))), vig);
        gl_FragColor = c;
      }`,
  });
  const finishU = bindUniforms(finish.material as THREE.ShaderMaterial, ['res', 'focus', 'amount'] as const);
  composer.addPass(finish); composer.addPass(new OutputPass());

  /* ================================================================== */
  /* Scenery: rebuilt when the structure (spaces, projects, agents) changes */
  /* ================================================================== */
  const polar = (r: number, a: number, y = 0): THREE.Vector3 => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  const R_HUB = 4.2, D_MAX = 3.7, GAP = 1.0, DGAP = 4.4;
  const UP = new THREE.Vector3(0, 1, 0);
  let world: World | null = null, worldKey = '', introDone = false;
  let selProject: ProjectNode | null = null, selAgent: AgentNode | null = null, selSpace: SpaceNode | null = null;
  let hover: AgentNode | null = null, hoverP: ProjectNode | null = null;
  const says = new Map<AgentNode, HTMLElement>();
  // Raycast hits → what they stand for
  const agentOfHit = new WeakMap<THREE.Object3D, AgentNode>();
  const projectOfHit = new WeakMap<THREE.Object3D, ProjectNode>();

  /* ---------- Mordor: immersion (the eye's gaze, rock spikes, lava bubbles and smoke, ravens, stakes) ---------- */
  function mordorDecor(group: THREE.Group, wd: { R_IN: number; R_OUT: number; TOP: number }): MordorDecor {
    const { R_IN, R_OUT, TOP } = wd;
    const dyn = <T extends THREE.Object3D>(o: T): T => { o.userData.dynamic = true; o.frustumCulled = false; group.add(o); return o; };
    const smokeTex = canvasTex(128, 128, g => { const r = g.createRadialGradient(64, 64, 4, 64, 64, 62); r.addColorStop(0, 'rgba(255,255,255,.9)'); r.addColorStop(.5, 'rgba(255,255,255,.35)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); });
    const crowTex = canvasTex(64, 32, g => { g.fillStyle = '#050304'; g.beginPath(); g.moveTo(2, 8); g.quadraticCurveTo(18, 6, 32, 18); g.quadraticCurveTo(46, 6, 62, 8); g.quadraticCurveTo(46, 14, 32, 24); g.quadraticCurveTo(18, 14, 2, 8); g.fill(); });
    const obsidian = new THREE.MeshStandardMaterial({ color: 0x0d0b0b, roughness: 0.7, metalness: 0.2 });
    // The gaze: a cone of light leaves the eye and sweeps the ring, its spot gliding over the pavilions
    const eyeY = TOP + 2.2, reachR = (R_IN + R_OUT) / 2, len = Math.hypot(reachR, eyeY);
    const beam = dyn(new THREE.Group()); beam.position.y = eyeY;
    const tilt = new THREE.Group(); tilt.rotation.x = Math.atan2(eyeY, reachR); beam.add(tilt);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2, len, 40, 1, true), new THREE.MeshBasicMaterial({ color: 0xff5a14, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    cone.rotation.x = -Math.PI / 2; cone.position.z = len / 2; tilt.add(cone);
    const spot = new THREE.Mesh(new THREE.CircleGeometry(2.4, 40), new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color(1.3, 0.42, 0.1), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    spot.rotation.x = -Math.PI / 2; spot.position.set(0, 0.45 - eyeY, reachR); beam.add(spot);
    // Horizon: a crown of jagged rock spikes around the model
    const rock = new THREE.MeshStandardMaterial({ color: 0x1f1a18, roughness: 0.9, emissive: 0x0c0302 });
    for (let i = 0; i < 70; i++) {
      const a = i / 70 * Math.PI * 2 + Math.random() * 0.05, r = R_OUT + 9 + Math.random() * 10, h = 1.6 + Math.random() * 3 + (i % 5 === 0 ? 2.2 : 0);
      const m = dyn(new THREE.Mesh(new THREE.ConeGeometry(0.9 + Math.random() * 1.3, h, 4 + (i % 3)), rock)); m.position.set(Math.cos(a) * r, h / 2 - 0.9, Math.sin(a) * r); m.rotation.y = Math.random() * 3; m.castShadow = true;
    }
    // Smoke: plumes rising from the lava
    const smoke: { sp: THREE.Sprite; x: number; y: number; z: number; s0: number; rise: number; life: number; ph: number }[] = [];
    const puff = (x: number, y: number, z: number, s0: number, rise: number, life: number, col: number): void => { const sp = dyn(new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: col, transparent: true, depthWrite: false, opacity: 0 }))); smoke.push({ sp, x, y, z, s0, rise, life, ph: Math.random() * life }); };
    for (let i = 0; i < 16; i++) { const a = Math.random() * 6.283, r = 4 + Math.random() * (R_IN - 6); puff(Math.cos(a) * r, -0.3, Math.sin(a) * r, 2.2, 7, 6, 0x3a2a24); }
    // Lava bubbles that swell and burst
    const bubbles: { b: THREE.Mesh; ph: number; sp: number }[] = [], bubMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.6, 0.12), toneMapped: false });
    for (let i = 0; i < 26; i++) { const a = Math.random() * 6.283, r = 4.5 + Math.random() * (R_IN - 6), b = dyn(new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), bubMat)); b.position.set(Math.cos(a) * r, -0.38, Math.sin(a) * r); bubbles.push({ b, ph: Math.random() * 3, sp: 0.6 + Math.random() * 0.8 }); }
    // Ravens circling the tower
    const crows: { c: THREE.Sprite; r: number; y: number; sp: number; ph: number; s: number }[] = [];
    for (let i = 0; i < 12; i++) { const c = dyn(new THREE.Sprite(new THREE.SpriteMaterial({ map: crowTex, transparent: true, depthWrite: false, fog: false }))); crows.push({ c, r: 4 + Math.random() * (R_IN - 6), y: 2.2 + Math.random() * 3.5, sp: (0.18 + Math.random() * 0.25) * (i % 2 ? 1 : -1), ph: Math.random() * 6.283, s: 1.1 + Math.random() * 0.7 }); }
    // Iron stakes on the rim of the ring
    const iron = new THREE.MeshStandardMaterial({ color: 0x5a524e, roughness: 0.45, metalness: 0.7, emissive: 0x1a0603 });
    const N = Math.round(R_OUT * 6), stake = new THREE.InstancedMesh(new THREE.ConeGeometry(0.16, 1, 5), iron, N), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const torches: { f: THREE.Sprite; ph: number }[] = [];
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, r = R_OUT + 2.5, h = 1.0 + (i % 3) * 0.25 + (i % 8 === 0 ? 0.5 : 0);
      m4.compose(new THREE.Vector3(Math.cos(a) * r, -0.4 + h * 0.5, Math.sin(a) * r), q.setFromEuler(e.set(Math.sin(a) * 0.16, 0, -Math.cos(a) * 0.16)), new THREE.Vector3(1, h, 1)); stake.setMatrixAt(i, m4);
      if (i % 8 === 0) {                              // one torch every eight stakes
        const f = dyn(new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(2.4, 0.9, 0.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
        f.position.set(Math.cos(a) * r, -0.4 + h + 0.12, Math.sin(a) * r); torches.push({ f, ph: Math.random() * 6 });
      }
    }
    stake.castShadow = true; dyn(stake);
    const own = [smokeTex, crowTex, obsidian, bubMat, rock, iron];
    return {
      update(time: number): void {
        beam.rotation.y = time * 0.17 + Math.sin(time * 0.31) * 1.2;                // the gaze sweeps, lingers, moves on
        cone.material.opacity = 0.075 + 0.03 * Math.sin(time * 5);
        for (const p of smoke) { const k = ((time + p.ph) % p.life) / p.life; p.sp.position.set(p.x + Math.sin(time * 0.3 + p.ph) * k * 3, p.y + k * p.rise, p.z); p.sp.scale.setScalar(p.s0 * (0.4 + k)); p.sp.material.opacity = Math.sin(k * Math.PI) * 0.55; }
        for (const u of bubbles) { const k = ((time * u.sp + u.ph) % 3) / 3, g = k < 0.85 ? k / 0.85 : 0; u.b.scale.setScalar(0.2 + g * 1.3); u.b.visible = k < 0.9; }
        for (const tc of torches) { const k = 0.85 + Math.sin(time * 11 + tc.ph) * 0.1 + Math.sin(time * 17.3 + tc.ph) * 0.08; tc.f.scale.set(0.55 * k, 0.85 * k, 1); }
        for (const c of crows) { const a = time * c.sp + c.ph; c.c.position.set(Math.cos(a) * c.r, c.y + Math.sin(time * 0.8 + c.ph) * 0.4, Math.sin(a) * c.r); c.c.scale.set(c.s, c.s * (0.35 + 0.25 * Math.abs(Math.sin(time * 7 + c.ph))), 1); }
      },
      dispose(): void { own.forEach(o => o.dispose()); },
    };
  }
  function lavaLake(radius: number): THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial> {
    return new THREE.Mesh(new THREE.CircleGeometry(radius, 128), new THREE.ShaderMaterial({ toneMapped: false, fog: false, uniforms: { time: { value: 0 } },
      vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `uniform float time; varying vec2 vP;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+1.),f.x), f.y); }
        float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a * n(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return v; }
        void main(){
          vec2 p = vP * .55; float t = time * .19;
          float q = fbm(p + vec2(t, -t * .7)), r = fbm(p * 1.6 + q * 1.8 - vec2(t * .5, t));
          float crack = smoothstep(.085, .015, abs(r - .5));          // glowing veins between the crust plates
          float pulse = .72 + .28 * sin(time * 2.6 + q * 7.);
          vec3 crust = mix(vec3(.012,.009,.008), vec3(.05,.02,.012), q * q);
          vec3 glow = mix(vec3(.75,.12,.02), vec3(1.5,.55,.1), pow(crack, 4.)) * crack * pulse;
          gl_FragColor = vec4(crust + glow, 1.);
        }` }));
  }
  function disposeMaterial(m: THREE.Material): void {
    if (shared.has(m)) return;
    const withMap = m as THREE.Material & { map?: THREE.Texture | null };
    if (withMap.map && !shared.has(withMap.map)) withMap.map.dispose();
    m.dispose();
  }
  function disposeTree(rootObj: THREE.Object3D): void {
    rootObj.traverse(o => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Sprite) {
        if (!(o instanceof THREE.Sprite) && !shared.has(o.geometry)) o.geometry.dispose();
        materialsOf(o).forEach(disposeMaterial);
      }
      if (o instanceof Reflector) o.dispose();
    });
  }
  function destroyWorld(): void {
    if (!world) return;
    labelsEl.replaceChildren(); says.clear(); selProject = selAgent = selSpace = null; hover = hoverP = null; tip.style.display = 'none';
    world.agents.forEach(a => a.t3?.dispose());
    world.mordor?.dispose();
    scene.remove(world.group); disposeTree(world.group);
    world = null;
  }

  function buildWorld(mdl: Model): World {
    const group = new THREE.Group(); scene.add(group);
    const placements = new Map<string, Placement[]>();
    const pulses: Pulse[] = [], pavHit: THREE.Mesh[] = [], figHit: THREE.Mesh[] = [];
    const streams = new Map<string, Record<'time' | 'amount' | 'color', THREE.IUniform>>();

    /* --- Layout data --- */
    const tints = MORDOR ? MORDOR_TINTS : SPACE_TINTS;
    const spaces: SpaceNode[] = mdl.spaces.map((s, i) => ({
      key: s.key, name: s.name, tint: tints[i % tints.length] ?? 0xffffff, model: s, projects: [],
      a0: 0, a1: 0, mid: 0, podium: new THREE.Vector3(), center: new THREE.Vector3(), bridge: null, captain: null, chip: null,
    }));
    const SP = new Map(spaces.map(s => [s.key, s]));
    const projects: ProjectNode[] = [];
    const modelProjects = new Map<string, ModelProject>();
    for (const p of mdl.projects) {
      const space = SP.get(p.space);
      if (!space) continue;
      modelProjects.set(p.slug, p);
      projects.push({
        slug: p.slug, name: p.name, color: p.color, icon: p.icon, orphan: p.orphan, space, pilot: null, crew: [], cols: 2, W: 0, D: 3.7,
        angle: 0, x: 0, z: 0, bench: [], desks: [], pilotSpot: new THREE.Vector3(), g: new THREE.Group(), inner: new THREE.Mesh(), badge: null, anchor: null,
      });
    }
    const P = new Map(projects.map(p => [p.slug, p]));
    const agents: AgentNode[] = mdl.agents.map(a => ({
      ...a, p: (a.project ? P.get(a.project) : undefined) ?? null, space: (a.space ? SP.get(a.space) : undefined) ?? null, fig: null, t3: null,
      doneUntil: 0, big: 1, home: new THREE.Vector3(), homeFace: 0, baseY: FLOOR_Y, phase: 0,
      desk: null, deskFace: 0, benchPos: new THREE.Vector3(), benchFace: 0, deskPos: new THREE.Vector3(), atDesk: false, path: null,
    }));
    const A = new Map(agents.map(a => [a.name, a]));
    for (const p of projects) {
      const mp = modelProjects.get(p.slug);
      p.pilot = (mp?.pilot ? A.get(mp.pilot) : undefined) ?? null;
      p.crew = (mp?.crew ?? []).map(n => A.get(n)).filter((a): a is AgentNode => a !== undefined);
      p.cols = Math.max(2, Math.ceil(p.crew.length / 2)); p.W = p.cols * 1.05 + 1.5; p.D = 3.7;
    }
    const colorOf = (a: AgentNode): string => a.p?.color || '#1d1d1f';
    const iconOf = (a: AgentNode): string | null => a.icon || a.p?.icon || null;
    const labelOf = (a: AgentNode): string => a.p ? a.p.name : a.name;

    // Circular layout: each space on an arc platform around the central rotunda
    const arcTotal = projects.reduce((tot, p) => tot + p.W + GAP, 0) + spaces.length * (DGAP - GAP);
    const RING = Math.max(arcTotal / (Math.PI * 2), R_HUB + D_MAX / 2 + 1.9 + 1.5);
    const R_IN = RING - D_MAX / 2 - 1.9, R_OUT = RING + D_MAX / 2 + 0.9;
    const totalAngle = arcTotal / RING, partial = totalAngle < Math.PI * 2 - 0.01;
    const START = partial ? -Math.PI / 2 - totalAngle / 2 : -Math.PI / 2 - 0.95;
    { let s = 0;
      for (const d of spaces) {
        const ps = projects.filter(p => p.space === d); d.projects = ps;
        d.a0 = START + s / RING;
        for (const p of ps) { p.angle = START + (s + p.W / 2) / RING; const v = polar(RING, p.angle); p.x = v.x; p.z = v.z; s += p.W + GAP; }
        d.a1 = START + (s - GAP) / RING; d.mid = (d.a0 + d.a1) / 2;
        d.podium = polar(R_IN + 0.95, d.mid, 0); d.center = polar(RING - 1, d.mid);
        s += DGAP - GAP;
      } }
    const homeView: HomeView = (() => { const k = THREE.MathUtils.clamp(R_OUT / 24.3, 0.55, 3); return { pos: new THREE.Vector3(0, 68 * k, 60 * k), target: new THREE.Vector3(0, 0, 2.5 * k), k }; })();
    reach = Math.max(30, R_OUT * 1.25); controls.maxDistance = Math.max(130, R_OUT * 5);
    Object.assign(key.shadow.camera, { left: -R_OUT * 2.1, right: R_OUT * 2.1, top: R_OUT * 1.4, bottom: -R_OUT * 1.4, near: 10, far: 180 + R_OUT * 3 });
    key.shadow.camera.updateProjectionMatrix();
    key.position.set(-46 * homeView.k, 34 * homeView.k, 30 * homeView.k);

    /* --- Base, platforms, org chart, trees --- */
    const base = new THREE.Mesh(new THREE.CylinderGeometry(R_OUT + 3, R_OUT + 3.2, 0.9, 128), M.plinth);
    base.position.y = -0.85; base.castShadow = base.receiveShadow = true; group.add(base);
    function sector(r0: number, r1: number, a0: number, a1: number, h: number, mat: THREE.Material): THREE.Mesh {
      const sh = new THREE.Shape(), n = 48;
      for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; if (i) sh.lineTo(Math.cos(a) * r1, -Math.sin(a) * r1); else sh.moveTo(Math.cos(a) * r1, -Math.sin(a) * r1); }
      for (let i = n; i >= 0; i--) { const a = a0 + (a1 - a0) * i / n; sh.lineTo(Math.cos(a) * r0, -Math.sin(a) * r0); }
      const g = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.06, bevelSegments: 2, curveSegments: 4 });
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true;
      return m;
    }
    for (const d of spaces) {
      const pad = 0.9 / RING;
      const pl = sector(R_IN, R_OUT, d.a0 - pad, d.a1 + pad, 0.36, new THREE.MeshStandardMaterial({ color: d.tint, roughness: 0.85, ...(MORDOR ? { emissive: new THREE.Color(d.tint).multiplyScalar(0.18) } : {}) }));
      pl.position.y = -0.4; group.add(pl);
    }
    const orgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12, depthWrite: false });
    const strip = (p0: THREE.Vector3, p1: THREE.Vector3, w = 0.05, y = 0.006): void => {
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z), m = new THREE.Mesh(new THREE.PlaneGeometry(len, w), orgMat);
      m.rotation.set(-Math.PI / 2, 0, -Math.atan2(p1.z - p0.z, p1.x - p0.x)); m.position.set((p0.x + p1.x) / 2, y, (p0.z + p1.z) / 2); group.add(m);
    };
    for (const d of spaces) {
      const bridge = box(R_IN - R_HUB + 0.2, 0.1, 0.9, M.white);
      const mid = polar((R_HUB + R_IN) / 2, d.mid); bridge.position.set(mid.x, -0.4, mid.z); bridge.rotation.y = -d.mid; group.add(bridge);
      d.bridge = bridge; bridge.userData.dynamic = true;
      strip(polar(R_HUB, d.mid), polar(R_IN + 0.6, d.mid), 0.06, -0.33);
      const rr = RING - D_MAX / 2 - 0.7, n = 24;
      for (let i = 0; i < n; i++) strip(polar(rr, d.a0 + (d.a1 - d.a0) * i / n), polar(rr, d.a0 + (d.a1 - d.a0) * (i + 1) / n));
      for (const p of d.projects) strip(polar(rr, p.angle), polar(RING - p.D / 2, p.angle));
      const lab = engraved(d.name.toUpperCase(), { size: 0.34, spacing: 0.45, opacity: 0.35 });
      const lp = polar(R_IN + 0.45, d.mid); lab.position.set(lp.x, 0.008, lp.z); lab.rotation.z = -d.mid - Math.PI / 2; group.add(lab);
    }
    spaces.forEach((d, i) => {
      const next = spaces[(i + 1) % spaces.length] ?? d;
      const a = (d.a1 + (i < spaces.length - 1 ? next.a0 : next.a0 + Math.PI * 2)) / 2;
      if (spaces.length === 1 && !partial) return;
      for (const r of [R_IN + 0.6, RING, R_OUT - 0.4]) {
        const v = polar(r, a);
        const st = new THREE.Mesh(stemGeo, M.stem); st.position.set(v.x, -0.15, v.z); st.castShadow = true; group.add(st);
        const tr3 = new THREE.Mesh(treeGeo, M.tree); tr3.position.set(v.x, 0.3, v.z); tr3.scale.set(1, 1.15, 1); tr3.castShadow = tr3.receiveShadow = true; group.add(tr3);
      }
    });

    /* --- Cutaway pavilions --- */
    const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(S, S, S);
    function furnish(parent: THREE.Object3D, piece: string, x: number, z: number, rotY = 0, color: THREE.ColorRepresentation = 0xffffff, y = 0): void {
      parent.updateMatrixWorld(true);
      const local = new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(0, rotY, 0)), _s);
      const list = placements.get(piece) ?? [];
      list.push({ m: new THREE.Matrix4().multiplyMatrices(parent.matrixWorld, local), c: new THREE.Color(color) });
      placements.set(piece, list);
    }
    for (const p of projects) {
      const g = p.g; g.position.set(p.x, 0, p.z); g.rotation.y = Math.atan2(-p.x, -p.z);
      group.add(g); g.updateMatrixWorld(true);
      const { W: pw, D: pd } = p, Hh = 0.46, FL = 0.08;
      const tint = OAK_FLOOR.clone().lerp(new THREE.Color(p.color), MORDOR ? 0.12 : 0.06);
      // Mordor: the floor returns the lava glow (emissive), so the desks do not float in the dark
      g.add(box(pw, 0.08, pd, new THREE.MeshStandardMaterial({ color: tint, roughness: 0.7, ...(MORDOR ? { emissive: tint.clone().multiplyScalar(0.32) } : {}) }), 0, 0.04, 0, 0.02));
      g.add(box(pw, Hh, 0.07, M.white, 0, Hh / 2 + 0.08, -pd / 2 + 0.035));
      g.add(box(0.07, Hh, pd, M.white, -pw / 2 + 0.035, Hh / 2 + 0.08, 0));
      g.add(box(0.07, Hh, pd, M.white, pw / 2 - 0.035, Hh / 2 + 0.08, 0));
      g.add(box(pw, 0.04, 0.05, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.6 }), 0, Hh + 0.1, -pd / 2 + 0.035));
      const fabric = new THREE.Color(p.color).lerp(new THREE.Color(0xffffff), 0.15);
      const nSofa = Math.max(1, Math.ceil(p.crew.length / 2)), sofaW = 1.56 * S + 0.1, sofaZ = -pd / 2 + 0.07 + 0.42 * S;
      p.bench = [];
      for (let k = 0; k < nSofa; k++) {
        const x = (k - (nSofa - 1) / 2) * sofaW;
        furnish(g, 'Rug', x, sofaZ + 0.26, 0, 0xffffff, FL - 0.002);
        furnish(g, 'Sofa', x, sofaZ, 0, 0xffffff, FL);
        furnish(g, 'CoffeeTable', x, sofaZ + 0.42, 0, 0xffffff, FL);
        for (const sx of [-1, 1]) p.bench.push(new THREE.Vector3(x + sx * 0.36 * S, FL, sofaZ + 0.05));
      }
      furnish(g, 'FloorLamp', pw / 2 - 0.22, -pd / 2 + 0.25, Math.PI, 0xffffff, FL);
      furnish(g, 'PlantTall', -pw / 2 + 0.24, pd / 2 - 0.26, 0.6, 0xffffff, FL);
      furnish(g, 'Shelf', -pw / 2 + 0.07 + 0.32 * S / 2 + 0.02, 0.15, Math.PI / 2, 0xffffff, FL);
      furnish(g, 'PlantSmall', -pw / 2 + 0.07 + 0.32 * S / 2 + 0.02, 0.0, 0, 0xffffff, FL + 1.6 * S);
      const logoTex = avatarTexture(p.icon, p.color, p.name);
      const inlay = new THREE.Mesh(new THREE.CircleGeometry(Math.min(pw, pd) * 0.38, 64), new THREE.MeshStandardMaterial({ map: logoTex, transparent: true, opacity: 0.92, roughness: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      inlay.rotation.x = -Math.PI / 2; inlay.position.set(0, FL + 0.002, 0.28); inlay.receiveShadow = true; g.add(inlay);
      p.desks = p.crew.map((a, i) => {
        const col = i % p.cols, row = Math.floor(i / p.cols);
        const x = (col - (p.cols - 1) / 2) * 1.05, z = row === 0 ? -0.42 : 1.0, face = row === 0 ? 0 : Math.PI;
        const dg = new THREE.Group(); dg.position.set(x, FL, z); dg.rotation.y = face; g.add(dg); dg.updateMatrixWorld(true);
        furnish(dg, 'Desk', 0, 0, 0);
        furnish(dg, 'Monitor', 0, -0.17 * S, 0, 0xffffff, 0.74 * S);
        furnish(dg, 'Keyboard', 0, 0.14 * S, 0, 0xffffff, 0.74 * S);
        if ((i + p.slug.length) % 3 === 0) furnish(dg, 'Mug', 0.42 * S, 0.08 * S, 0.5, 0xffffff, 0.74 * S);
        if ((i + p.slug.length) % 4 === 1) furnish(dg, 'Notebook', -0.45 * S, 0.06 * S, -0.3, 0xffffff, 0.74 * S);
        furnish(dg, 'Chair', 0, 0.58 * S, Math.PI, fabric);
        const screen = new THREE.Mesh(screenGeo, M.screenOff); screen.scale.setScalar(S); screen.position.set(0, 0.74 * S, -0.17 * S); screen.userData.dynamic = true; dg.add(screen);
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.4), new THREE.MeshBasicMaterial({ map: glowTex, color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.rotation.x = -Math.PI / 2; glow.position.set(0, 0.74 * S + 0.004, 0); dg.add(glow);
        return { a, group: dg, screen, glow, seat: new THREE.Vector3(0, 0, 0.5 * S) };
      });
      furnish(g, 'Board', pw / 2 - 0.09, pd / 2 - 0.62, -Math.PI / 2, 0xffffff, FL);
      p.pilotSpot = new THREE.Vector3(pw / 2 - 0.5, FL, pd / 2 - 0.62);
      const inner = new THREE.Mesh(new THREE.PlaneGeometry(pw - 0.2, pd - 0.2), new THREE.MeshBasicMaterial({ map: glowTex, color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      inner.rotation.x = -Math.PI / 2; inner.position.y = 0.09; g.add(inner); p.inner = inner;
      const hit = new THREE.Mesh(new THREE.BoxGeometry(pw, 0.9, pd), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 0.45; projectOfHit.set(hit, p); g.add(hit); pavHit.push(hit);
    }
    for (const [piece, list] of placements) {
      const rootObj = KIT.get(piece); if (!rootObj) continue;
      rootObj.updateMatrixWorld(true);
      const inv = rootObj.matrixWorld.clone().invert();
      rootObj.traverse(o => {
        if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
        const local = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
        const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
        const tinted = o.material.name === 'Fabric';
        list.forEach((it, k) => { im.setMatrixAt(k, new THREE.Matrix4().multiplyMatrices(it.m, local)); im.setColorAt(k, tinted ? it.c : new THREE.Color(0xffffff)); });
        im.castShadow = piece !== 'Rug'; im.receiveShadow = true; im.userData.dynamic = true;
        group.add(im);
      });
    }

    /* --- Central rotunda and beacon tower --- */
    const hub = new THREE.Group(); group.add(hub);
    ([[R_HUB, 0.3, -0.25], [R_HUB - 0.9, 0.3, 0.05], [R_HUB - 1.7, 0.3, 0.35]] as const).forEach(([r, h, y]) => {
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.05, h, 96), M.white); tier.position.y = y; tier.castShadow = tier.receiveShadow = true; hub.add(tier);
    });
    const HUB_TOP = 0.5;
    for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; hub.add(box(0.07, 1.6, 0.07, M.white, Math.cos(a) * (R_HUB - 1.85), HUB_TOP + 0.8, Math.sin(a) * (R_HUB - 1.85))); }
    const crown = new THREE.Mesh(new THREE.TorusGeometry(R_HUB - 1.85, 0.07, 10, 96), M.white); crown.rotation.x = Math.PI / 2; crown.position.y = HUB_TOP + 1.62; crown.castShadow = true; hub.add(crown);
    const SPIRE_H = 6.4, TOP = HUB_TOP + SPIRE_H;
    let eyeLight: THREE.PointLight | null = null;
    if (MORDOR) {                                     // crown of the dark tower: black points and horns around the top, red glow
      const obs = new THREE.MeshStandardMaterial({ color: 0x121010, roughness: 0.55, metalness: 0.3, emissive: 0x2a0703 });
      for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2, h = i % 3 ? 0.9 : 1.6, c = new THREE.Mesh(new THREE.ConeGeometry(0.11, h, 6), obs);
        c.position.set(Math.cos(a) * 0.55, TOP + h / 2 - 0.1, Math.sin(a) * 0.55); c.rotation.z = -Math.cos(a) * 0.25; c.rotation.x = Math.sin(a) * 0.25; c.castShadow = true; c.userData.dynamic = true; hub.add(c); }
      for (const sx of [-1, 1]) { const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 2.6, 7), obs); horn.position.set(sx * 0.7, TOP + 1.1, 0); horn.rotation.z = -sx * 0.32; horn.castShadow = true; horn.userData.dynamic = true; hub.add(horn); }
      eyeLight = new THREE.PointLight(0xff5a1a, 22, 34, 2); eyeLight.position.set(0, TOP + 2.2, 0); hub.add(eyeLight);
    }
    { const core = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.62, SPIRE_H, 48), M.white); core.position.y = HUB_TOP + SPIRE_H / 2; core.castShadow = core.receiveShadow = true; hub.add(core); }
    for (let i = 0; i < 7; i++) {
      const y = HUB_TOP + 0.9 + i * 0.8, r = 1.05 - i * 0.07;
      const fin = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.045, 64), M.white); fin.position.y = y; fin.castShadow = fin.receiveShadow = true; hub.add(fin);
    }
    { const plat = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 0.5, 0.16, 64), M.white); plat.position.y = TOP; plat.castShadow = plat.receiveShadow = true; hub.add(plat); }
    const holoMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.6, 1.7), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false });
    const orbitRings = [1.7, 2.3, 2.9].map((r, i) => { const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 128), holoMat.clone()); ring.rotation.x = Math.PI / 2 + (i - 1) * 0.18; ring.position.y = TOP - 1.2 - i * 1.4; hub.add(ring); return ring; });
    const satellites: Satellite[] = orbitRings.map((ring, i) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(2.2, 2.0, 1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.scale.setScalar(0.5); hub.add(s);
      return { s, ring, r: ring.geometry.parameters.radius, speed: 0.45 - i * 0.1, ph: i * 2.1 };
    });
    const hero = agents.find(a => a.kind === 'central' && a.main) ?? agents.find(a => a.kind === 'central') ?? null;
    const beaconAvatar = new THREE.Sprite(new THREE.SpriteMaterial({ map: avatarTexture(hero && iconOf(hero), '#1d1d1f', hero ? hero.name : 'Citadel'), alphaTest: 0.5 }));
    beaconAvatar.scale.setScalar(1.7); beaconAvatar.material.color.setScalar(0.82); hub.add(beaconAvatar);
    const beaconRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color: new THREE.Color(1.2, 1.2, 1.2), transparent: true, depthWrite: false }));
    beaconRing.scale.setScalar(2.1); beaconRing.renderOrder = -1; hub.add(beaconRing);

    // Central mirror pool: reflects the tower, walkways and flows (not the figures)
    const lava = MORDOR ? lavaLake(R_IN - 0.55) : null;
    const pool: THREE.Object3D = lava ?? new Reflector(new THREE.CircleGeometry(R_IN - 0.55, 128), { textureWidth: 768, textureHeight: 768, color: 0xc4c9d0, multisample: 2 });
    pool.rotation.x = -Math.PI / 2; pool.position.y = -0.385; pool.userData.dynamic = true; group.add(pool);
    { const rim = new THREE.Mesh(new THREE.TorusGeometry(R_IN - 0.55, 0.06, 8, 160), M.white); rim.rotation.x = Math.PI / 2; rim.position.y = -0.37; rim.receiveShadow = true; group.add(rim); }

    // Data flows on the walkways
    for (const d of spaces) {
      const len = R_IN - R_HUB;
      const flowMat = new THREE.ShaderMaterial({
        uniforms: { time: { value: 0 }, amount: { value: 0 }, color: { value: new THREE.Color(1, 1, 1) } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
        fragmentShader: `uniform float time, amount; uniform vec3 color; varying vec2 vUv;
          void main(){
            float band = smoothstep(0.5, 0.05, abs(vUv.y - 0.5));
            float d = fract(vUv.x * 7.0 - time * 0.9);
            float dash = smoothstep(0.0, 0.04, d) * smoothstep(0.32, 0.06, d);
            float a = (0.12 + dash * 1.4) * band * amount;
            gl_FragColor = vec4(color * a, a);
          }`,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.62, 1, 1), flowMat);
      const c = polar((R_HUB + R_IN) / 2, d.mid); m.position.set(c.x, -0.33, c.z); m.rotation.set(-Math.PI / 2, 0, -d.mid); group.add(m);
      streams.set(d.key, bindUniforms(flowMat, ['time', 'amount', 'color'] as const));
    }

    /* --- Agent figures --- */
    group.updateMatrixWorld(true);
    const centralList = agents.filter(a => a.kind === 'central' && a !== hero);
    const centralSpot = (i: number): { r: number; a: number; y: number } | null => i < 9 ? { r: 1.7, a: i / 9 * Math.PI * 2, y: HUB_TOP } : i < 25 ? { r: 3.0, a: (i - 9) / 16 * Math.PI * 2, y: 0.2 } : null;
    const figs: THREE.Group[] = [];
    for (const a of agents) {
      let home: THREE.Vector3 | null = null, homeFace = 0, big = 1;
      if (a === hero) { home = new THREE.Vector3(0, TOP + 0.08, 0.45); big = 1.9; }
      else if (a.kind === 'central') { const sp = centralSpot(centralList.indexOf(a)); if (sp) { home = polar(sp.r, sp.a, sp.y); homeFace = Math.atan2(-home.x, -home.z) + Math.PI; } }
      else if (a.kind === 'captain') { const d = a.space; if (d && !d.captain) { d.captain = a; home = d.podium.clone().setY(0.16); homeFace = Math.atan2(-d.podium.x, -d.podium.z); big = 1.45; } }
      else if (a.p && a.p.pilot === a) { home = a.p.g.localToWorld(a.p.pilotSpot.clone()); homeFace = a.p.g.rotation.y + Math.PI / 2; }
      else if (a.p) {
        const i = a.p.crew.indexOf(a), d = a.p.desks[i], bench = a.p.bench[i];
        if (d && bench) {
          a.desk = d; a.deskFace = a.p.g.rotation.y + d.group.rotation.y + Math.PI;
          a.benchPos = a.p.g.localToWorld(bench.clone()); a.benchFace = a.p.g.rotation.y;
          // At work, the Tim stands next to its desk (the chair stays empty), facing outwards like on the bench
          a.deskPos = d.group.localToWorld(d.seat.clone()).add(new THREE.Vector3(0.5, 0, 0).applyAxisAngle(UP, a.deskFace)); a.deskPos.y = a.benchPos.y;
          home = a.benchPos; homeFace = a.benchFace;
        }
      }
      if (!home) continue; // too many central agents for the rotunda: counted in the interface, not modelled
      a.big = big; a.home = home; a.homeFace = homeFace; a.baseY = home.y; a.phase = Math.random() * 6;
      const f = new THREE.Group();
      const t3 = tims3d.make(a.look, { height: TIM_H * big, seed: seedOf(a.name) });
      t3.object.traverse(o => o.layers.set(1));       // layer 1: kept out of the pool reflection
      f.add(t3.object);
      const hh = 0.8 * big, hb = new THREE.Mesh(new THREE.CylinderGeometry(0.2 * big, 0.2 * big, hh, 8), new THREE.MeshBasicMaterial({ visible: false })); hb.position.y = hh / 2; agentOfHit.set(hb, a); f.add(hb); figHit.push(hb);
      figs.push(f);     // added after mergeStatic: Tim visors and accessories must not be merged into the scenery
      a.fig = f; a.t3 = t3; a.doneUntil = 0;
      if (big > 1) { const bs = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.08, 32), M.white); bs.position.set(home.x, home.y - 0.04, home.z); bs.castShadow = bs.receiveShadow = true; group.add(bs); }
      f.position.copy(home); f.rotation.y = homeFace;
      if (a.desk && a.state !== 'rest') { f.position.copy(a.deskPos); f.rotation.y = a.benchFace; a.atDesk = true; a.homeFace = a.benchFace; }
    }
    const figAgents = agents.filter((a): a is FigAgent => a.fig !== null && a.t3 !== null);
    const merged = mergeStatic(group);
    figs.forEach(f => group.add(f));
    const mordor = MORDOR ? mordorDecor(group, { R_IN, R_OUT, TOP }) : null;
    let embers: THREE.Points | null = null, ash: THREE.Points | null = null;
    if (MORDOR) {                                     // embers: sparks slowly rise above the model
      const N = 420, pos = new Float32Array(N * 3), seed = new Float32Array(N);
      for (let i = 0; i < N; i++) { const r = Math.sqrt(Math.random()) * R_OUT * 1.15, a = Math.random() * 6.283; pos.set([Math.cos(a) * r, Math.random() * 14, Math.sin(a) * r], i * 3); seed[i] = Math.random(); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
      const m = new THREE.PointsMaterial({ map: glowTex, color: new THREE.Color(2.2, 0.75, 0.25), size: 0.32, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
      embers = new THREE.Points(g, m); embers.userData.dynamic = true; embers.frustumCulled = false; group.add(embers);
      const AN = 520, apos = new Float32Array(AN * 3); for (let i = 0; i < AN; i++) { const r = Math.sqrt(Math.random()) * R_OUT * 1.4, a = Math.random() * 6.283; apos.set([Math.cos(a) * r, Math.random() * 18, Math.sin(a) * r], i * 3); }
      const ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.BufferAttribute(apos, 3));
      ash = new THREE.Points(ag, new THREE.PointsMaterial({ color: 0x6d6560, size: 0.09, transparent: true, opacity: 0.55, depthWrite: false, fog: true }));
      ash.userData.dynamic = true; ash.frustumCulled = false; group.add(ash);
    }
    return {
      group, model: mdl, spaces, projects, agents, figAgents, A, P, streams, pulses, pavHit, figHit, satellites, orbitRings,
      hero, heroChip: null, RING, R_IN, R_OUT, TOP, homeView, beaconAvatar, beaconRing, merged, mordor, eyeLight,
      lavaTime: lava ? bindUniforms(lava.material, ['time'] as const).time : null, embers, ash,
      colorOf, iconOf, labelOf,
    };
  }

  // Static scenery merged by material: a few draw calls instead of over a thousand
  function mergeStatic(rootObj: THREE.Object3D): number {
    rootObj.updateMatrixWorld(true);
    const groups = new Map<string, { mat: THREE.Material; cast: boolean; recv: boolean; geos: THREE.BufferGeometry[] }>();
    const kill: THREE.Mesh[] = [];
    rootObj.traverse(o => {
      if (!(o instanceof THREE.Mesh) || o instanceof THREE.SkinnedMesh || o instanceof THREE.InstancedMesh || o.userData.dynamic || Array.isArray(o.material)) return;
      const mat: THREE.Material & { map?: THREE.Texture | null } = o.material;
      if (!mat.visible || mat.transparent || mat.map) return;
      let vis = true; o.traverseAncestors(a => { if (!a.visible) vis = false; }); if (!vis || !o.visible) return;
      const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      g.morphAttributes = {};
      const k = mat.uuid + (o.castShadow ? 'c' : '') + (o.receiveShadow ? 'r' : '');
      let entry = groups.get(k);
      if (!entry) { entry = { mat, cast: o.castShadow, recv: o.receiveShadow, geos: [] }; groups.set(k, entry); }
      entry.geos.push(g); kill.push(o);
    });
    kill.forEach(o => { o.parent?.remove(o); if (!shared.has(o.geometry)) o.geometry.dispose(); });
    for (const { mat, cast, recv, geos } of groups.values()) {
      const merged = mergeGeometries(geos);
      if (merged) { const m = new THREE.Mesh(merged, mat); m.castShadow = cast; m.receiveShadow = recv; m.matrixAutoUpdate = false; rootObj.add(m); }
      geos.forEach(g => g.dispose());
    }
    return kill.length;
  }

  /* ---------- Agent animation ---------- */
  // Tims are animated by the engine (setState): no walk clips or sitting pose.
  const travelTo = (a: AgentNode, pos: THREE.Vector3, face: number): void => { a.path = { to: pos.clone(), face }; };
  function pulse(w: World, from: THREE.Vector3, to: THREE.Vector3, color = new THREE.Color(1.4, 1.4, 1.4)): void {
    const pts = [from, to].map(v => v.clone().setY(Math.max(0.1, v.y + 0.05)));
    const [p0, p1] = pts;
    if (!p0 || !p1 || p0.distanceTo(p1) < 0.01) return;
    const path = new THREE.CurvePath<THREE.Vector3>(); path.add(new THREE.LineCurve3(p0, p1));
    const N = 140, line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.getSpacedPoints(N)), new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false }));
    line.geometry.setDrawRange(0, 0);
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: color.clone().multiplyScalar(1.4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    head.scale.setScalar(0.55);
    w.group.add(line, head); w.pulses.push({ line, head, path, N, t: 0, len: path.getLength() });
  }
  // Applies a new state (from polling) to an already modelled agent
  function setState(w: World, a: AgentNode, next: ModelAgent): void {
    const changed = a.state !== next.state;
    if (changed && a.state === 'work' && next.state === 'rest') a.doneUntil = performance.now() / 1000 + 3;
    Object.assign(a, { state: next.state, text: next.text, since: next.since, missionId: next.missionId });
    if (!a.fig || !changed) return;
    if (a.desk) {
      if (next.state === 'rest') travelTo(a, a.benchPos, a.benchFace); else if (!a.atDesk) travelTo(a, a.deskPos, a.benchFace);
      const lead = a.p?.pilot;
      if (lead?.fig) { if (next.state === 'rest') pulse(w, a.deskPos, lead.fig.position); else pulse(w, lead.fig.position, a.deskPos); }
    }
  }

  /* ================================================================== */
  /* Camera                                                              */
  /* ================================================================== */
  let fly: { t: number; dur: number; fromT: THREE.Vector3; toT: THREE.Vector3; fromP: THREE.Vector3; toP: THREE.Vector3 } | null = null;
  let touring = false, tourT = 0, tourI = 0;
  const tourBtn = $('.at-tour');
  const flyTo = (toT: THREE.Vector3, toP: THREE.Vector3, dur = 1.6): void => { fly = { t: 0, dur, fromT: controls.target.clone(), toT, fromP: camera.position.clone(), toP }; };
  function focusOn(pt: THREE.Vector3, dist: number): void {
    const dir = camera.position.clone().sub(controls.target).setY(0); if (dir.lengthSq() < 0.01) dir.set(0, 0, 1); dir.normalize();
    flyTo(pt.clone().setY(0), pt.clone().setY(0).add(dir.multiplyScalar(dist * 0.6)).setY(dist * 0.8));
  }
  const goHome = (): void => { if (world) flyTo(world.homeView.target.clone(), world.homeView.pos.clone()); };
  function focusSpace(d: SpaceNode, dist = 15, dur = 1.8): void {
    const c = d.center.clone().setY(0), inward = c.clone().negate().normalize();
    flyTo(c.clone(), c.clone().addScaledVector(inward, dist * 0.62).setY(dist * 0.72), dur);
  }
  const spaceDist = (w: World, d: SpaceNode): number => Math.max(14, (d.a1 - d.a0) * w.RING * 0.75);
  const activeCount = (w: World, d: SpaceNode): number => w.agents.filter(a => a.space === d && a.kind !== 'central' && a.state !== 'rest').length;
  const busiest = (w: World): SpaceNode | undefined => w.spaces.slice().sort((x, y) => activeCount(w, y) - activeCount(w, x))[0];
  const stopTour = (): void => { touring = false; tourBtn.classList.remove('at-on'); };
  const onControlsStart = (): void => { fly = null; stopTour(); };
  controls.addEventListener('start', onControlsStart);
  tourBtn.onclick = () => { if (!world) return; touring = !touring; tourBtn.classList.toggle('at-on', touring); tourT = 0; if (!touring) goHome(); };
  $('.at-home').onclick = () => { stopTour(); select(null); goHome(); };

  /* ================================================================== */
  /* Interface                                                           */
  /* ================================================================== */
  const agPic = (w: World, a: AgentNode, size: number): string => picHTML(w.iconOf(a), w.colorOf(a), w.labelOf(a), size);
  const prjPic = (p: ProjectNode, size: number): string => picHTML(p.icon, p.color, p.name, size);
  /** The summary of a project, with its agents resolved to scene nodes. */
  interface NodeSummary { m: AgentNode[]; act: AgentNode[]; w: AgentNode[]; e: AgentNode[]; line: string }
  const summary = (w: World, p: ProjectNode): NodeSummary => {
    const mp = w.model.projects.find(x => x.slug === p.slug);
    const s: ProjectSummary = mp ? summarize(w.model, mp) : { m: [], act: [], w: [], e: [], line: '' };
    const nodes = (list: ModelAgent[]): AgentNode[] => list.map(a => w.A.get(a.name)).filter((a): a is AgentNode => a !== undefined);
    return { m: nodes(s.m), act: nodes(s.act), w: nodes(s.w), e: nodes(s.e), line: s.line };
  };
  const inSpace = (w: World, d: SpaceNode, noCentral = true): AgentNode[] => w.agents.filter(a => a.space === d && (!noCentral || a.kind !== 'central'));
  function renderHud(): void {
    const w = world;
    if (!w) return;
    const ags = w.agents, c: Record<AgentStateName, number> = { work: 0, wait: 0, err: 0, rest: 0 }; ags.forEach(a => { c[a.state]++; });
    el.status.innerHTML = `<span class="at-k"><b>${c.work}</b>${esc(tr('working'))}</span><span class="at-w"><b>${c.wait}</b>${esc(tr('waitingYou'))}</span><span class="at-e"><b>${c.err}</b>${esc(tr('incidents', { count: c.err }))}</span><span><b>${ags.length}</b>${esc(tr('agents'))}</span>`;
    $('.at-dlist').innerHTML = w.spaces.map(d => {
      const ag = inSpace(w, d), act = ag.filter(a => a.state !== 'rest');
      return `<button class="at-dist ${selSpace === d ? 'at-on' : ''}" data-d="${esc(d.key)}"><div class="at-row"><span class="at-name">${esc(d.name)}</span><span class="at-n">${act.length} / ${ag.length}</span></div>
      <div class="at-icons">${d.projects.map(p => { const s = summary(w, p); const cls = s.w.length ? 'at-st-w' : s.e.length ? 'at-st-e' : s.act.length ? 'at-st-on' : ''; return prjPic(p, 18).replace(/class="(at-av|at-mono)"/, `class="$1 ${cls}" title="${esc(p.name)}"`); }).join('')}</div></button>`;
    }).join('');
    wrap.querySelectorAll<HTMLElement>('.at-dist').forEach(b => b.onclick = () => { const d = w.spaces.find(s => s.key === b.dataset.d); if (!d) return; selSpace = d; stopTour(); focusSpace(d, spaceDist(w, d)); renderHud(); });
    const waiting = ags.filter(a => a.state === 'wait').sort((x, y) => y.since - x.since);
    const first = waiting[0];
    if (first) {
      $('.at-tpic').innerHTML = `<span class="at-ring" style="display:block">${agPic(w, first, 26)}</span>`;
      $('.at-who').textContent = first.name;
      $('.at-what').textContent = (first.text || tr('waitsYou')).slice(0, 90) + (waiting.length > 1 ? ` · +${waiting.length - 1}` : '');
      $('.at-btn').onclick = () => openChat(first); $('.at-btn').textContent = tr('open');
      el.toast.classList.add('at-on');
    } else el.toast.classList.remove('at-on');
    renderCard(w); renderBadges(w); renderChips(w);
    showNotice(!ags.length || !w.projects.length ? tr('nothing') : '');
  }
  function renderCard(w: World): void {
    const p = selProject;
    if (!p) { el.card.classList.remove('at-on'); return; }
    const s = summary(w, p);
    $('.at-cpic').innerHTML = prjPic(p, 40);
    $('.at-ceye').textContent = p.space.name; $('.at-card .at-t').textContent = p.name;
    $('.at-card .at-s').textContent = tr('activeOf', { active: s.act.length, total: s.m.length });
    const order: Record<AgentStateName, number> = { wait: 0, err: 1, work: 2, rest: 3 };
    $('.at-list').innerHTML = [...s.m].sort((x, y) => order[x.state] - order[y.state]).map(a => `<button class="at-ag ${a === selAgent ? 'at-on' : ''}" data-a="${esc(a.name)}">
      <span class="at-pic">${agPic(w, a, 30)}<i style="background:${COL[a.state]}"></i></span>
      <span><div class="at-nm">${esc(a.name)}</div><div class="at-tx">${esc(a.state === 'rest' ? (roleLabel(a.role) || a.role || tr('free')) : a.text || tr('working'))}</div></span></button>`).join('');
    wrap.querySelectorAll<HTMLElement>('.at-list .at-ag').forEach(b => { b.title = tr('openChat'); b.onclick = () => openChat(w.A.get(b.dataset.a ?? '')); });
    el.card.classList.add('at-on');
  }
  // Opens the agent's Timon conversation: the mission that explains its state, else the project chat
  function chatUrl(a: AgentNode): string {
    if (a.missionId) return '/chat?mission=' + encodeURIComponent(a.missionId);
    if (a.project && !a.project.startsWith('@')) return '/chat?project=' + encodeURIComponent(a.project);
    return '/chat';
  }
  function openChat(a: AgentNode | undefined): void { if (a) window.location.assign(chatUrl(a)); }
  function select(p: ProjectNode | null, a: AgentNode | null = null): void {
    selProject = p; selAgent = a; stopTour();
    if (world) {
      if (a?.fig) focusOn(a.fig.position, 10); else if (p) focusOn(new THREE.Vector3(p.x, 0, p.z), Math.max(12, p.W * 2.4));
      renderHud();
    }
  }
  $('.at-close').onclick = () => select(null);

  const jRows: string[] = [];
  function journalAdd(w: World | null, rows: JournalRow[]): void {
    for (const r of rows) {
      const a = w?.A.get(r.name);
      jRows.push(`<div class="at-r"><span class="at-tm">${fmt(new Date(r.at))}</span>${a && w ? agPic(w, a, 16) : ''}<span><b>${esc(r.name)}</b> ${esc(r.text)}</span></div>`);
    }
    while (jRows.length > 4) jRows.shift();
    $('.at-rows').innerHTML = jRows.join('') || `<div class="at-r"><span class="at-empty">${esc(tr('noChange'))}</span></div>`;
  }
  $('.at-rows').innerHTML = `<div class="at-r"><span class="at-empty">${esc(tr('noChange'))}</span></div>`;

  /* ---------- Project badges and labels ---------- */
  const v3 = new THREE.Vector3();
  function renderBadges(w: World): void {
    for (const p of w.projects) {
      if (!p.badge) {
        const b = document.createElement('div'); b.className = 'at-badge';
        b.innerHTML = `<span class="at-pic">${prjPic(p, 30)}<span class="at-cnt" style="display:none"></span></span><span class="at-txt"><b>${esc(p.name)}</b><span></span></span>`;
        b.onclick = () => select(p); labelsEl.appendChild(b); p.badge = b;
      }
      const s = summary(w, p), pic = p.badge.querySelector<HTMLElement>('.at-pic'), cnt = p.badge.querySelector<HTMLElement>('.at-cnt'), txt = p.badge.querySelector<HTMLElement>('.at-txt span');
      if (pic) pic.className = 'at-pic' + (s.w.length ? ' at-ring-wait' : s.e.length ? ' at-ring-err' : s.act.length ? ' at-ring-work' : '');
      const n = s.w.length || s.e.length || s.act.length;
      if (cnt) { cnt.style.display = n ? '' : 'none'; cnt.textContent = String(n); cnt.className = 'at-cnt' + (s.w.length ? ' at-w' : s.e.length ? ' at-e' : ''); }
      if (txt) txt.textContent = s.line;
      measOf(p.badge).w = null;
    }
  }
  const chip = (cls: string, onClick: () => void): HTMLElement => { const d = document.createElement('div'); d.className = 'at-dchip ' + cls; d.onclick = onClick; labelsEl.appendChild(d); return d; };
  function renderChips(w: World): void {
    if (!w.heroChip) w.heroChip = chip('at-hero', () => { stopTour(); select(null); focusOn(new THREE.Vector3(0, 0, 0), 16); });
    const h = w.hero;
    w.heroChip.style.display = h ? '' : 'none';
    if (h) w.heroChip.innerHTML = `${agPic(w, h, 40)}<span><b>${esc(h.name)}</b><small>${esc(h.state === 'rest' ? tr('central') : h.text || tr('working'))}</small></span>`;
    measOf(w.heroChip).w = null;
    for (const d of w.spaces) {
      if (!d.chip) d.chip = chip('', () => { selSpace = d; stopTour(); focusSpace(d, spaceDist(w, d)); renderHud(); });
      const ag = inSpace(w, d), act = ag.filter(a => a.state !== 'rest').length, nw = ag.filter(a => a.state === 'wait').length, ne = ag.filter(a => a.state === 'err').length;
      const first = d.projects[0];
      const pic = d.captain ? agPic(w, d.captain, 28) : first ? prjPic(first, 28) : '';
      d.chip.innerHTML = `${pic}<span><b>${esc(d.name)}</b><small>${esc(tr('activeShort', { active: act, total: ag.length }))}${nw ? ` · <span class="at-w">${esc(tr('waitFor', { count: nw }))}</span>` : ''}${ne ? ` · <span class="at-e">${ne} ${esc(tr('incidents', { count: ne }))}</span>` : ''}</small></span>`;
      measOf(d.chip).w = null;
    }
  }
  let frameN = 0, obst: Rect[] | null = null;
  function placeSays(w: World, placed: Rect[], vw: number, vh: number): void {
    const cand = w.figAgents.filter(a => a.state !== 'rest' && !a.path).map(a => ({ a, d: camera.position.distanceTo(a.fig.position) })).filter(o => o.d < 17)
      .sort((x, y) => Number(x.a.state === 'work') - Number(y.a.state === 'work') || x.d - y.d).slice(0, 12);
    const keep = new Set(cand.map(o => o.a));
    for (const [a, e] of says) if (!keep.has(a as FigAgent)) { e.remove(); says.delete(a); }
    for (const { a } of cand) {
      let e = says.get(a);
      if (!e) { e = document.createElement('div'); e.className = 'at-say'; e.title = tr('openChat'); e.onclick = () => openChat(a); labelsEl.appendChild(e); says.set(a, e); }
      const m = measOf(e);
      const html = `<i style="background:${COL[a.state]}"></i>${esc(a.text || (a.state === 'wait' ? tr('waitsYou') : tr('atWork')))}`;
      if (m.html !== html) { m.html = html; e.innerHTML = html; e.className = 'at-say' + (a.state === 'wait' ? ' at-w' : a.state === 'err' ? ' at-e' : ''); m.w = null; }
      v3.copy(a.fig.position).setY(a.fig.position.y + 0.8 * a.big).project(camera);
      if (v3.z > 1) { e.style.visibility = 'hidden'; continue; }
      if (m.w === null) { m.w = e.offsetWidth; m.h = e.offsetHeight; }
      const x = (v3.x * 0.5 + 0.5) * vw, y = (-v3.y * 0.5 + 0.5) * vh;
      let top = y - m.h, r: Rect = [0, 0, 0, 0], ok = false;
      for (let k = 0; k < 4 && !ok; k++, top -= m.h * 0.75) { r = [x - m.w / 2, top, x + m.w / 2, top + m.h]; ok = !placed.some(o => overlaps(r, o)); }
      e.style.visibility = ok ? 'visible' : 'hidden';
      if (ok) { placed.push(r); e.style.transform = `translate(${Math.round(r[0])}px, ${Math.round(r[1])}px)`; }
    }
  }
  function placeBadges(w: World): void {
    const vw = W(), vh = H();
    const dist = camera.position.distanceTo(controls.target), big = dist < 42 * w.homeView.k;
    const items = w.projects.map(p => {
      p.anchor ??= polar(w.RING + p.D / 2, p.angle, 0.9);
      v3.copy(p.anchor).project(camera);
      return { p, x: (v3.x * 0.5 + 0.5) * vw, y: (-v3.y * 0.5 + 0.5) * vh, ok: v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1 };
    });
    const rank = (it: { p: ProjectNode }): number => { const s = summary(w, it.p); return it.p === selProject ? 0 : s.w.length ? 1 : s.e.length ? 2 : s.act.length ? 3 : 4; };
    items.sort((a, b) => rank(a) - rank(b));
    // UI panels are obstacles; their rectangles are only re-read twice a second (they force a layout)
    if (!obst || frameN % 30 === 0) {
      const o0 = root.getBoundingClientRect();
      obst = [el.brand, el.status, el.controls, el.districts, el.journal, el.toast, el.card].filter(e => (e !== el.toast && e !== el.card) || e.classList.contains('at-on'))
        .map((e): Rect => { const b = e.getBoundingClientRect(); return [b.left - o0.left - 6, b.top - o0.top - 6, b.right - o0.left + 6, b.bottom - o0.top + 6]; });
    }
    const placed = obst.slice();
    const offScreen = (r: Rect): boolean => r[0] < 4 || r[1] < 4 || r[2] > vw - 4 || r[3] > vh - 4;
    const putChip = (e: HTMLElement, pos: THREE.Vector3): void => {
      v3.copy(pos).project(camera);
      const x = (v3.x * 0.5 + 0.5) * vw, y = (-v3.y * 0.5 + 0.5) * vh, m = measOf(e);
      if (m.w === null) { m.w = e.offsetWidth; m.h = e.offsetHeight; }
      const r: Rect = [x - m.w / 2, y - m.h, x + m.w / 2, y];
      const hide = v3.z > 1 || offScreen(r) || placed.some(o => overlaps(r, o));
      e.style.visibility = hide ? 'hidden' : 'visible';
      if (!hide) { placed.push(r); e.style.transform = `translate(${Math.round(r[0])}px, ${Math.round(r[1])}px)`; }
    };
    if (w.hero && w.heroChip) putChip(w.heroChip, new THREE.Vector3(0, w.TOP + 3.6, 0));
    placeSays(w, placed, vw, vh);
    for (const d of w.spaces) if (d.chip) putChip(d.chip, d.podium.clone().setY(1.5));
    for (const it of items) {
      const e = it.p.badge; if (!e) continue;
      if (!it.ok) { e.style.visibility = 'hidden'; continue; }
      const m = measOf(e);
      e.classList.toggle('at-big', big || it.p === selProject);
      if (m.w === null || m.big !== e.classList.contains('at-big')) { m.big = e.classList.contains('at-big'); m.w = e.offsetWidth; m.h = e.offsetHeight; }
      const r: Rect = [it.x - (m.w ?? 0) / 2, it.y - m.h, it.x + (m.w ?? 0) / 2, it.y];
      const clash = placed.some(o => overlaps(r, o, 4));
      if (clash && e.classList.contains('at-big') && it.p !== selProject) { e.classList.remove('at-big'); m.w = e.offsetWidth; m.h = e.offsetHeight; r[0] = it.x - m.w / 2; r[2] = it.x + m.w / 2; r[1] = it.y - m.h; }
      const clash2 = placed.some(o => overlaps(r, o));
      const hide = clash2 || offScreen(r);
      e.style.visibility = hide ? 'hidden' : 'visible';
      if (!hide) placed.push(r);
      e.style.transform = `translate(${Math.round(r[0])}px, ${Math.round(r[1])}px)`;
    }
  }

  /* ---------- Hover and click ---------- */
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(); ray.layers.enableAll();
  let downAt: [number, number] | null = null;
  const onMove = (e: PointerEvent): void => {
    const w = world;
    if (!w) return;
    const b = canvas.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    mouse.set(x / b.width * 2 - 1, -y / b.height * 2 + 1); ray.setFromCamera(mouse, camera);
    const agentHit = ray.intersectObjects(w.figHit)[0]?.object;
    hover = agentHit ? agentOfHit.get(agentHit) ?? null : null;
    const projectHit = hover ? undefined : ray.intersectObjects(w.pavHit)[0]?.object;
    hoverP = projectHit ? projectOfHit.get(projectHit) ?? null : null;
    canvas.style.cursor = hover || hoverP ? 'pointer' : '';
    if (hover) {
      tip.style.display = 'flex'; tip.style.left = x + 14 + 'px'; tip.style.top = y + 12 + 'px';
      tip.innerHTML = `${agPic(w, hover, 26)}<span><b>${esc(hover.name)}</b><br><span style="color:var(--ink-2)">${esc(hover.state === 'rest' ? (roleLabel(hover.role) || hover.role || tr('agentFallback')) + ' · ' + tr('free') : hover.text || tr('working'))}</span></span>`;
    } else tip.style.display = 'none';
  };
  const onDown = (e: PointerEvent): void => { downAt = [e.clientX, e.clientY]; };
  const onUp = (e: PointerEvent): void => {
    if (!downAt || !world || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    if (hover) select(hover.p, hover); else if (hoverP) select(hoverP); else if (selProject) select(null);
  };
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);

  /* ================================================================== */
  /* Live state polling                                                  */
  /* ================================================================== */
  let prevModel: Model | null = null, stateSig = '', inflight = false, pollTimer: ReturnType<typeof setInterval> | undefined;
  const liveEl = $('.at-live');
  let lastErrors: string[] = [];
  function applyHomeIntro(w: World): void {
    camera.position.set(-70 * w.homeView.k, 95 * w.homeView.k, 120 * w.homeView.k); controls.target.set(0, 0, 0);
    const d = busiest(w);
    if (d) { selSpace = d; focusSpace(d, spaceDist(w, d), 4.2); } else goHome();
  }
  function ingest(st: StateInput): void {
    const next = buildModel(st, Date.now());
    const rows = transitions(prevModel, next);
    const k = structureKey(next);
    const rebuilt = !world || k !== worldKey;
    let w = world;
    if (!w || rebuilt) {
      destroyWorld();
      w = buildWorld(next); world = w; worldKey = k;
      if (!introDone) { applyHomeIntro(w); introDone = true; }
      for (const a of next.agents) { const node = w.A.get(a.name); if (node) Object.assign(node, { state: a.state, text: a.text, since: a.since, missionId: a.missionId }); }
    } else {
      w.model = next;
      for (const a of next.agents) { const node = w.A.get(a.name); if (node) setState(w, node, a); }
    }
    prevModel = next;
    const sig = next.agents.map(a => a.name + a.state + a.text).join('|');
    if (rebuilt || sig !== stateSig) { stateSig = sig; journalAdd(w, rows); renderHud(); }
    else if (rows.length) journalAdd(w, rows);
    lastErrors = st.errors ?? [];
    if (lastErrors.length) liveEl.title = lastErrors.join('\n'); else liveEl.removeAttribute('title');
  }
  async function poll(): Promise<void> {
    if (inflight || disposed) return;
    inflight = true;
    try {
      const r = await api('state');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const st = await r.json() as StateInput;
      if (disposed) return;
      ingest(st);
      liveEl.classList.remove('off');
    } catch {
      if (disposed) return;
      liveEl.classList.add('off');
      if (!world) showNotice(tr('unavailable'));
    } finally { inflight = false; }
  }
  await poll();
  if (disposed) return () => {};
  pollTimer = setInterval(() => { void poll(); }, POLL_MS);

  /* ================================================================== */
  /* Loop                                                                */
  /* ================================================================== */
  function resize(): void {
    const w = W(), h = H();
    renderer.setSize(w, h, false); composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h);
    const pr = renderer.getPixelRatio(); finishU.res.value.set(w * pr, h * pr);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    obst = null;
  }
  const ro = new ResizeObserver(resize); ro.observe(root); resize();

  const clock = new THREE.Clock(); let fa = 0, fn = 0, slow = 0, fps = 0, raf = 0;
  const dbg: CitadelDebug = { get fps() { return fps; }, quality: null, get world() { return world; }, poll };
  root.__citadel = dbg;
  const streamColor = (waiting: boolean, failed: boolean): number => waiting ? 0xffa21a : failed ? 0xff4a4a : MORDOR ? 0xd23c10 : 0x7a8696;
  function frame(): void {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    frameN++; fa += dt; fn++; if (fa > 1) { fps = Math.round(fn / fa); fa = fn = 0; }
    if (frameN % 30 === 0) $('.at-clock').textContent = fmt(new Date());
    const w = world;
    if (w) {
      for (const a of w.figAgents) {
        const f = a.fig;
        if (a.path) {
          const d = a.path.to.clone().sub(f.position).setY(0), len = d.length();
          if (len < 0.03) { f.position.copy(a.path.to); a.homeFace = a.path.face; a.atDesk = a.path.to.equals(a.deskPos); a.path = null; }
          else { f.position.addScaledVector(d.normalize(), Math.min(len, dt * 0.6)); f.rotation.y = Math.atan2(d.x, d.z); f.position.y = a.desk ? a.benchPos.y : FLOOR_Y; }
        }
        if (!a.path) {
          const diff = Math.atan2(Math.sin(a.homeFace - f.rotation.y), Math.cos(a.homeFace - f.rotation.y)); f.rotation.y += diff * Math.min(1, dt * 6);
          f.position.y = a.desk ? a.benchPos.y : a.baseY;
        }
        a.t3.setState(timState(a));
        a.t3.update(dt, camera, H());
      }
      for (const p of w.projects) {
        let active = 0, wait = false;
        for (const d of p.desks) {
          const s = d.a.state, here = d.a.atDesk && !d.a.path;
          d.screen.material = s === 'rest' || !here ? M.screenOff : screenMat(p.color, s === 'wait' || s === 'err' ? s : 'work');
          const gc: [number, number, number] = s === 'wait' ? [1.0, 0.55, 0.1] : s === 'err' ? [1.0, 0.2, 0.2] : [0.55, 0.6, 0.7];
          d.glow.material.color.setRGB(...gc).multiplyScalar(here && s !== 'rest' ? 0.18 : 0);
          if (s !== 'rest') active++;
          if (s === 'wait') wait = true;
        }
        if (p.pilot && p.pilot.state !== 'rest') active++;
        const amt = 0.03 * active + (wait ? 0.35 + Math.sin(t * 4) * 0.15 : 0);
        p.inner.material.color.setRGB(1, wait ? 0.6 : 0.85, wait ? 0.25 : 0.6).multiplyScalar(amt);
      }
      w.beaconRing.material.color.setScalar(0.9 + Math.sin(t * 2) * 0.25);
      w.beaconAvatar.position.y = w.beaconRing.position.y = w.TOP + 2.2 + Math.sin(t * 1.2) * 0.08;
      if (w.embers && w.ash && w.lavaTime && w.mordor && w.eyeLight) {
        const p = w.embers.geometry.attributes.position, sd = w.embers.geometry.attributes.seed;
        if (p && sd) {
          for (let i = 0; i < p.count; i++) { let y = p.getY(i) + dt * (0.35 + sd.getX(i) * 0.9); if (y > 14) y = 0; p.setY(i, y); p.setX(i, p.getX(i) + Math.sin(t * 0.7 + sd.getX(i) * 40) * dt * 0.12); }
          p.needsUpdate = true;
        }
        const q = w.ash.geometry.attributes.position;
        if (q) {
          for (let i = 0; i < q.count; i++) { let y = q.getY(i) - dt * (0.25 + (i % 7) * 0.04); if (y < -0.3) y = 18; q.setY(i, y); q.setX(i, q.getX(i) + Math.sin(t * 0.4 + i) * dt * 0.08); }
          q.needsUpdate = true;
        }
        w.lavaTime.value = t; w.mordor.update(t, dt);
        // The eye flickers; now and then a lightning flash whitens the sky
        const flick = 0.85 + Math.sin(t * 9) * 0.06 + Math.sin(t * 23.7) * 0.05;
        w.eyeLight.intensity = 22 * flick;
        const phase = t % 9.7, bolt = phase < 0.09 || (phase > 0.16 && phase < 0.22) ? 1 : 0;
        hemi.intensity = 0.3 + bolt * 1.4; skyU.top.value.set(bolt ? '#3a3448' : '#040304');
      }
      for (const sat of w.satellites) { const a = t * sat.speed + sat.ph; const v = new THREE.Vector3(Math.cos(a) * sat.r, 0, Math.sin(a) * sat.r).applyEuler(new THREE.Euler(sat.ring.rotation.x - Math.PI / 2, 0, 0)); sat.s.position.set(v.x, sat.ring.position.y + v.y, v.z); }
      for (const d of w.spaces) {
        const ag = inSpace(w, d), act = ag.filter(a => a.state !== 'rest').length;
        const waiting = ag.some(a => a.state === 'wait'), failed = ag.some(a => a.state === 'err'), u = w.streams.get(d.key);
        if (!u) continue;
        u.time.value = t * (0.6 + act * 0.08); u.color.value.set(streamColor(waiting, failed));
        u.amount.value += ((act ? 0.35 + Math.min(act, 6) * 0.11 : 0.06) * 0.8 - u.amount.value) * Math.min(1, dt * 2);
      }
      for (let i = w.pulses.length - 1; i >= 0; i--) {
        const q = w.pulses[i];
        if (!q) continue;
        q.t += dt * 10 / q.len;
        const k = Math.min(q.t, 1), tail = Math.max(0, q.t - 0.3);
        q.line.geometry.setDrawRange(Math.floor(tail * q.N), Math.max(0, Math.floor((k - tail) * q.N) + 1));
        q.head.position.copy(q.path.getPointAt(k)); q.head.material.opacity = q.t > 1 ? Math.max(0, 1 - (q.t - 1) * 3) : 1;
        (q.line.material as THREE.LineBasicMaterial).color.setScalar(0.3);
        if (q.t > 1.4) { w.group.remove(q.line, q.head); q.line.geometry.dispose(); (q.line.material as THREE.LineBasicMaterial).dispose(); q.head.material.dispose(); w.pulses.splice(i, 1); }
      }
      if (touring && w.spaces.length) {
        tourT -= dt;
        if (tourT <= 0) { const next = w.spaces[tourI++ % w.spaces.length]; if (next) focusSpace(next, 15, 2.4); tourT = 8; }
        if (!fly) { const off = camera.position.clone().sub(controls.target); off.applyAxisAngle(UP, dt * 0.06); camera.position.copy(controls.target).add(off); }
      }
    }
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / fly.dur); const k = fly.t < 0.5 ? 4 * fly.t ** 3 : 1 - (-2 * fly.t + 2) ** 3 / 2;
      controls.target.lerpVectors(fly.fromT, fly.toT, k); camera.position.lerpVectors(fly.fromP, fly.toP, k);
      if (fly.t >= 1) fly = null;
    }
    controls.update();
    v3.copy(controls.target).project(camera);
    finishU.focus.value = v3.y * 0.5 + 0.5;
    finishU.amount.value = THREE.MathUtils.clamp(0.9 - camera.position.distanceTo(controls.target) / (110 * (w?.homeView.k ?? 1)), 0.15, 0.7);
    composer.render(dt);
    if (w) placeBadges(w);
    // Adaptive quality: below 40 fps for 3 s, occlusion is switched off, then the resolution is lowered
    if (t > 4 && fps && fps < 40) {
      slow += dt;
      if (slow > 3) { slow = 0; if (aoPass && aoPass.enabled) setAO(false); else if (PR > 1) { PR = Math.max(1, PR - 0.25); renderer.setPixelRatio(PR); resize(); } dbg.quality = { ao: !!aoPass?.enabled, pr: PR }; }
    } else slow = 0;
  }
  frame();

  /* ---------- Teardown: nothing may keep running ---------- */
  return function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf); clearInterval(pollTimer); ro.disconnect();
    canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp);
    controls.removeEventListener('change', onControlsChange); controls.removeEventListener('start', onControlsStart); controls.dispose();
    destroyWorld();
    scene.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
        o.geometry.dispose();
        for (const m of materialsOf(o)) { const withMap = m as THREE.Material & { map?: THREE.Texture | null }; withMap.map?.dispose(); m.dispose(); }
      }
    });
    for (const m of Object.values(M)) m.dispose();
    for (const m of screenCache.values()) { m.map?.dispose(); m.dispose(); }
    tims3d.dispose();
    for (const tex of avatarCache.values()) tex.dispose();
    glowTex.dispose(); ringTex.dispose(); treeGeo.dispose(); stemGeo.dispose();
    officeG.scene.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      for (const m of materialsOf(o)) { const withMap = m as THREE.Material & { map?: THREE.Texture | null }; withMap.map?.dispose(); m.dispose(); }
    });
    scene.environment?.dispose();
    composer.passes.forEach(p => p.dispose?.()); composer.dispose();
    renderer.dispose(); renderer.forceContextLoss();
    delete root.__citadel;
    wrap.remove();
  };
}
