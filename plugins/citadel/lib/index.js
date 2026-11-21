// src/index.ts
import { readFile } from "node:fs/promises";

// src/state.ts
var RECENT_MS = 30 * 60 * 1e3;
var TEXT_MAX = 160;
var KEPT_STATUS = /* @__PURE__ */ new Set(["running", "waiting"]);
var isRow = (v) => typeof v === "object" && v !== null;
var str = (v) => typeof v === "string" && v ? v : null;
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
function clip(v, max = TEXT_MAX) {
  if (typeof v !== "string") return "";
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}
var LOOK_SHAPES = ["bean", "cloud", "gem", "hex", "round", "squircle", "tri"];
var LOOK_EYES = ["pill", "happy", "wink", "big", "sleepy", "sad", "angry", "surprised", "heart", "star", "x", "dots", "code", "squint", "quizzical", "skeptic"];
function normalizeLook(l) {
  if (!isRow(l)) return null;
  const { shape, color, eyes, acc } = l;
  if (typeof shape !== "string" || !LOOK_SHAPES.includes(shape) || typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return {
    shape,
    color: color.toLowerCase(),
    eyes: typeof eyes === "string" && LOOK_EYES.includes(eyes) ? eyes : "pill",
    acc: typeof acc === "string" && /^[a-z_]{1,20}$/.test(acc) ? acc : "none"
  };
}
function normalizeAgent(a) {
  if (!isRow(a) || typeof a.name !== "string") return null;
  return {
    name: a.name,
    role: str(a.role),
    project: str(a.project),
    reports_to: str(a.reports_to ?? a.reportsTo),
    orchestrator: str(a.orchestrator),
    icon_url: str(a.icon_url ?? a.iconUrl),
    main: a.main === true || a.is_main === true || a.isMain === true,
    look: normalizeLook(a.look)
  };
}
function normalizeProject(p) {
  if (!isRow(p) || typeof p.slug !== "string") return null;
  return { slug: p.slug, name: str(p.name) ?? p.slug, color: str(p.color), icon: str(p.icon), workspace: str(p.workspace) };
}
function filterMissions(rows, now = Date.now(), recentMs = RECENT_MS) {
  const out = [];
  for (const m of Array.isArray(rows) ? rows : []) {
    if (!isRow(m) || typeof m.id !== "string") continue;
    const agent = str(m.agent_name ?? m.agent);
    if (!agent) continue;
    const status = str(m.status) ?? "unknown";
    const ended = num(m.ended_at ?? m.endedAt);
    if (!KEPT_STATUS.has(status) && !(ended !== null && now - ended < recentMs)) continue;
    const title = clip(str(m.task_title) ?? str(m.title) ?? "", 80);
    out.push({
      id: m.id,
      agent_name: agent,
      status,
      title,
      started_at: num(m.started_at ?? m.startedAt),
      ended_at: ended,
      turn_active: typeof m.turn_active === "boolean" ? m.turn_active : status === "running" && ended === null && (typeof m.last_user_id === "number" && typeof m.last_result_id === "number" ? m.last_user_id > m.last_result_id : true)
    });
  }
  return out;
}
function normalizeQuestions(rows) {
  const out = [];
  for (const q of Array.isArray(rows) ? rows : []) {
    if (!isRow(q) || typeof q.id !== "string") continue;
    const agent = str(q.agent ?? q.agent_name);
    if (!agent) continue;
    const first = Array.isArray(q.questions) ? q.questions.find((x) => isRow(x) && typeof x.question === "string" && x.question !== "") : void 0;
    const plan = isRow(q.plan) ? q.plan : null;
    const text = first ? String(first.question) : plan && typeof plan.title === "string" ? plan.title : typeof q.text === "string" ? q.text : "";
    out.push({ id: q.id, agent_name: agent, mission_id: str(q.missionId ?? q.mission_id), text: clip(text) });
  }
  return out;
}

// src/index.ts
var name = "citadel";
var ASSETS = /* @__PURE__ */ new Map([
  ["office.glb", [new URL("../assets/office.glb", import.meta.url), "model/gltf-binary"]],
  ["mascot3d.json", [new URL("../assets/mascot3d.json", import.meta.url), "application/json"]]
]);
var errText = (e) => String(e instanceof Error ? e.message : e).slice(0, 120);
async function buildState(ctx, now = Date.now()) {
  const errors = [];
  const load = async (label, fn) => {
    try {
      const v = await fn();
      return Array.isArray(v) ? v : [];
    } catch (e) {
      errors.push(label + ": " + errText(e));
      return [];
    }
  };
  const [agents, projects, missions, questions] = await Promise.all([
    load("agents", () => ctx.agents.list()),
    load("projects", () => ctx.projects.list()),
    load("missions", () => ctx.missions.list({ limit: 300 })),
    load("questions", () => ctx.questions.list({ limit: 100 }))
  ]);
  return {
    generated_at: new Date(now).toISOString(),
    agents: agents.map(normalizeAgent).filter((a) => a !== null),
    projects: projects.map(normalizeProject).filter((p) => p !== null),
    missions: filterMissions(missions, now),
    questions: normalizeQuestions(questions),
    errors
  };
}
function apply(ctx) {
  const router = ctx.router();
  router.get("/state", async (_req, res) => {
    if (!ctx.user()) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    res.json(await buildState(ctx));
  });
  router.get("/assets/:name", async (req, res) => {
    if (!ctx.user()) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const entry = ASSETS.get(String(req.params.name));
    if (!entry) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [url, type] = entry;
    try {
      const buf = await readFile(url);
      res.set({ "Content-Type": type, "Cache-Control": "private, max-age=86400" });
      res.send(buf);
    } catch {
      res.status(404).json({ error: "Not found" });
    }
  });
}
export {
  apply,
  buildState,
  name
};
