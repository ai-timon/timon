/**
 * The job accessories: one drawing per job (the teacher also wears a
 * mortarboard). Each tool is drawn around its own origin, then placed on the
 * head where the 3D character carries it (`three/place.ts`): held at its side,
 * tucked above the ear, perched on or worn over the head, before the eye, or
 * standing at its foot.
 */

import { createElement, type ReactElement, type ReactNode } from 'react';
import type { MascotAccessory } from './agent-look';
import { readMascotSvg, type MascotPartId, type MascotSvgNode } from '@/lib/mascot/parts-contract';
import { mascotPartOf } from './mascot-parts';
import type { HeadLayout } from './mascot-geometry';

/** Built on demand: a table of elements would be created at import, mascot or not. */
type Tool = { deg: number; body: () => ReactNode };
const ARIAL = 'Arial,Helvetica,sans-serif';

const TOOLS: Readonly<Record<Exclude<MascotAccessory, 'none'>, Tool>> = {
  loupe: { deg: 0, body: () => (<>
    <line x1="6" y1="6" x2="14" y2="14" stroke="#7a4f2a" strokeWidth="5" strokeLinecap="round" />
    <circle cx="-1" cy="-1" r="10" fill="#cfe9ff" fillOpacity=".26" stroke="#dfe3e8" strokeWidth="3.4" />
    <path d="M-7 -4 A7 7 0 0 1 -2 -8" fill="none" stroke="#fff" strokeOpacity=".75" strokeWidth="1.7" strokeLinecap="round" />
  </>) },
  pen: { deg: 38, body: () => (<>
    <rect x="-3" y="-14" width="6" height="21" rx="2" fill="#e2463b" />
    <rect x="-3" y="-14" width="6" height="6" rx="2" fill="#b8322a" />
    <rect x="2.2" y="-12" width="1.4" height="9" rx=".7" fill="#b8322a" />
    <path d="M-3 7 L3 7 L0 14 Z" fill="#f2d3b0" />
    <path d="M-1.1 11.5 L1.1 11.5 L0 14 Z" fill="#c22" />
  </>) },
  quill: { deg: 32, body: () => (<>
    <path d="M0 12 C 8 1, 7 -9, 1 -16 C -6 -9, -7 1, 0 12 Z" fill="#f6f1e7" stroke="#cfc6b6" strokeWidth=".8" />
    <path d="M0 12 Q 1 -2, 1 -15" fill="none" stroke="#b9ae9b" strokeWidth="1" />
    <path d="M1 -4 l4.5 -2.5 M1 -9 l3.5 -2.5 M.6 0 l-4.5 -2.5" stroke="#cfc6b6" strokeWidth=".8" />
    <path d="M-1.3 11 L0 16 L1.3 11 Z" fill="#333" />
  </>) },
  hammer: { deg: -32, body: () => (<>
    <rect x="-1.9" y="-6" width="3.8" height="20" rx="1.6" fill="#9a6a3c" />
    <rect x="-1.9" y="9" width="3.8" height="5" rx="1.6" fill="#7a4f2a" />
    <rect x="-9" y="-12" width="18" height="7" rx="1.8" fill="#8e949c" />
    <rect x="-9" y="-12" width="18" height="2.2" rx="1.1" fill="#fff" opacity=".25" />
  </>) },
  wrench: { deg: 36, body: () => (<>
    <rect x="-2.3" y="-4" width="4.6" height="18" rx="2.3" fill="#b9bfc6" />
    <path d="M-2.3 -2 L-2.3 -4.5 A6.8 6.8 0 0 1 -5.8 -14 L-2.6 -11 L2.6 -11 L5.8 -14 A6.8 6.8 0 0 1 2.3 -4.5 L2.3 -2 Z" fill="#b9bfc6" stroke="#8d939a" strokeWidth=".6" />
    <rect x="-1" y="2" width="2" height="9" rx="1" fill="#8d939a" opacity=".6" />
  </>) },
  baton: { deg: 0, body: () => (<>
    <line x1="-10" y1="11" x2="9" y2="-10" stroke="#f4efe6" strokeWidth="1.9" strokeLinecap="round" />
    <circle cx="-9.5" cy="10.5" r="2.8" fill="#6b4a2b" />
    <ellipse cx="7" cy="-15" rx="2.2" ry="1.6" fill="#ffc233" transform="rotate(-20 7 -15)" />
    <path d="M9 -15.3 V -21.5 l 3 1.2" fill="none" stroke="#ffc233" strokeWidth="1.1" />
  </>) },
  telescope: { deg: -28, body: () => (<>
    <rect x="-13" y="-3" width="9" height="6" rx="1.5" fill="#c9a25a" />
    <rect x="-5" y="-3.7" width="9" height="7.4" rx="1.2" fill="#8a5a3b" />
    <rect x="3.5" y="-4.6" width="9" height="9.2" rx="2" fill="#c9a25a" />
    <rect x="11.5" y="-4.6" width="1.6" height="9.2" rx=".8" fill="#cfe9ff" />
    <rect x="-5" y="-3.7" width="9" height="1.6" fill="#fff" opacity=".18" />
  </>) },
  envelope: { deg: -10, body: () => (<>
    <rect x="-12" y="-8" width="24" height="16" rx="2" fill="#f6f1e7" stroke="#cfc6b6" strokeWidth=".8" />
    <path d="M-11.5 -7 L0 1.5 L11.5 -7" fill="none" stroke="#cfc6b6" strokeWidth="1.1" />
    <circle cx="0" cy="1.5" r="2.6" fill="#e2463b" />
  </>) },
  calendar: { deg: -8, body: () => (<>
    <rect x="-10.5" y="-9" width="21" height="20" rx="3" fill="#fff" />
    <path d="M-10.5 -3 V -6 a3 3 0 0 1 3 -3 h15 a3 3 0 0 1 3 3 V -3 Z" fill="#e2463b" />
    <rect x="-6" y="-11.5" width="1.8" height="4.5" rx=".9" fill="#2a2a30" />
    <rect x="4.2" y="-11.5" width="1.8" height="4.5" rx=".9" fill="#2a2a30" />
    <text x="0" y="8" textAnchor="middle" fontFamily={ARIAL} fontWeight="700" fontSize="9.5" fill="#2a2a30">12</text>
  </>) },
  clipboard: { deg: -8, body: () => (<>
    <rect x="-9.5" y="-11" width="19" height="24" rx="2.5" fill="#a87445" />
    <rect x="-7.5" y="-8" width="15" height="18.5" rx="1" fill="#fff" />
    <rect x="-4.5" y="-13" width="9" height="4.5" rx="1.4" fill="#8e949c" />
    {[-4, 1, 6].map((y, i) => (
      <g key={y}>
        <path d={`M-5.5 ${y} l1.4 1.4 l2.6 -2.8`} fill="none" stroke={i < 2 ? '#2fd4a5' : '#cfcfcf'} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="0" y={y - 0.6} width="5" height="1.3" rx=".6" fill="#cfcfcf" />
      </g>
    ))}
  </>) },
  hourglass: { deg: -12, body: () => (<>
    <rect x="-8.5" y="-12.5" width="17" height="3" rx="1.4" fill="#8a5a3b" />
    <rect x="-8.5" y="9.5" width="17" height="3" rx="1.4" fill="#8a5a3b" />
    <path d="M-6.5 -9.5 L6.5 -9.5 L1.3 0 L6.5 9.5 L-6.5 9.5 L-1.3 0 Z" fill="#cfe9ff" fillOpacity=".4" stroke="#dfe3e8" strokeWidth=".9" />
    <path d="M-3.8 -5 L3.8 -5 L0 -.8 Z" fill="#ffc233" />
    <path d="M-5.2 9.4 Q0 3, 5.2 9.4 Z" fill="#ffc233" />
    <line x1="0" y1="-.5" x2="0" y2="7" stroke="#ffc233" strokeWidth=".8" />
  </>) },
  teacher: { deg: -14, body: () => (<>
    <rect x="-9" y="-11.5" width="17" height="23" rx="2" fill="#3f6fd8" />
    <rect x="6" y="-10" width="3.2" height="20" rx="1" fill="#f6f1e7" />
    <rect x="-9" y="-11.5" width="3" height="23" rx="1.4" fill="#2f57b0" />
    <rect x="-3.5" y="-5" width="8" height="3.4" rx="1" fill="#ffc233" />
  </>) },
  calculator: { deg: -10, body: () => (<>
    <rect x="-8.5" y="-12" width="17" height="24" rx="2.6" fill="#3a3a42" />
    <rect x="-6.5" y="-9.8" width="13" height="5.4" rx="1.1" fill="#9fe3b0" />
    {[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => (
      <rect key={`${r}${c}`} x={-6.5 + c * 4.6} y={-2 + r * 4.4} width="3.6" height="3.4" rx=".8" fill={r === 2 && c === 2 ? '#ff8a3d' : '#c9ccd2'} />
    )))}
  </>) },
  chart: { deg: -8, body: () => (<>
    <rect x="-11.5" y="-9.5" width="23" height="19" rx="2.6" fill="#fff" />
    <rect x="-7.5" y="1" width="3.6" height="5.5" rx=".8" fill="#3fa9ff" />
    <rect x="-2" y="-3" width="3.6" height="9.5" rx=".8" fill="#2fd4a5" />
    <rect x="3.5" y="-6.5" width="3.6" height="13" rx=".8" fill="#a35bff" />
    <path d="M-8 -1 L-1 -5 L5 -9" fill="none" stroke="#ff5a4f" strokeWidth="1.2" strokeLinecap="round" />
  </>) },
  brush: { deg: 38, body: () => (<>
    <rect x="-1.7" y="-2" width="3.4" height="17" rx="1.7" fill="#c8763a" />
    <rect x="-2.5" y="-6.5" width="5" height="5.2" rx=".8" fill="#b9bfc6" />
    <path d="M-2.5 -6.5 Q -3.2 -12.5, 0 -16 Q 3.2 -12.5, 2.5 -6.5 Z" fill="#ff5fbf" />
  </>) },
  globe: { deg: 0, body: () => (<>
    <path d="M-11.5 4 A12.5 12.5 0 0 0 5 12" fill="none" stroke="#8a5a3b" strokeWidth="2" strokeLinecap="round" />
    <rect x="-5" y="12" width="10" height="2.6" rx="1.3" fill="#8a5a3b" />
    <circle cx="0" cy="0" r="10" fill="#3fa9ff" />
    <path d="M-6 -6 q4 -2 6 1 q-1 4 -5 3 q-3 2 -4 -1 Z M2 2 q5 -1 6 3 q-2 4 -6 2 Z M1 -9 q3 0 4 2 q-2 1 -4 0 Z" fill="#7bd94a" />
    <ellipse cx="0" cy="0" rx="4.5" ry="10" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth=".8" />
    <ellipse cx="-3" cy="-4" rx="3" ry="2" fill="#fff" opacity=".18" />
  </>) },
  megaphone: { deg: -14, body: () => (<>
    <path d="M-7.5 -3.2 L 8 -10.5 L 8 10.5 L -7.5 3.2 Z" fill="#ff5a4f" />
    <ellipse cx="8" cy="0" rx="2.4" ry="10.5" fill="#d9443b" />
    <rect x="-11" y="-3.4" width="4" height="6.8" rx="1.2" fill="#2a2a30" />
    <rect x="-4.5" y="3" width="3.2" height="7" rx="1.2" fill="#2a2a30" />
    <path d="M-6 -2 L 7 -8" stroke="#fff" strokeOpacity=".3" strokeWidth="1.2" />
  </>) },
  shield: { deg: -6, body: () => (<>
    <path d="M0 -12.5 L 10.5 -8.5 L 10.5 0 C 10.5 7, 5 11.5, 0 13.5 C -5 11.5, -10.5 7, -10.5 0 L -10.5 -8.5 Z" fill="#3fa9ff" />
    <path d="M0 -10 L 8 -7 L 8 0 C 8 5.5, 4 9, 0 10.8 Z" fill="#fff" opacity=".18" />
    <path d="M-4.5 0 l3.2 3.2 l6 -6.4" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </>) },
  coffee: { deg: 0, body: () => (<>
    <path d="M4.5 -2.5 C 11 -2.5, 11 6, 4.5 6" fill="none" stroke="#f6f1e7" strokeWidth="3" />
    <rect x="-8.5" y="-6" width="13.5" height="15" rx="2.6" fill="#f6f1e7" />
    <ellipse cx="-1.75" cy="-6" rx="6.75" ry="1.7" fill="#6b4a2b" />
    <text x="-1.75" y="4.6" textAnchor="middle" fontFamily={ARIAL} fontWeight="700" fontSize="6" fill="#3fa9ff">{'</>'}</text>
    <path d="M-4.5 -9 q-2 -2.5 0 -5 q2 -2.5 0 -5 M1 -9 q-2 -2.5 0 -5 q2 -2.5 0 -5" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1.2" strokeLinecap="round" />
  </>) },
  whip: { deg: -18, body: () => (<>
    <rect x="-1.7" y="3" width="3.4" height="12" rx="1.6" fill="#3f2716" />
    <circle cx="0" cy="15" r="2.3" fill="#6b4226" />
    <path d="M0 3 C 1 -8, -2 -16, -9 -17 C -17 -18, -19 -9, -14 -5 C -10 -2, -8 -7, -12 -9" fill="none" stroke="#6b4226" strokeWidth="2.2" strokeLinecap="round" />
  </>) },
  wizard: { deg: 0, body: () => (<>
    <ellipse cx="0" cy="11" rx="15" ry="3" fill="#46308a" />
    <path d="M-9 10 C -7 0, -3 -10, 2 -14 C 6 -16, 10 -15, 12 -12 C 7 -12, 5 -9, 9 10 Z" fill="#5b3fa8" />
    <rect x="-9" y="6.5" width="18" height="3.4" fill="#ffc233" />
    <circle cx="12" cy="-12" r="1.6" fill="#ffc233" />
    <polygon points="-2,-4 -1.2,-1.8 1,-1.8 -.8,-.4 -.1,1.8 -2,.5 -3.9,1.8 -3.2,-.4 -5,-1.8 -2.8,-1.8" fill="#ffd84a" />
    <circle cx="3.5" cy="2" r="1" fill="#ffd84a" />
  </>) },
  chef: { deg: 0, body: () => (<>
    <rect x="-8" y="2" width="16" height="9" rx="1.2" fill="#ecebe4" />
    <path d="M-5 2 v9 M0 2 v9 M5 2 v9" stroke="#d6d4ca" strokeWidth="1" />
    <circle cx="-6" cy="-3" r="6" fill="#fbfaf6" />
    <circle cx="6" cy="-3" r="6" fill="#fbfaf6" />
    <circle cx="0" cy="-7" r="7" fill="#fbfaf6" />
    <rect x="-10" y="-2" width="20" height="5" fill="#fbfaf6" />
  </>) },
  crown: { deg: 0, body: () => (<>
    <path d="M-13 9 L-13 -6 L-7 1 L0 -10 L7 1 L13 -6 L13 9 Z" fill="#ffc233" stroke="#e3a21a" strokeWidth="1.2" strokeLinejoin="round" />
    <rect x="-13" y="6" width="26" height="3.5" fill="#e3a21a" />
    <circle cx="-13" cy="-7" r="1.8" fill="#fff6e0" />
    <circle cx="0" cy="-11" r="1.8" fill="#fff6e0" />
    <circle cx="13" cy="-7" r="1.8" fill="#fff6e0" />
    <circle cx="-6" cy="3.5" r="1.6" fill="#2fae6b" />
    <circle cx="0" cy="3" r="2" fill="#e2463b" />
    <circle cx="6" cy="3.5" r="1.6" fill="#3f8fe0" />
  </>) },
  idea: { deg: 0, body: () => (<>
    <path d="M-4.5 6 C -4.5 2, -9 -1, -9 -6 A 9 9 0 0 1 9 -6 C 9 -1, 4.5 2, 4.5 6 Z" fill="#ffe680" stroke="#f2c94c" strokeWidth="1" />
    <rect x="-4.6" y="6" width="9.2" height="5.4" rx="1" fill="#b9bfc6" />
    <path d="M-4.6 8 h9.2 M-4.6 10 h9.2" stroke="#8e949c" strokeWidth=".8" />
    <path d="M-2 12 h4 l-1 2 h-2 Z" fill="#5b5f66" />
    <path d="M-3 -6 A 4 4 0 0 1 0 -9" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M-13 -13 l3 3 M13 -13 l-3 3 M0 -19 v4 M-15 -4 h3 M15 -4 h-3" stroke="#ffc233" strokeWidth="1.6" strokeLinecap="round" />
  </>) },
  rocket: { deg: 20, body: () => (<>
    <path d="M-3 6 L-9 13 L-9 7 L-5 1 Z M3 6 L9 13 L9 7 L5 1 Z" fill="#e2463b" />
    <path d="M0 -16 C 5 -12, 6 -6, 5.6 0 L5 8 L-5 8 L-5.6 0 C -6 -6, -5 -12, 0 -16 Z" fill="#f6f1e7" />
    <path d="M0 -16 C 3.6 -13, 4.6 -11, 5 -9 L-5 -9 C -4.6 -11, -3.6 -13, 0 -16 Z" fill="#e2463b" />
    <circle cx="0" cy="-2" r="2.8" fill="#3fa9ff" stroke="#8e949c" strokeWidth="1.2" />
    <path d="M-3 8 L0 16 L3 8 Z" fill="#ff7a1a" />
    <path d="M-1.4 8 L0 13 L1.4 8 Z" fill="#ffd23e" />
  </>) },
  chemist: { deg: -6, body: () => (<>
    <path d="M-2.8 -10 L-2.8 -2 L-10 11 Q -11 13, -8.6 13 L8.6 13 Q 11 13, 10 11 L2.8 -2 L2.8 -10 Z" fill="#cfe9ff" fillOpacity=".35" stroke="#dfe3e8" strokeWidth="1.2" />
    <path d="M-6.4 4.5 L6.4 4.5 L10 11 Q 11 13, 8.6 13 L-8.6 13 Q -11 13, -10 11 Z" fill="#3ddc84" />
    <rect x="-4" y="-12.5" width="8" height="2.6" rx="1" fill="#dfe3e8" />
    <circle cx="-1" cy="1" r="1" fill="#c8ffe0" />
    <circle cx="1" cy="-4" r=".8" fill="#c8ffe0" />
    <circle cx="0" cy="-8" r=".6" fill="#c8ffe0" />
  </>) },
  gamer: { deg: -10, body: () => (<>
    <path d="M-8 -6 h16 a6 6 0 0 1 5.6 4 l2.4 9 a3.6 3.6 0 0 1 -6.4 3 l-3 -4 h-9.2 l-3 4 a3.6 3.6 0 0 1 -6.4 -3 l2.4 -9 a6 6 0 0 1 5.6 -4 Z" fill="#3a3a42" />
    <path d="M-9.6 -1.4 h5 M-7.1 -3.9 v5" stroke="#1f1f24" strokeWidth="2" strokeLinecap="round" />
    <circle cx="7" cy="-3.8" r="1.3" fill="#2fd4a5" />
    <circle cx="9.6" cy="-1.3" r="1.3" fill="#e2463b" />
    <circle cx="7" cy="1.2" r="1.3" fill="#3fa9ff" />
    <circle cx="4.4" cy="-1.3" r="1.3" fill="#ffc233" />
    <circle cx="-3" cy="3" r="1.8" fill="#4a4a55" />
    <circle cx="3" cy="3" r="1.8" fill="#4a4a55" />
  </>) },
  photographer: { deg: -6, body: () => (<>
    <rect x="-13" y="-7" width="26" height="17" rx="2.6" fill="#3a3a42" />
    <rect x="-13" y="-7" width="26" height="5" rx="2.2" fill="#c9ccd2" />
    <rect x="-8" y="-11" width="8" height="4.5" rx="1.2" fill="#c9ccd2" />
    <circle cx="1" cy="2.4" r="6.6" fill="#8e949c" />
    <circle cx="1" cy="2.4" r="5" fill="#23232a" />
    <circle cx="1" cy="2.4" r="3.4" fill="#3a6fb0" />
    <circle cx="-.4" cy="1" r="1" fill="#fff" />
    <rect x="6" y="-5.6" width="5" height="2.6" rx=".6" fill="#fff6c8" />
    <rect x="7" y="-9" width="3" height="2" rx=".6" fill="#e2463b" />
  </>) },
  gardener: { deg: 0, body: () => (<>
    <path d="M-7 3 L7 3 L5.4 15 L-5.4 15 Z" fill="#c8643c" />
    <rect x="-8" y="1" width="16" height="3.4" rx="1" fill="#a94f2d" />
    <path d="M0 2 C 1 -4, -1 -9, 0 -13" fill="none" stroke="#3f9a3a" strokeWidth="1.4" strokeLinecap="round" />
    <ellipse cx="-4" cy="-4" rx="4.4" ry="2" transform="rotate(-25 -4 -4)" fill="#5cbf4a" />
    <ellipse cx="4" cy="-7.5" rx="4.4" ry="2" transform="rotate(25 4 -7.5)" fill="#5cbf4a" />
    <ellipse cx="-3.6" cy="-10.6" rx="3.6" ry="1.7" transform="rotate(-20 -3.6 -10.6)" fill="#5cbf4a" />
    <circle cx="0" cy="-14" r="2.2" fill="#ffcf3a" />
    <circle cx="0" cy="-14" r="1" fill="#e2463b" />
  </>) },
  musician: { deg: 24, body: () => (<>
    <rect x="-1.4" y="-16" width="2.8" height="16" rx=".6" fill="#6b4a2b" />
    <rect x="-2.2" y="-19.5" width="4.4" height="4.4" rx="1.1" fill="#4a3220" />
    <ellipse cx="0" cy="8" rx="8.4" ry="7.4" fill="#e08a3a" />
    <ellipse cx="0" cy="-.5" rx="6.4" ry="5.6" fill="#e08a3a" />
    <circle cx="0" cy="2" r="2.4" fill="#2a1a10" />
    <rect x="-3.4" y="9.6" width="6.8" height="1.8" rx=".6" fill="#6b4a2b" />
    <path d="M-.8 -15 L-1 10 M0 -15 V10 M.8 -15 L1 10" stroke="#eef0f2" strokeWidth=".3" />
  </>) },
};

