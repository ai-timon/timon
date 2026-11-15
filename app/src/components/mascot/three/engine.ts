/**
 * One WebGL context for every 3D mascot on the page. Each tile is a plain 2D
 * canvas: the engine renders the tile's head into its own GL canvas, then
 * copies the pixels across. Browsers cap live WebGL contexts at around
 * sixteen and a page can show a hundred mascots (Kanban, lists), so a context
 * per avatar is not an option.
 *
 * Costs are bounded: redraws go round robin under a budget per animation
 * frame; a still tile is drawn once, then only when its props change; live
 * tiles redraw at 15 to 30 fps by size; the loop sleeps while the tab is
 * hidden or nothing is live.
 */
import * as THREE from 'three';
import { baseExpression, buildEyeAtlas, COLS, D_IN, D_RANGE, ROWS } from './eyes';
import { base64Bytes, decodeArray, decodeFloats, shapeData, type BodyData, type ModelData, type ShapeData } from './model-data';
import { CENTER_Y, FRAME, MAX_PIECES, piecesFor, placePiece, skullLift, skullMetrics, skullScale, standsUp, type Piece, type SkullMetrics } from './place';
import { createSim, settle, shellsFor, stepSim, supersampleFor, type Sim } from './sim';
import { createTile, MAX_PX, type Tile } from './tile';

const SH_MAX = 22;
const FOV = 18;
/**
 * Budget of one animation frame: redraws go on until this many milliseconds
 * are spent, and never past this many tiles. A count alone starves a page of
 * many live heads (65 heads at 60 frames a second need 20 a frame).
 */
const BUDGET_MS = 4;
const BUDGET_MAX = 48;
/** At least this many redraws a frame, whatever the clock says: a slow frame must not freeze every head. */
const BUDGET_MIN = 8;
/** Avatars gain nothing past 60 frames a second: on a 144 Hz screen the extra frames are skipped. */
const MIN_FRAME_MS = 15.5;
/** Reading a rectangle forces layout: a tile's is kept this long. */
const RECT_TTL_MS = 330;
/** A size change smaller than this share keeps a tile's canvas: the mascots' squash-and-stretch animations stay cheap. */
const RESIZE_SLACK = 0.2;

export type EngineStats = {
  seconds: number; tiles: number; onPage: number; live: number; models: number;
  framesPerSecond: number; drawsPerSecond: number; msPerDraw: number; maxMsPerDraw: number; mainThreadPercent: number;
};

export type Mascot3DEngine = {
  add(t: Tile): void;
  remove(t: Tile): void;
  /** Props changed: redraw on the next frame. */
  touch(t: Tile): void;
  /** What the mascots cost on this page since the last call. */
  stats(): EngineStats;
  /**
   * Renders one still head, turned as `pose` says, into the whole of `out`'s
   * bitmap, at once and outside the tiles' round robin: a screen that copies
   * heads as bitmaps (the onboarding's avalanche) keeps a few views of each.
   * `css` is the size the copy will show at, which picks the fur detail.
   * False while the GL context is lost: nothing was drawn.
   */
  snapshot(look: SnapshotLook, pose: SnapshotPose, out: CanvasRenderingContext2D, css: number): boolean;
};

/** The character a snapshot draws: the props of a still 3D head. */
export type SnapshotLook = { shape: string; acc: string; hex: string; eyes: string };
/**
 * Where a snapshot's head faces, in radians: positive yaw towards the
 * viewer's right, positive pitch downwards. The whole head turns, the face a
 * little further than the skull, as when a live head follows the pointer.
 */
export type SnapshotPose = { yaw: number; pitch: number };

type Model = {
  sk: SkullMetrics;
  poses: Float32Array;
  bones: number;
  rows: number;
  hi: THREE.BufferGeometry;
  lo: THREE.BufferGeometry;
  visorGeo: THREE.BufferGeometry;
  poseTex: THREE.DataTexture;
  k: number;
  lift: number;
  pivL: THREE.Vector3;
  pivR: THREE.Vector3;
  headY: number;
  aspect: number;
  furLength: number;
};

function bodyGeometry(B: BodyData): { geo: THREE.BufferGeometry; positions: Float32Array; ears: Float32Array } {
  const g = new THREE.BufferGeometry();
  const positions = decodeFloats(B.pos);
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(decodeFloats(B.nrm), 3));
  // Packed to stay well under the attribute limit: aFE = (fur length, ear side), aSkin = (bone0, bone1, w0, w1).
  const fur = decodeFloats(B.fur);
  const ears = decodeFloats(B.ear);
  const j = decodeFloats(B.j);
  const w = decodeFloats(B.w);
  const n = fur.length;
  const fe = new Float32Array(n * 2);
  const sk = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    fe[i * 2] = fur[i] ?? 0;
    fe[i * 2 + 1] = Math.round(ears[i] ?? 0);
    sk[i * 4] = j[i * 2] ?? 0;
    sk[i * 4 + 1] = j[i * 2 + 1] ?? 0;
    sk[i * 4 + 2] = w[i * 2] ?? 0;
    sk[i * 4 + 3] = w[i * 2 + 1] ?? 0;
  }
  g.setAttribute('aFE', new THREE.BufferAttribute(fe, 2));
  g.setAttribute('aSkin', new THREE.BufferAttribute(sk, 4));
  g.setIndex(new THREE.BufferAttribute(decodeArray(B.idx), 1));
  // One instance per fur shell; instance 0 is the skin itself.
  g.setAttribute('iShell', new THREE.InstancedBufferAttribute(Float32Array.from({ length: SH_MAX }, (_, i) => i), 1));
  return { geo: g, positions, ears };
}

