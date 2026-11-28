# Citadel

A read-only 3D view of your Timon agents. Every workspace is an arc-shaped
platform around a central rotunda, every project a cutaway pavilion, and every
agent a **3D Tim**, Timon's plush mascot: standing at its desk when it works,
waiting beside it when it needs you, cross-eyed when a mission failed.

Official plugin (a `page` with a sidebar entry at `/citadel`), written on the
public plugin SDK only, with read-only permissions.

## What it shows

- **Spaces** (ring sectors) are the distinct workspaces of the projects;
  projects without one share an "Unassigned" space.
- **Pavilions** hold a project's team: the lead (role `main`) and the crew, with
  a desk and a bench each. Idle agents rest on the bench; working agents stand
  at their desk; agents with a pending question wave and glow amber; a failed
  mission in the last 30 minutes shows a red incident.
- **Look**: each Tim wears the mascot look set on the agent (`ctx.agents.list()`
  → `look`). An agent without one gets the default look of its job.
- **Central tower**: the first main agent without a project (or the top of the
  hierarchy when Timon reports one). More than 25 central agents are counted but
  not modelled.
- **Interface**: status bar, space list, a card per project or space, an
  activity journal, a toast when someone starts waiting for you, **Tour** and
  **Map**. Clicking a Tim or a badge opens its conversation.
- **Themes**: **Light** and **Mordor** (a dark, lava-lit variant). The switch is
  at the bottom right of the page; the choice is kept in the browser
  (`localStorage`).

## Permissions

All read-only: `agents:read` (name, role, project, mascot look),
`projects:read` (names, colours, workspaces), `missions:read` (running, waiting
and recently ended missions: title, status, times; prompts and costs never
reach the page) and `questions:read` (pending questions). The plugin writes
nothing, reads no file outside its package and makes no network request.

## How it works

- Host half (`src/index.ts`): `GET /state` builds one snapshot from the SDK
  facades (one failing source never breaks the others) and `GET /assets/:name`
  serves two allow-listed files, `assets/office.glb` and `assets/mascot3d.json`.
- Browser half (`src/client.tsx`, `src/app.ts`): registers the page and the
  sidebar link, polls `/state` every 5 s and rebuilds the scene only when its
  structure changes. `react` and `@timon/ui` come from the host; three.js,
  postprocessing and N8AO are bundled, with no CDN.
- `src/mapping.ts` and `src/state.ts` hold the pure logic (no I/O, no DOM);
  `src/tim3d.ts` ports the mascot engine of the web client (fur shells,
  expression atlas, simulation) into a Three.js scene.
- Texts live in `src/messages.json` (English first, then French) and go through
  the SDK translator.

## Develop

```bash
cd plugins/citadel
npm install                    # three, postprocessing, n8ao and the build tools
npm run build                  # lib/client.js (minified) and lib/index.js, both committed
npm run typecheck
npm test                       # state and model tests, run by the orchestrator test runner
```

## Third-party code

| Component | License |
| --- | --- |
| [three.js](https://threejs.org) 0.170 and its examples | MIT |
| [postprocessing](https://github.com/pmndrs/postprocessing) 6.36 | Zlib |
| [N8AO](https://github.com/N8python/n8ao) 1.10 | ISC |

They are npm dependencies and are bundled into `lib/client.js`. The 3D Tim data
(`assets/mascot3d.json`) is generated from the mascot's models; the office
model (`assets/office.glb`) was made for this plugin. The mascot is a Timon
mark (see `TRADEMARKS.md`).