/**
 * Where a tool sits on the head, after its 3D placement: `hand` held at the
 * side, `ear` tucked above the ear, `top` perched on the head, `hat` worn on
 * it, `eye` held before the right eye, `ground` standing at the foot. A
 * pack's tool is held.
 */
export type AccessoryAnchor = 'hand' | 'ear' | 'top' | 'hat' | 'eye' | 'ground';
const ANCHORS: Readonly<Partial<Record<MascotAccessory, AccessoryAnchor>>> = {
  loupe: 'eye', pen: 'ear', quill: 'ear', baton: 'ear', brush: 'ear',
  telescope: 'top', idea: 'top',
  wizard: 'hat', chef: 'hat', crown: 'hat',
  hourglass: 'ground', globe: 'ground', megaphone: 'ground', coffee: 'ground', rocket: 'ground',
  chemist: 'ground', gardener: 'ground', musician: 'ground',
};
export const accessoryAnchor = (acc: string): AccessoryAnchor => (ANCHORS as Readonly<Record<string, AccessoryAnchor>>)[acc] ?? 'hand';

/** A tool's drawings reach about this far from their origin: what keeps a fitted tool inside the box. */
const REACH = 16;

/**
 * Where a tool is drawn on a head: its origin and its scale. Big by default,
 * a held or standing tool spilling past the box's right edge (the svg
 * overflows); `fit` keeps it inside the 100×100 box, for a bitmap or a cell
 * that clips.
 */