// Rig poses baked in Blender: row 0 = rest, then one row per clip frame; each bone = 4 RGBA texels (mat4 columns).
const SKIN = `uniform highp sampler2D uPose;
  mat4 boneRow(int b,int r){return mat4(texelFetch(uPose,ivec2(b*4,r),0),texelFetch(uPose,ivec2(b*4+1,r),0),texelFetch(uPose,ivec2(b*4+2,r),0),texelFetch(uPose,ivec2(b*4+3,r),0));}
  mat4 bone(int b,float f){int r=int(f);float t=f-float(r);return t<.001?boneRow(b,r):boneRow(b,r)*(1.-t)+boneRow(b,r+1)*t;}
  // Where the head turns: the root of the rig's 'top' bone, which rises with the skull's height.
  uniform float uHeadY;
  #define HEAD_PIV vec3(0.,uHeadY,0.)
  mat3 lookMat(vec3 l){float cy=cos(l.x),sy=sin(l.x),cp=cos(l.y),sp=sin(l.y),ct=cos(l.z),st=sin(l.z);
    return mat3(cy,0.,-sy,0.,1.,0.,sy,0.,cy)*mat3(1.,0.,0.,0.,cp,sp,0.,-sp,cp)*mat3(ct,st,0.,-st,ct,0.,0.,0.,1.);}`;

const FUR_VERTEX = `
  attribute vec2 aFE;attribute vec4 aSkin;attribute float iShell;
  ${SKIN}
  uniform float uFurLen;uniform vec3 uPivL;uniform vec3 uPivR;uniform vec3 uColor;uniform vec3 uVel;
  uniform float uFrame;uniform vec2 uEar;uniform vec3 uLook;uniform float uShells;
  varying vec3 vRest;varying vec3 vN;varying float vH;varying float vFur;varying vec3 vWP;varying float vEdge;
  mat3 rotZ(float a){float c=cos(a),s=sin(a);return mat3(c,s,0.,-s,c,0.,0.,0.,1.);}
  void main(){
    vec3 p=position,n=normal;float aEar=aFE.y;vec2 aJ=aSkin.xy,aW=aSkin.zw;
    if(aEar!=0.){vec3 piv=aEar>0.?uPivL:uPivR;mat3 R=rotZ(aEar>0.?-uEar.x:uEar.y);p=R*(p-piv)+piv;n=R*n;}
    float hw=(aJ.x>.5?aW.x:0.)+(aJ.y>.5?aW.y:0.);
    if(hw>0.&&dot(uLook,uLook)>0.){mat3 L=lookMat(uLook);p=mix(p,L*(p-HEAD_PIV)+HEAD_PIV,hw);n=mix(n,L*n,hw);}
    if(uFrame>0.){mat4 S=bone(int(aJ.x),uFrame)*aW.x+bone(int(aJ.y),uFrame)*aW.y;p=(S*vec4(p,1.)).xyz;n=mat3(S)*n;}
    vec4 wp=modelMatrix*vec4(p,1.);
    vec3 wn=normalize(mat3(modelMatrix)*n);float sc=length(modelMatrix[0].xyz);
    // Silhouette: shells seen edge-on read as spiky strands, so the fur is shorter there.
    float edge=1.-abs(dot(wn,normalize(cameraPosition-wp.xyz)));
    float h=uShells>1.?iShell/(uShells-1.):0.;
    float L=uFurLen*aFE.x*sc*mix(1.,.55,edge*edge);vEdge=edge;
    vec3 droop=vec3(0.,-.55,0.)-clamp(uVel*.03,vec3(-.9),vec3(.9));
    wp.xyz+=wn*L*h+droop*L*h*h;
    vRest=position;vN=wn;vH=h;vFur=aFE.x;vWP=wp.xyz;
    gl_Position=projectionMatrix*viewMatrix*wp;}`;