export function accessoryPlace(acc: string, L: HeadLayout, fit: boolean): { x: number; y: number; s: number } {
  const h = L.bottom - L.top;
  let x: number;
  let y: number;
  let s: number;
  switch (accessoryAnchor(acc)) {
    case 'eye': x = L.geo.c2 + 2; y = L.geo.cy + 1; s = 0.95; break;
    case 'ear': x = L.ears.R[0] + 3; y = Math.min(L.ears.R[1], L.earsTop) - 8; s = 1; break;
    case 'top': x = 58; y = L.top - 8; s = 1.05; break;
    // The hats are drawn about 26 units wide: sized to the top of the skull, their brim on it.
    case 'hat': s = Math.max(0.9, (L.topWidth * 0.7) / 26); x = 50; y = L.top + 2 - 9 * s; break;
    case 'ground': s = 1.25; x = 50 + L.bottomWidth / 2 + 7; y = L.bottom - 13 * s; break;
    default: s = 1.25; x = 50 + L.belly + 5; y = L.bottom - h * 0.32; break;
  }
  if (!fit) return { x, y, s };
  const sf = s * 0.82;
  const r = REACH * sf;
  const clamp = (v: number): number => Math.min(100 - r, Math.max(r, v));
  return { x: clamp(x), y: clamp(y), s: sf };
}

/** The mortarboard, sized from the top of the skull. */
function Mortarboard({ top }: { top: number }): ReactElement {
  const y = Math.max(top, 12.5);
  return (
    <g data-mascot-cap="">
      <path d={`M38 ${y + 3.5} Q 50 ${y + 8}, 62 ${y + 3.5} L 62 ${y - 3} L 38 ${y - 3} Z`} fill="#1f1f24" />
      <path d={`M26 ${y - 4.5} L 50 ${y - 11} L 74 ${y - 4.5} L 50 ${y + 1.5} Z`} fill="#2b2b30" />
      <circle cx="50" cy={y - 4.5} r="1.6" fill="#ffc233" />
      <path d={`M50 ${y - 4.5} L 67 ${y - 2.5} L 67 ${y + 7}`} fill="none" stroke="#ffc233" strokeWidth="1.3" />
      <rect x="65.6" y={y + 6} width="2.8" height="5" rx="1" fill="#ffc233" />
    </g>
  );
}

/** The kept elements as React elements: never markup put in the page as HTML. */
function svgElements(nodes: readonly MascotSvgNode[], path = 'a'): ReactNode[] {
  return nodes.map((node, i) => createElement(node.tag, { ...node.props, key: `${path}${i}` }, ...svgElements(node.children, `${path}${i}.`)));
}