const FUR_FRAGMENT = `
  uniform float uDens;uniform vec3 uLight;uniform vec3 uRim;uniform vec3 uColor;
  varying vec3 vRest;varying vec3 vN;varying float vH;varying float vFur;varying vec3 vWP;varying float vEdge;
  float h13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
  vec3 h33(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
  void main(){
    float h=vH,a=1.;
    if(h>0.){
      if(vFur<.04)discard;
      vec3 q=vRest*uDens,c=floor(q),f=fract(q);
      float r=h13(c+7.),len=.5+.5*r;
      if(h>len)discard;
      float d=length(f-(h33(c)*.6+.2)),rad=.5*(1.-h/len)+.08,w=fwidth(d)+.06;
      a=(1.-smoothstep(rad-w,rad+w,d))*(1.-smoothstep(.35,1.,h)*smoothstep(.3,.9,vEdge)*.85);
      if(a<.03)discard;
    }
    vec3 N=normalize(vN),V=normalize(cameraPosition-vWP);
    float wrap=clamp(dot(N,uLight)*.5+.5,0.,1.);
    float rim=pow(1.-clamp(dot(N,V),0.,1.),2.4);
    vec3 base=uColor*mix(.32,1.12,h);
    gl_FragColor=vec4(base*(.22+.9*wrap)+uRim*rim*(.2+.9*h)*(.55+.45*uColor),a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const VISOR_VERTEX = `uniform float uFrame;uniform vec3 uLook;varying vec2 vUv;varying vec3 vN;varying vec3 vWP;
  ${SKIN}
  void main(){mat4 B=uFrame>0.?bone(1,uFrame):mat4(1.);
    mat3 L=lookMat(uLook);vec3 p=L*(position-HEAD_PIV)+HEAD_PIV;
    mat4 M=modelMatrix*B;vec4 wp=M*vec4(p,1.);vUv=uv;
    vN=normalize(mat3(M)*(L*normal));vWP=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}`;

const VISOR_FRAGMENT = `uniform sampler2D uAtlas;uniform float uExpr;uniform float uExpr2;uniform float uMix;uniform float uBlink;uniform float uGlow;uniform float uAspect;varying vec2 vUv;varying vec3 vN;varying vec3 vWP;
  // One cell per expression, ${COLS}x${ROWS}, laid out top-down: the signed distance to the expression's glyphs, in visor heights.
  float cell(float e,vec2 uv){e=floor(e+.5);float col=mod(e,${COLS}.),row=floor(e/${COLS}.);
    return texture2D(uAtlas,vec2((clamp(uv.x,.004,.996)+col)/${COLS}.,(clamp(uv.y,.006,.994)+${ROWS - 1}.-row)/${ROWS}.)).r*${D_RANGE.toFixed(3)}-${D_IN.toFixed(3)};}
  void main(){
    // The atlas is drawn for the classic visor: on a wider or narrower one the eyes keep their shape and spacing.
    // Blink: the eyes squash towards their line, like the 2D mascot's scaleY.
    vec2 uv=vec2(.5+(vUv.x-.5)*uAspect,.52+(vUv.y-.52)/max(uBlink,.06));
    // Two expressions morph: their distance fields are mixed, so one outline flows into the other.
    float d=mix(cell(uExpr,uv),cell(uExpr2,uv),smoothstep(0.,1.,uMix));
    float aa=max(fwidth(d),.003);
    vec3 a=vec3(1.-smoothstep(-aa,aa,d),exp(-max(d,0.)/.035),0.);
    vec3 N=normalize(vN),V=normalize(cameraPosition-vWP),R=reflect(-V,N);
    float fr=pow(1.-clamp(dot(N,V),0.,1.),3.);
    float spec=pow(clamp(dot(R,normalize(vec3(-.45,.75,.5))),0.,1.),80.)*2.+smoothstep(.35,.95,R.y)*.05;
    vec3 base=vec3(.003)+vec3(.55,.5,.48)*fr*.3+vec3(1.,.95,.9)*spec;
    // No bloom pass per tile: the glyphs are pushed a little brighter and widened by the atlas' soft channel instead.
    gl_FragColor=vec4(base+vec3(1.,.58,.24)*(a.r*4.5+pow(a.g,1.6)*.9)*uGlow,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// uMode animates some accessories: 1 the globe turns, 2 the hourglass runs, 3 the mug steams, 4 the whip waves
// and cracks, 5 the wand's star spins, 6 the bulb pulses, 7 the rocket's flame flickers, 8 the flask bubbles,
// 9 the plant's leaves sway. Parts are told apart by their exact vertex colour.
const ACC_VERTEX = `attribute vec4 color;uniform float uMode;uniform float uT;uniform float uPhase;uniform float uGlass;
  varying float vA;varying float vE;varying vec3 vC;varying vec3 vN;varying vec3 vWP;
  bool is(vec3 c){return distance(color.rgb*255.,c)<.6;}
  float glassR(float y){return 1.3+5.2*pow(abs(y)/9.5,.75);}
  void main(){
    vec3 p=position,n=normal;vA=1.;vE=0.;
    if(distance(color.rgb,vec3(.812,.914,1.))<.03)vA=uGlass;
    // The globe (sea, land, ice: every colour with green above a half) turns about its axis, which leans 23 degrees.
    if(uMode==1.&&color.g>.5){float c=cos(uT*.7),s=sin(uT*.7);mat3 T=mat3(.9205,.3907,0.,-.3907,.9205,0.,0.,0.,1.);mat3 R=T*mat3(c,0.,-s,0.,1.,0.,s,0.,c)*transpose(T);p=R*p;n=R*n;}
    if(uMode==2.){
      // The three sands are told apart by the last byte of their colour: top, heap, stream.
      float b=floor(color.b*255.+.5);
      if(b==51.){float y1=.9+(p.y-.9)*(1.-uPhase);float k=glassR(y1)/glassR(p.y);p=vec3(p.x*k,y1,p.z*k);}
      else if(b==52.){float s=mix(.2,1.,uPhase);p=vec3(p.x*s,-9.3+(p.y+9.3)*s,p.z*s);}
      else if(b==53.){p.xz*=step(uPhase,.95)*step(.001,uPhase);}
    }
    if(abs(color.b-.9961)<.002&&color.r<.999){
      // Steam: it sways more the higher it rises, and thins out to nothing.
      float h=clamp((p.y-9.)/10.,0.,1.);
      p.x+=sin(p.y*.7-uT*2.5)*1.1*h*step(.5,uMode);
      vA=.6*(1.-h)*(.65+.35*sin(p.y*1.3-uT*3.));
    }
    if(uMode==4.&&color.a>0.){
      // The lash: a slow wave runs down it, wider towards the tip; every few seconds it is flicked upwards and
      // towards the viewer, and a tight wave races to the cracker. Never sideways: the tile ends just beyond it.
      float s=color.a,c=fract(uT/3.6),e=smoothstep(0.,.07,c)*(1.-smoothstep(.1,.5,c));
      p.x+=sin(uT*2.3-s*5.)*1.*s*s+e*(-3.*s*s+sin(s*7.-c*46.)*1.6*s);
      p.z+=cos(uT*1.8-s*4.)*1.2*s*s+e*5.*s*s;
      p.y+=e*(10.*s*s+cos(s*7.-c*46.)*2.2*s);
    }
    // The wand's star turns about the rod, which is the y axis.
    if(uMode==5.&&is(vec3(255.,216.,75.))){float c=cos(uT*2.2),s=sin(uT*2.2);p.xz=mat2(c,-s,s,c)*p.xz;n.xz=mat2(c,-s,s,c)*n.xz;}
    // The bulb's glass shines of its own light, and breathes when the mascot is live.
    if(is(vec3(255.,230.,128.)))vE=.5+(uMode==6.?.3*sin(uT*2.6):0.);
    // The rocket's flame stretches and narrows below the nozzle (y = -10.4).
    if(uMode==7.&&(is(vec3(255.,122.,26.))||is(vec3(255.,210.,62.)))){
      float k=1.+.22*sin(uT*23.)+.12*sin(uT*37.+1.);p.y=-10.4+(p.y+10.4)*k;p.xz*=1.+.1*sin(uT*29.);vE=.6;}
    if(is(vec3(255.,122.,26.))||is(vec3(255.,210.,62.)))vE=max(vE,.45);
    // Each bubble rises from the liquid, up the neck and out of the mouth, and fades; its phase is its alpha byte.
    if(uMode==8.&&is(vec3(200.,255.,224.))){float f=fract(uT*.32+color.a);p.y+=-2.+f*17.;p.x+=sin(uT*3.+color.a*9.)*.6*f;vA=1.-smoothstep(.75,1.,f);}
    // The leaves sway, more the higher they grow (their alpha byte).
    if(uMode==9.&&color.a>0.){float s=color.a;p.x+=sin(uT*1.5)*1.1*s*s;p.z+=cos(uT*1.2+.6)*.7*s*s;p.y-=abs(sin(uT*1.5))*.25*s;}
    vec4 wp=modelMatrix*vec4(p,1.);vC=pow(color.rgb,vec3(2.2));vN=normalize(mat3(modelMatrix)*n);vWP=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}`;

const ACC_FRAGMENT = `uniform vec3 uLight;varying float vA;varying float vE;varying vec3 vC;varying vec3 vN;varying vec3 vWP;
  void main(){
    vec3 N=normalize(vN),V=normalize(cameraPosition-vWP);
    float wrap=clamp(dot(N,uLight)*.5+.5,0.,1.);
    float spec=pow(clamp(dot(reflect(-V,N),uLight),0.,1.),24.)*.18;
    float rim=pow(1.-clamp(dot(N,V),0.,1.),3.)*.12;
    gl_FragColor=vec4(mix(vC*(.3+.85*wrap),vC*1.35,vE)+vec3(spec+rim),vA);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** Accessories with a see-through part (lens, glass, steam, flask): drawn blended; the last three also move. */
const CLEAR: Readonly<Record<string, number>> = { loupe: 0, hourglass: 2, coffee: 3, flask: 8 };
/** Opaque accessories that move, and their animation mode. */
const MOVES: Readonly<Record<string, number>> = { globe: 1, whip: 4, wand: 5, bulb: 6, rocket: 7, plant: 9 };
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The page's engine. Created once per page by `tile.ts`, which loads this module and the model data on demand. */
export function createEngine(data: ModelData): Mascot3DEngine {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MAX_PX;
  // preserveDrawingBuffer: the 2D copy reads the GL canvas right after the draw call.
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(MAX_PX, MAX_PX, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 50);
  const dist = FRAME / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  camera.position.set(0, CENTER_Y, dist);
  camera.lookAt(0, CENTER_Y, 0);

  // One model per skull, built on first use: most pages only ever show two or three skulls.
  const models = new Map<ShapeData, Model>();
  function model(shape: string): Model {
    const d = shapeData(data, shape);
    const cached = models.get(d);
    if (cached) return cached;
    const AN = d.anim;
    // Half floats: half the weight of the poses on the GPU.
    const poseHalf = new Uint16Array(base64Bytes(AN.data).buffer);
    // The same poses as plain floats, for the pieces worn on the character: they follow the rig's bones from JavaScript.
    const poses = Float32Array.from(poseHalf, (h) => THREE.DataUtils.fromHalfFloat(h));
    const poseTex = new THREE.DataTexture(poseHalf, AN.bones * 4, AN.rows, THREE.RGBAFormat, THREE.HalfFloatType);
    poseTex.minFilter = poseTex.magFilter = THREE.NearestFilter;
    poseTex.needsUpdate = true;
    const visorGeo = new THREE.BufferGeometry();
    visorGeo.setAttribute('position', new THREE.BufferAttribute(decodeFloats(d.visor.pos), 3));
    visorGeo.setAttribute('normal', new THREE.BufferAttribute(decodeFloats(d.visor.nrm), 3));
    visorGeo.setAttribute('uv', new THREE.BufferAttribute(decodeFloats(d.visor.uv), 2));
    visorGeo.setIndex(new THREE.BufferAttribute(decodeArray(d.visor.idx), 1));
    const k = skullScale(d.halfWidth, d.height);
    const hi = bodyGeometry(d.body);
    const m: Model = {
      sk: skullMetrics({ positions: hi.positions, ears: hi.ears, height: d.height, headY: d.headPivot, earPivot: d.earPivot.L, k }),
      poses, bones: AN.bones, rows: AN.rows,
      hi: hi.geo, lo: bodyGeometry(d.bodyLo).geo, visorGeo, poseTex, k, lift: skullLift(k, d.height),
      pivL: new THREE.Vector3(...d.earPivot.L), pivR: new THREE.Vector3(...d.earPivot.R),
      headY: d.headPivot, aspect: d.visorAspect, furLength: d.furLength,
    };
    models.set(d, m);
    return m;
  }

  const uPose: THREE.IUniform<THREE.DataTexture | null> = { value: null };
  const uHeadY: THREE.IUniform<number> = { value: 0.44 };
  const light = new THREE.Vector3(-0.45, 0.8, 0.55).normalize();
  const furU = {
    uPose, uHeadY, uFurLen: { value: 0.095 }, uDens: { value: 70 },
    uPivL: { value: new THREE.Vector3() }, uPivR: { value: new THREE.Vector3() },
    uLight: { value: light },
    uRim: { value: new THREE.Color(1.0, 0.62, 0.34).multiplyScalar(1.5) },
    uColor: { value: new THREE.Color() }, uVel: { value: new THREE.Vector3() },
    uFrame: { value: 0 }, uEar: { value: new THREE.Vector2() }, uLook: { value: new THREE.Vector3() },
    uShells: { value: SH_MAX },
  };
  const furMat = new THREE.ShaderMaterial({ uniforms: furU, vertexShader: FUR_VERTEX, fragmentShader: FUR_FRAGMENT });
  furMat.alphaToCoverage = true;
  const fur = new THREE.InstancedMesh(model('squircle').hi, furMat, SH_MAX);
  const identity = new THREE.Matrix4();
  for (let i = 0; i < SH_MAX; i += 1) fur.setMatrixAt(i, identity);
  fur.frustumCulled = false;
  fur.matrixAutoUpdate = false;
  scene.add(fur);

  const sdf = buildEyeAtlas();
  const atlas = new THREE.DataTexture(sdf.data, sdf.w, sdf.h, THREE.RedFormat, THREE.UnsignedByteType);
  atlas.minFilter = atlas.magFilter = THREE.LinearFilter;
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.needsUpdate = true;
  const visorU = {
    uHeadY, uPose, uAspect: { value: 1 }, uAtlas: { value: atlas }, uExpr: { value: 0 }, uExpr2: { value: 0 }, uMix: { value: 0 },
    uBlink: { value: 1 }, uFrame: { value: 0 }, uLook: { value: new THREE.Vector3() }, uGlow: { value: 1 },
  };
  const visorMat = new THREE.ShaderMaterial({ uniforms: visorU, vertexShader: VISOR_VERTEX, fragmentShader: VISOR_FRAGMENT });
  const visor = new THREE.Mesh(model('squircle').visorGeo, visorMat);
  visor.frustumCulled = false;
  visor.matrixAutoUpdate = false;
  scene.add(visor);

  type AccUniforms = { uLight: THREE.IUniform<THREE.Vector3>; uGlass: THREE.IUniform<number>; uMode: THREE.IUniform<number>; uT: THREE.IUniform<number>; uPhase: THREE.IUniform<number> };
  const accMaterial = (glass: boolean): { mat: THREE.ShaderMaterial; u: AccUniforms } => {
    const u: AccUniforms = { uLight: { value: light }, uGlass: { value: glass ? 0.25 : 1 }, uMode: { value: 0 }, uT: { value: 0 }, uPhase: { value: 0.35 } };
    const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: ACC_VERTEX, fragmentShader: ACC_FRAGMENT });
    if (glass) { mat.transparent = true; mat.depthWrite = false; }
    return { mat, u };
  };
  const opaque = accMaterial(false);
  const glass = accMaterial(true);

  const accGeos = new Map<string, THREE.BufferGeometry>();
  function accGeo(name: string): THREE.BufferGeometry | null {
    if (!has(data.accessories, name)) return null;
    const a = data.accessories[name];
    if (!a) return null;
    let g = accGeos.get(name);
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(decodeFloats(a.pos), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(decodeFloats(a.nrm), 3));
      // Four bytes a vertex: its colour, and how far along a supple part it sits (the whip's lash).
      g.setAttribute('color', new THREE.BufferAttribute(base64Bytes(a.col), 4, true));
      g.setIndex(new THREE.BufferAttribute(decodeArray(a.idx), 1));
      g.computeBoundingBox();
      accGeos.set(name, g);
    }
    return g;
  }
  const pieces = Array.from({ length: MAX_PIECES }, () => new THREE.Mesh(new THREE.BufferGeometry(), opaque.mat));
  for (const m of pieces) { m.frustumCulled = false; m.matrixAutoUpdate = false; m.visible = false; scene.add(m); }

  const M = new THREE.Matrix4();
  const M2 = new THREE.Matrix4();
  const M3 = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const Q2 = new THREE.Quaternion();
  const E = new THREE.Euler();
  const E2 = new THREE.Euler();
  const P = new THREE.Vector3();
  const S = new THREE.Vector3();
  const P3 = new THREE.Vector3();
  const S3 = new THREE.Vector3();

  /** A rig bone's matrix at the simulation's pose row (0 = body, 1 = top), as the shaders read it from the pose texture. */
  function boneMatrix(mo: Model, b: number, row: number, out: THREE.Matrix4): THREE.Matrix4 {
    if (!(row > 0)) return out.identity();
    const r = Math.min(mo.rows - 1, Math.floor(row));
    const f = r + 1 < mo.rows ? row - r : 0;
    const e = out.elements;
    const i0 = (r * mo.bones + b) * 16;
    const i1 = i0 + mo.bones * 16;
    for (let k = 0; k < 16; k += 1) {
      const a = mo.poses[i0 + k] ?? 0;
      e[k] = f < 0.001 ? a : a * (1 - f) + (mo.poses[i1 + k] ?? a) * f;
    }
    return out;
  }
  /**
   * `base` with a bone's pose and `w` of the head's turn about its pivot. With
   * the top bone and w = 1 it is what the visor follows: anything worn on the
   * head hops, startles and turns with it.
   */
  function headMatrix(mo: Model, sim: Sim, base: THREE.Matrix4, out: THREE.Matrix4, w = 1, b = 1): THREE.Matrix4 {
    E2.set(sim.head[1] * w, sim.head[0] * w, sim.head[2] * w, 'YXZ');
    Q2.setFromEuler(E2);
    return out.copy(base).multiply(boneMatrix(mo, b, sim.row, M3)).multiply(M3.makeTranslation(0, mo.headY, 0))
      .multiply(M3.makeRotationFromQuaternion(Q2)).multiply(M3.makeTranslation(0, -mo.headY, 0));
  }
  function pieceMatrix(pl: Piece, geo: THREE.BufferGeometry, mo: Model, sim: Sim, flip: number, out: THREE.Matrix4): void {
    const tiltDeg = has(data.accessories, pl.m) ? data.accessories[pl.m]?.tilt ?? 0 : 0;
    const pose = placePiece(pl, mo.sk, tiltDeg, geo.boundingBox?.min.y ?? 0);
    E2.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
    Q2.setFromEuler(E2);
    P.set(pose.x, pose.y, pose.z);
    S.set(pose.sx, pose.sy, pose.sz);
    M2.compose(P, Q2, S);
    // The hourglass turns over at the end of its run.
    if (flip && pl.m === 'hourglass') M2.multiply(M3.makeRotationZ(flip));
    if (pose.follow === 'ground') {
      // Carried along by the body: it hops, turns and leans with it, and rocks on each landing,
      // but is not squashed with it (a mug does not breathe).
      E2.set(0, 0, sim.squash * 1.6, 'YXZ');
      Q2.setFromEuler(E2);
      P3.set(0, sim.y * mo.k + mo.lift, 0);
      S3.set(mo.k, mo.k, mo.k);
      out.compose(P3, Q, S3).multiply(M3.makeRotationFromQuaternion(Q2)).multiply(M2);
    } else if (pose.follow === 'neck') headMatrix(mo, sim, M, out, 0.7, 0).multiply(M2);   // under the visor: the fur there mostly goes with the face
    else if (pose.follow === 'body') out.copy(M).multiply(boneMatrix(mo, 0, sim.row, M3)).multiply(M2);
    else headMatrix(mo, sim, M, out).multiply(M2);
  }

  const tiles = new Set<Tile>();
  let raf = 0;
  let last = performance.now();
  let cursor = 0;
  let lost = false;
  const pointer = { x: -1, y: -1, seen: false };
  window.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.seen = true; }, { passive: true });
  // A lost context (driver reset, too many contexts elsewhere) comes back by itself: every head is redrawn then.
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; for (const t of tiles) t.dirty = true; wake(); });

  // The size the tile really takes on screen, transforms included (a graph zooms its nodes with CSS): `cssSize` alone
  // would leave a zoomed head blurry.
  function rectOf(t: Tile, now = performance.now()): DOMRect {
    if (!t.rect || now - t.rectAt > RECT_TTL_MS) { t.rect = t.canvas.getBoundingClientRect(); t.rectAt = now; }
    return t.rect;
  }
  function measure(t: Tile): { css: number; px: number } {
    const r = rectOf(t);
    // A transform only ever enlarges the drawing: a hop or a drop-in squashes a head below its own size for a
    // moment, and following it would reallocate the canvas (and redraw it from blank) several times a second.
    const css = Math.max(t.cssSize, r.width > 0 ? r.width : 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.max(8, Math.min(MAX_PX, Math.round(css * dpr)));
    // Hysteresis: a squash and stretch of a few percent keeps the canvas it has; a real zoom still resizes it.
    const had = t.canvas.width;
    if (had > 0 && Math.abs(px - had) / had < RESIZE_SLACK) return { css: had / dpr, px: had };
    return { css, px };
  }

  const perf = { since: performance.now(), frames: 0, draws: 0, drawMs: 0, maxDrawMs: 0, simMs: 0 };
  function stats(): EngineStats {
    const now = performance.now();
    const secs = Math.max(0.001, (now - perf.since) / 1000);
    let live = 0;
    let onPage = 0;
    for (const t of tiles) { if (t.canvas.isConnected) onPage += 1; if (t.live) live += 1; }
    const out: EngineStats = {
      seconds: +secs.toFixed(1), tiles: tiles.size, onPage, live, models: models.size,
      framesPerSecond: +(perf.frames / secs).toFixed(1), drawsPerSecond: +(perf.draws / secs).toFixed(1),
      msPerDraw: perf.draws ? +(perf.drawMs / perf.draws).toFixed(2) : 0, maxMsPerDraw: +perf.maxDrawMs.toFixed(2),
      // Share of each second spent in the mascots on the main thread (simulation + draw calls + copies).
      mainThreadPercent: +(((perf.drawMs + perf.simMs) / (secs * 1000)) * 100).toFixed(1),
    };
    Object.assign(perf, { since: now, frames: 0, draws: 0, drawMs: 0, maxDrawMs: 0, simMs: 0 });
    return out;
  }

  /** Renders the tile's head into its canvas, `px` pixels wide, with the fur detail of a `css`-pixel head. */
  function render(t: Tile, css: number, px: number): void {
    const rpx = Math.min(MAX_PX, Math.round(px * supersampleFor(css)));
    // The GL canvas keeps its size: each tile renders into its bottom-left corner (GL origin), read back from the top.
    renderer.setViewport(0, 0, rpx, rpx);
    const sim = t.sim;
    // Small heads get fewer, thicker and shorter strands on the light mesh: fine fur only turns into noise there.
    const shells = shellsFor(css);
    const mo = model(t.shape);
    furU.uDens.value = shells.dens;
    furU.uFurLen.value = mo.furLength * shells.len;
    fur.geometry = shells.lo ? mo.lo : mo.hi;
    visor.geometry = mo.visorGeo;
    fur.count = shells.n;
    furU.uShells.value = shells.n;
    uPose.value = mo.poseTex;
    uHeadY.value = mo.headY;
    furU.uPivL.value.copy(mo.pivL);
    furU.uPivR.value.copy(mo.pivR);
    visorU.uAspect.value = mo.aspect;
    furU.uColor.value.set(t.hex);
    furU.uVel.value.set(sim.vel[0], sim.vel[1], 0);
    furU.uFrame.value = sim.row;
    furU.uEar.value.set(sim.ear[0], sim.ear[1]);
    furU.uLook.value.set(sim.head[0], sim.head[1], sim.head[2]);
    visorU.uExpr.value = sim.from;
    visorU.uExpr2.value = sim.to;
    visorU.uMix.value = sim.mix;
    visorU.uBlink.value = sim.blink;
    visorU.uFrame.value = sim.row;
    visorU.uLook.value.copy(furU.uLook.value);
    visorU.uGlow.value = sim.glow;
    E.set(sim.pitch, sim.yaw, sim.roll, 'YXZ');
    Q.setFromEuler(E);
    const sy = 1 + sim.squash + sim.breath;
    const sxz = 1 - sim.squash * 0.55 - sim.breath * 0.4;
    S.set(sxz * mo.k, sy * mo.k, sxz * mo.k);
    P.set(0, sim.y * mo.k + mo.lift, 0);
    M.compose(P, Q, S);
    fur.matrix.copy(M);
    fur.matrixWorld.copy(M);
    visor.matrix.copy(M);
    visor.matrixWorld.copy(M);
    const list = piecesFor(t.acc);
    // An accessory stands beside or above the head: the camera steps back and aside so both stay in the tile.
    camera.position.set(list.length ? 0.1 : 0, CENTER_Y + (standsUp(list) ? 0.09 : 0), list.length ? dist * 1.18 : dist);
    camera.updateMatrixWorld();
    // The hourglass runs for eight seconds, turns over, and starts again; a still mascot shows it a third run.
    const cycle = t.live ? (sim.t % 9) / 9 : 0.31;
    const flip = cycle > 0.9 ? Math.PI * (0.5 - 0.5 * Math.cos((Math.PI * (cycle - 0.9)) / 0.1)) : 0;
    for (let i = 0; i < pieces.length; i += 1) {
      const mesh = pieces[i]!;
      const pl = list[i];
      const geo = pl ? accGeo(pl.m) : null;
      mesh.visible = !!geo;
      if (!pl || !geo) continue;
      mesh.geometry = geo;
      const clear = has(CLEAR, pl.m);
      const acc = clear ? glass : opaque;
      mesh.material = acc.mat;
      const mode = MOVES[pl.m] ?? CLEAR[pl.m] ?? 0;
      if (mode || clear) {
        // A still mascot stops every animation but the hourglass, which shows its sand at rest.
        acc.u.uMode.value = t.live || mode === 2 ? mode : 0;
        acc.u.uT.value = t.live ? sim.t : 0;
        acc.u.uPhase.value = Math.min(1, cycle / 0.88);
      } else acc.u.uMode.value = 0;
      pieceMatrix(pl, geo, mo, sim, flip, mesh.matrix);
      mesh.matrixWorld.copy(mesh.matrix);
    }
    renderer.render(scene, camera);
    const c = t.ctx;
    c.clearRect(0, 0, px, px);
    if (t.shadow) {
      const g = c.createRadialGradient(px / 2, px * 0.93, 0, px / 2, px * 0.93, px * 0.34);
      g.addColorStop(0, 'rgba(0,0,0,0.28)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.save();
      c.translate(px / 2, px * 0.93);
      c.scale(1, 0.22);
      c.translate(-px / 2, -px * 0.93);
      c.fillStyle = g;
      c.fillRect(0, 0, px, px);
      c.restore();
    }
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(canvas, 0, MAX_PX - rpx, rpx, rpx, 0, 0, px, px);
  }

  function draw(t: Tile): void {
    const t0 = performance.now();
    const { css, px } = measure(t);
    if (t.canvas.width !== px) { t.canvas.width = px; t.canvas.height = px; }
    render(t, css, px);
    t.dirty = false;
    t.drawnAt = performance.now();
    // Read by a screen that copies the head as a bitmap (the onboarding's avalanche): the modelled head is
    // on the canvas now, not the flat one painted while the models load.
    if (t.canvas.dataset.drawn !== '3d') t.canvas.dataset.drawn = '3d';
    if (t.onDrawn) { const done = t.onDrawn; t.onDrawn = null; done(); }
    const ms = t.drawnAt - t0;
    perf.draws += 1;
    perf.drawMs += ms;
    if (ms > perf.maxDrawMs) perf.maxDrawMs = ms;
  }

  function frame(now: number): void {
    raf = 0;
    if (now - last < MIN_FRAME_MS) { schedule(); return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Hidden tab: the loop stops here; `visibilitychange` wakes it.
    if (document.hidden) return;
    // Lost context: the loop sleeps; `webglcontextrestored` wakes it. Polling every frame would spin for as long as
    // the context stays away, which can be for good.
    if (lost) return;
    const list = [...tiles];
    let anyLive = false;
    perf.frames += 1;
    const s0 = performance.now();
    for (const t of list) {
      if (!t.live) continue;
      anyLive = true;
      let gaze: [number, number] | null = null;
      if (pointer.seen && t.canvas.isConnected) {
        const r = rectOf(t, now);
        if (r.width > 0) gaze = [(pointer.x - (r.left + r.width / 2)) / Math.max(200, r.width * 4), (pointer.y - (r.top + r.height / 2)) / Math.max(200, r.height * 4)];
      }
      stepSim(t.sim, dt, t.state, t.baseExpr, gaze);
      t.dirty = true;
    }
    perf.simMs += performance.now() - s0;
    // Round robin under a budget: due tiles first, starting after the last one served.
    let used = 0;
    const n = list.length;
    const start = n ? cursor % n : 0;
    const b0 = performance.now();
    for (let k = 0; k < n && used < BUDGET_MAX && (used < BUDGET_MIN || performance.now() - b0 < BUDGET_MS); k += 1) {
      const t = list[(start + k) % n]!;
      if (!t.canvas.isConnected) continue;
      const due = t.dirty && (!t.live || now - t.drawnAt >= 1000 / t.fps);
      if (!due) continue;
      draw(t);
      used += 1;
      cursor = start + k + 1;
    }
    // Nothing live and nothing left to draw: the loop sleeps until a prop changes.
    if (anyLive || list.some((t) => t.dirty)) schedule();
  }
  function schedule(): void { if (!raf && !lost) raf = requestAnimationFrame(frame); }
  function wake(): void { last = performance.now() - MIN_FRAME_MS; schedule(); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  // A zoom changes a still tile's on-screen size without any prop change: check now and then.
  window.setInterval(() => {
    if (document.hidden) return;
    let changed = false;
    for (const t of tiles) {
      if (!t.canvas.isConnected) continue;
      const { px } = measure(t);
      if (Math.abs(px - t.canvas.width) > t.canvas.width * 0.1) { t.dirty = true; changed = true; }
    }
    if (changed) wake();
  }, 500);

  function snapshot(look: SnapshotLook, pose: SnapshotPose, out: CanvasRenderingContext2D, css: number): boolean {
    if (lost) return false;
    const t0 = performance.now();
    const px = Math.max(8, Math.min(MAX_PX, out.canvas.width));
    // A throwaway tile, never registered: the round robin never sees it, and its sim is the still idle head.
    const t = createTile(out.canvas, out, createSim());
    t.hex = look.hex;
    t.shape = look.shape;
    t.acc = look.acc;
    t.cssSize = css;
    t.baseExpr = baseExpression(look.eyes);
    settle(t.sim, 'idle', t.baseExpr);
    // The split a live head uses when it follows the pointer: the skull turns some of the way, the face the rest.
    t.sim.yaw = pose.yaw * 0.5;
    t.sim.pitch = pose.pitch * 0.5;
    t.sim.head = [pose.yaw * 0.6, pose.pitch * 0.6, 0];
    render(t, css, px);
    const ms = performance.now() - t0;
    perf.draws += 1;
    perf.drawMs += ms;
    if (ms > perf.maxDrawMs) perf.maxDrawMs = ms;
    return true;
  }

  return {
    snapshot,
    add(t) { tiles.add(t); t.dirty = true; wake(); },
    remove(t) { tiles.delete(t); },
    touch(t) { t.dirty = true; wake(); },
    stats,
  };
}