/** Read once per part object: a pack registered again is read again. */
const packArt = new WeakMap<object, ReactNode[] | null>();

/**
 * A pack's tool, as its markup reads. The registry already refused a part it
 * could not read; reading again here is what turns it into elements, and a
 * refusal (which cannot happen for a registered part) draws nothing.
 */
/**
 * The tool alone, centred and enlarged in the 0–100 box: what a configurator
 * cell shows, where the whole head would leave it a few pixels wide.
 */
export function MascotAccessoryIcon({ acc }: { acc: MascotAccessory | MascotPartId }): ReactElement | null {
  if (acc === 'none') return null;
  const tool = (TOOLS as Readonly<Record<string, Tool>>)[acc] ?? packTool(acc);
  if (!tool) return null;
  return <g transform={`translate(50 50) rotate(${tool.deg}) scale(2.4)`}>{tool.body()}</g>;
}

function packTool(acc: string): { deg: number; body: () => ReactNode } | null {
  const part = mascotPartOf('acc', acc);
  if (!part) return null;
  let art = packArt.get(part);
  if (art === undefined) {
    const read = readMascotSvg(part.svg);
    art = read.ok ? svgElements(read.nodes) : null;
    packArt.set(part, art);
  }
  const body = art;
  return body ? { deg: part.tilt ?? 0, body: () => body } : null;
}

/**
 * The accessory of a look, on the head (`accessoryPlace`). A pack's tool is
 * drawn the same way; one whose pack is gone draws nothing.
 */
export function MascotAccessoryArt({ acc, layout, fit }: { acc: MascotAccessory | MascotPartId; layout: HeadLayout; fit: boolean }): ReactElement | null {
  if (acc === 'none') return null;
  const tool = (TOOLS as Readonly<Record<string, Tool>>)[acc] ?? packTool(acc);
  if (!tool) return null;
  const at = accessoryPlace(acc, layout, fit);
  const f = (v: number): string => v.toFixed(2);
  return (
    <>
      {acc === 'teacher' && <Mortarboard top={layout.top} />}
      <g transform={`translate(${f(at.x)} ${f(at.y)}) rotate(${tool.deg}) scale(${f(at.s)})`}>{tool.body()}</g>
    </>
  );
}
