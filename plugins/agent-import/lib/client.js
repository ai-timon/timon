// src/client.tsx
import React5 from "react";
import * as ui3 from "@timon/ui";

// src/hooks.ts
import React from "react";

// src/contract.ts
var SOURCE_SLOT = "agentimport.source";
var IMPORT_ELEMENTS = ["soul", "memory", "skills", "mcp", "routines", "team"];
var DEFAULT_IMPORT_ROLE = "research";

// src/hooks.ts
var CONTEXT_KEY = /* @__PURE__ */ Symbol.for("timon.plugin.agent-import.context");
function agentImportContext() {
  const holder = globalThis;
  holder[CONTEXT_KEY] ??= React.createContext(null);
  return holder[CONTEXT_KEY];
}
function useAgentImport() {
  return React.useContext(agentImportContext());
}

// src/readers/limits.ts
var MiB = 1024 * 1024;
var SOURCE_MAX_BYTES = 500 * MiB;
var SOURCE_MAX_FILES = 5e3;
var FILE_MAX_BYTES = 10 * MiB;
var SKILL_MAX_BYTES = 10 * MiB;
var SKILL_MAX_FILES = 200;
var ZIP_UPLOAD_MAX_BYTES = 50 * MiB;
var ZIP_MAX_RATIO = 200;
var ZIP_RATIO_FLOOR_BYTES = 1 * MiB;
var DIR_MAX_VISITED = 1e5;
var DIR_MAX_DEPTH = 32;
var DEFAULT_READER_LIMITS = Object.freeze({
  maxBytes: SOURCE_MAX_BYTES,
  maxFiles: SOURCE_MAX_FILES,
  maxFileBytes: FILE_MAX_BYTES,
  maxSkillBytes: SKILL_MAX_BYTES,
  maxSkillFiles: SKILL_MAX_FILES,
  maxRatio: ZIP_MAX_RATIO,
  ratioFloorBytes: ZIP_RATIO_FLOOR_BYTES,
  maxVisited: DIR_MAX_VISITED,
  maxDepth: DIR_MAX_DEPTH
});

// src/assistant-state.ts
var IMPORT_ROLES = ["research", "coder", "reviewer", "merger", "librarian", "ops"];
var UPLOAD_MAX_BYTES = ZIP_UPLOAD_MAX_BYTES;
function shownChoice(agent, choice) {
  const elements = {};
  for (const element of IMPORT_ELEMENTS) {
    const shown = agent.elements?.[element];
    if (shown) elements[element] = choice?.elements?.[element] ?? shown.selected;
  }
  return {
    include: choice?.include ?? agent.action !== "skip",
    /** The engine skips this agent on its own (changed by hand, no free name): the user cannot force it. */
    lockedOut: agent.action === "skip" && choice?.include === void 0,
    name: choice?.name ?? agent.finalName ?? agent.displayName,
    role: choice?.role ?? agent.role ?? DEFAULT_IMPORT_ROLE,
    project: choice?.project !== void 0 ? choice.project : agent.project ?? null,
    cwd: choice?.cwd !== void 0 ? choice.cwd : agent.cwd ?? null,
    elements,
    /** Routines on at the source stay on only when the user says so: off by default. */
    keepRoutinesActive: choice?.keepRoutinesActive === true
  };
}
function mergeChoices(previous, preview) {
  const next = {};
  for (const agent of preview.agents) next[agent.sourceRef] = previous[agent.sourceRef] ?? { sourceRef: agent.sourceRef };
  return next;
}
function importOptions(sourceId, preview, choices) {
  const agents = (preview?.agents ?? []).map((agent) => choices[agent.sourceRef]).filter((choice) => choice !== void 0).map((choice) => {
    const out = { ...choice };
    if (choice.name !== void 0) out.name = choice.name.trim() || void 0;
    if (out.name === void 0) delete out.name;
    if (choice.cwd !== void 0) out.cwd = choice.cwd?.trim() || null;
    return out;
  });
  return { ...sourceId ? { source: sourceId } : {}, agents };
}
function requestBody(token, ready, options) {
  return ready ? { token, options } : { token };
}
function applySummary(preview, choices) {
  let included = 0;
  let updated = 0;
  for (const agent of preview?.agents ?? []) {
    const choice = choices[agent.sourceRef];
    if (agent.action === "skip" || choice?.include === false) continue;
    included += 1;
    if (agent.action === "update") updated += 1;
  }
  return { included, updated };
}
var KNOWN_CODES = /* @__PURE__ */ new Set([
  "unauthorized",
  "forbidden",
  "invalid",
  "unsupported_media_type",
  "not_a_zip",
  "empty",
  "too_large",
  "too_many",
  "not_found",
  "archive_changed",
  "invalid_manifest",
  "not_implemented",
  "internal"
]);
var HERMES_CODES = /* @__PURE__ */ new Set(["not_found", "too_large", "archive_changed"]);
function failureOf(step, status, body) {
  const record = body !== null && typeof body === "object" ? body : {};
  const code = typeof record.code === "string" ? record.code : "";
  const error = typeof record.error === "string" ? record.error : "";
  if (step === "hermes/stage" && HERMES_CODES.has(code)) return { key: `errors.hermes.${code}` };
  if (step === "stage" && status === 400 && error === "invalid JSON body") return { key: "errors.uploadUnavailable" };
  if (KNOWN_CODES.has(code)) {
    if (code === "too_large") return { key: "errors.too_large", vars: { size: UPLOAD_MAX_BYTES / (1024 * 1024) } };
    return { key: `errors.${code}` };
  }
  if (status === 401) return { key: "errors.unauthorized" };
  if (status === 403) return { key: "errors.forbidden" };
  if (error) return { text: error };
  return { key: "errors.network" };
}
function fileFailure(file) {
  if (file.size === 0) return { key: "errors.empty" };
  if (file.size > UPLOAD_MAX_BYTES) return { key: "errors.too_large", vars: { size: UPLOAD_MAX_BYTES / (1024 * 1024) } };
  return null;
}

// src/export-dialog.tsx
import React2 from "react";
import * as ui from "@timon/ui";

// src/export-state.ts
var EXPORT_DIALOG_MAX = 100;
var EXPORT_ERROR_CODES = ["unauthorized", "forbidden", "invalid", "not_found", "too_many", "too_large"];
function toggled(selected, name) {
  return selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
}
function toggledAll(selected, agents) {
  const all = agents.map((a) => a.name);
  return all.every((name) => selected.includes(name)) ? [] : all;
}
function kept(selected, agents) {
  return agents.map((a) => a.name).filter((name) => selected.includes(name));
}
function exportBody(selected) {
  if (selected.length === 0 || selected.length > EXPORT_DIALOG_MAX) return null;
  return { agents: [...selected] };
}
function exportFileName(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `timon-agents-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`;
}
function exportFailureKey(status, body) {
  const record = body !== null && typeof body === "object" ? body : {};
  const code = typeof record.code === "string" ? record.code : "";
  if (EXPORT_ERROR_CODES.includes(code)) return `export.errors.${code}`;
  if (status === 401) return "export.errors.unauthorized";
  if (status === 403) return "export.errors.forbidden";
  if (status === 404) return "export.errors.unavailable";
  return "export.errors.network";
}

// src/messages.json
var messages_default = {
  en: {
    title: "Agent import",
    intro: "Bring the agents you already have in Hermes, Grok Bot, another agent tool or another Timon into this one. You will see what will be created before anything is written.",
    open: "Import agents",
    openOnboarding: "I already have agents elsewhere: import them",
    dialogDescription: "Pick where your agents come from, check the preview, then import.",
    "closeConfirm.title": "Close the import?",
    "closeConfirm.body": "The archive you sent is dropped, and nothing is imported.",
    "closeConfirm.yes": "Close",
    sources: "Where are your agents?",
    noSource: "No source is available yet.",
    "timonSource.label": "Timon agent archive (.zip)",
    "timonSource.description": "Agents exported from another Timon: Export on its Agents page, or timon agent export.",
    pickZip: "Choose a .zip file",
    staging: "Sending the archive\u2026",
    previewing: "Reading the archive\u2026",
    applying: "Importing\u2026",
    "hermesSource.label": "Hermes on the machine running Timon",
    "hermesSource.description": "Found in {label}. Pick the profiles to bring over: nothing to export first.",
    "hermesSource.profiles": "Hermes profiles",
    "hermesSource.import": "Import from Hermes",
    "errors.hermes.not_found": "Hermes, or one of these profiles, is no longer on the machine running Timon.",
    "errors.hermes.too_large": "This Hermes profile is too large to import.",
    "errors.hermes.archive_changed": "Hermes changed its files while they were read: try again.",
    "preview.title": "Preview",
    "preview.archive": "Archive of {size}, kept until {time}.",
    "preview.notReady": "The import engine is not installed yet: the archive was received, but nothing can be read or imported from it for now.",
    "preview.empty": "This archive holds no agent to import.",
    "preview.count": "{count} agent(s) found.",
    "preview.refresh": "Update the preview",
    "preview.back": "Start over",
    "preview.apply": "Import {count} agent(s)",
    "preview.warnings": "To know before importing",
    "action.create": "New",
    "action.update": "Replaces an earlier import",
    "action.skip": "Skipped",
    "agent.include": "Import this agent",
    "agent.from": "From: {name}",
    "agent.name": "Name in Timon",
    "agent.role": "Role",
    "agent.project": "Project",
    "agent.projectNone": "No project (bot)",
    "agent.cwd": "Working folder",
    "agent.cwdNone": "None",
    "agent.cwdMissing": "This folder does not exist on this machine: pick another one, or leave it empty.",
    "agent.cwdSuggested": "The folder of the source does not exist here. This one looks like it: {path}",
    "agent.cwdUse": "Use it",
    "agent.elements": "What to bring",
    "agent.routinesActive": "Keep active the {count} routine(s) that run at the source",
    "agent.routinesActiveHint": "Off by default: an active routine starts tasks on its own, on its schedule. Leave it off to check the routines first.",
    "role.research": "Research",
    "role.coder": "Code",
    "role.reviewer": "Review",
    "role.merger": "Merge",
    "role.librarian": "Documentation",
    "role.ops": "Operations",
    "element.soul": "Identity (SOUL)",
    "element.memory": "Memory",
    "element.skills": "Skills",
    "element.mcp": "MCP servers",
    "element.routines": "Routines",
    "element.team": "Team",
    elementCount: "{label} \xB7 {count}",
    "confirm.title": "Import {count} agent(s)?",
    "confirm.body": "The agents are created in Timon with what you selected.",
    "confirm.bodyUpdate": "{updated} of them replace an earlier import of the same agent.",
    "confirm.yes": "Import",
    "result.title": "Import finished",
    "result.created": "Created",
    "result.updated": "Updated",
    "result.skipped": "Skipped",
    "result.failed": "Failed, nothing kept",
    "result.summary": "{ok} imported, {failed} failed.",
    "result.again": "Import more agents",
    "result.done": "Done",
    "errors.unauthorized": "Sign in to import agents.",
    "errors.forbidden": "Your account is not allowed to create agents.",
    "errors.invalid": "The request was refused as malformed.",
    "errors.unsupported_media_type": "Only a .zip archive can be sent.",
    "errors.not_a_zip": "This file is not a zip archive.",
    "errors.empty": "This file is empty.",
    "errors.too_large": "The archive is larger than {size} MiB.",
    "errors.too_many": "Too many imports are waiting: finish or close one, then try again.",
    "errors.not_found": "This archive expired or was already used: send it again.",
    "errors.archive_changed": "The archive changed since it was sent: send it again.",
    "errors.not_implemented": "The import engine is not installed yet: nothing was imported.",
    "errors.internal": "The import failed on the daemon side.",
    "errors.network": "The daemon did not answer. Try again.",
    "errors.uploadUnavailable": "Sending an archive from the browser is not available yet in this version of Timon.",
    "errors.invalid_manifest": "This archive holds no agent Timon can read: check that it is an agent export.",
    "otherAgentSource.label": "Grok Bot, Hermes or another agent",
    "otherAgentSource.description": "Copy Timon's export skill, paste it to the other agent (Hermes, Grok Bot\u2026) and ask it to save it as a skill named timon-export. Then ask it: Export my agents for Timon, and pick the .zip it makes.",
    "otherAgentSource.copySkill": "Copy the export skill",
    "otherAgentSource.skillCopied": "Copied",
    "otherAgentSource.copyFailed": "The export skill could not be copied: check that you are signed in, then try again.",
    "export.open": "Export",
    "export.title": "Export agents",
    "export.description": "Pick the agents to carry to another Timon. You get a .zip to import there.",
    "export.loading": "Loading the agents\u2026",
    "export.empty": "There is no agent to export.",
    "export.all": "All agents ({count})",
    "export.secrets": "Secrets, conversations and logs are not in the archive: only the names of the secrets, to enter again on the other side.",
    "export.tooMany": "An archive holds {max} agents at most: export them in several parts.",
    "export.run": "Export {count} agent(s)",
    "export.running": "Exporting\u2026",
    "export.done": "{count} agent(s) exported: the archive is in your downloads.",
    "export.errors.unauthorized": "Sign in to export agents.",
    "export.errors.forbidden": "Your account is not allowed to read agents.",
    "export.errors.invalid": "The request was refused as malformed.",
    "export.errors.not_found": "An agent of the selection no longer exists: reopen the list.",
    "export.errors.too_many": "An archive holds 100 agents at most: export them in several parts.",
    "export.errors.too_large": "These agents do not fit in one archive: export them in several parts.",
    "export.errors.unavailable": "The export is not available on this Timon.",
    "export.errors.network": "The daemon did not answer. Try again.",
    "export.one": "Export",
    "export.failed": "Could not export {name}",
    "export.ok": "OK",
    openIcon: "Import agents"
  },
  fr: {
    title: "Import d'agents",
    intro: "Faites venir dans ce Timon les agents que vous avez d\xE9j\xE0 dans Hermes, Grok Bot, un autre outil d'agents ou un autre Timon. Vous verrez ce qui sera cr\xE9\xE9 avant que rien ne soit \xE9crit.",
    open: "Importer des agents",
    openOnboarding: "J'ai d\xE9j\xE0 des agents ailleurs : les importer",
    dialogDescription: "Choisissez d'o\xF9 viennent vos agents, v\xE9rifiez l'aper\xE7u, puis importez.",
    "closeConfirm.title": "Fermer l'import ?",
    "closeConfirm.body": "L'archive envoy\xE9e est abandonn\xE9e, et rien n'est import\xE9.",
    "closeConfirm.yes": "Fermer",
    sources: "O\xF9 sont vos agents ?",
    noSource: "Aucune source n'est encore disponible.",
    "timonSource.label": "Archive d'agents Timon (.zip)",
    "timonSource.description": "Des agents export\xE9s d'un autre Timon : Exporter sur sa page Agents, ou timon agent export.",
    pickZip: "Choisir un fichier .zip",
    staging: "Envoi de l'archive\u2026",
    previewing: "Lecture de l'archive\u2026",
    applying: "Import en cours\u2026",
    "hermesSource.label": "Hermes sur la machine o\xF9 tourne Timon",
    "hermesSource.description": "Trouv\xE9 dans {label}. Choisissez les profils \xE0 faire venir : rien \xE0 exporter avant.",
    "hermesSource.profiles": "Profils Hermes",
    "hermesSource.import": "Importer depuis Hermes",
    "errors.hermes.not_found": "Hermes, ou l'un de ces profils, n'est plus sur la machine o\xF9 tourne Timon.",
    "errors.hermes.too_large": "Ce profil Hermes est trop volumineux pour \xEAtre import\xE9.",
    "errors.hermes.archive_changed": "Hermes a modifi\xE9 ses fichiers pendant leur lecture : r\xE9essayez.",
    "preview.title": "Aper\xE7u",
    "preview.archive": "Archive de {size}, conserv\xE9e jusqu'\xE0 {time}.",
    "preview.notReady": "Le moteur d'import n'est pas encore install\xE9 : l'archive est bien re\xE7ue, mais rien ne peut encore en \xEAtre lu ni import\xE9.",
    "preview.empty": "Cette archive ne contient aucun agent \xE0 importer.",
    "preview.count": "{count} agent(s) trouv\xE9(s).",
    "preview.refresh": "Mettre \xE0 jour l'aper\xE7u",
    "preview.back": "Recommencer",
    "preview.apply": "Importer {count} agent(s)",
    "preview.warnings": "\xC0 savoir avant d'importer",
    "action.create": "Nouveau",
    "action.update": "Remplace un import pr\xE9c\xE9dent",
    "action.skip": "Ignor\xE9",
    "agent.include": "Importer cet agent",
    "agent.from": "Source : {name}",
    "agent.name": "Nom dans Timon",
    "agent.role": "R\xF4le",
    "agent.project": "Projet",
    "agent.projectNone": "Sans projet (bot)",
    "agent.cwd": "Dossier de travail",
    "agent.cwdNone": "Aucun",
    "agent.cwdMissing": "Ce dossier n'existe pas sur cette machine : choisissez-en un autre, ou laissez vide.",
    "agent.cwdSuggested": "Le dossier de la source n'existe pas ici. Celui-ci lui ressemble : {path}",
    "agent.cwdUse": "Utiliser",
    "agent.elements": "Ce qui est repris",
    "agent.routinesActive": "Garder actives les {count} routine(s) qui tournent \xE0 la source",
    "agent.routinesActiveHint": "D\xE9sactiv\xE9 par d\xE9faut : une routine active lance des t\xE2ches toute seule, \xE0 son horaire. Laissez d\xE9sactiv\xE9 pour v\xE9rifier les routines d'abord.",
    "role.research": "Recherche",
    "role.coder": "Code",
    "role.reviewer": "Relecture",
    "role.merger": "Int\xE9gration",
    "role.librarian": "Documentation",
    "role.ops": "Exploitation",
    "element.soul": "Identit\xE9 (SOUL)",
    "element.memory": "M\xE9moire",
    "element.skills": "Skills",
    "element.mcp": "Serveurs MCP",
    "element.routines": "Routines",
    "element.team": "\xC9quipe",
    elementCount: "{label} \xB7 {count}",
    "confirm.title": "Importer {count} agent(s) ?",
    "confirm.body": "Les agents sont cr\xE9\xE9s dans Timon avec ce que vous avez coch\xE9.",
    "confirm.bodyUpdate": "{updated} d'entre eux remplacent un import pr\xE9c\xE9dent du m\xEAme agent.",
    "confirm.yes": "Importer",
    "result.title": "Import termin\xE9",
    "result.created": "Cr\xE9\xE9",
    "result.updated": "Mis \xE0 jour",
    "result.skipped": "Ignor\xE9",
    "result.failed": "\xC9chec, rien n'a \xE9t\xE9 gard\xE9",
    "result.summary": "{ok} import\xE9(s), {failed} en \xE9chec.",
    "result.again": "Importer d'autres agents",
    "result.done": "Termin\xE9",
    "errors.unauthorized": "Connectez-vous pour importer des agents.",
    "errors.forbidden": "Votre compte n'a pas le droit de cr\xE9er des agents.",
    "errors.invalid": "La requ\xEAte a \xE9t\xE9 refus\xE9e comme mal form\xE9e.",
    "errors.unsupported_media_type": "Seule une archive .zip peut \xEAtre envoy\xE9e.",
    "errors.not_a_zip": "Ce fichier n'est pas une archive zip.",
    "errors.empty": "Ce fichier est vide.",
    "errors.too_large": "L'archive d\xE9passe {size} Mio.",
    "errors.too_many": "Trop d'imports sont en attente : terminez-en ou fermez-en un, puis r\xE9essayez.",
    "errors.not_found": "Cette archive a expir\xE9 ou a d\xE9j\xE0 servi : renvoyez-la.",
    "errors.archive_changed": "L'archive a chang\xE9 depuis son envoi : renvoyez-la.",
    "errors.not_implemented": "Le moteur d'import n'est pas encore install\xE9 : rien n'a \xE9t\xE9 import\xE9.",
    "errors.internal": "L'import a \xE9chou\xE9 c\xF4t\xE9 daemon.",
    "errors.network": "Le daemon n'a pas r\xE9pondu. R\xE9essayez.",
    "errors.uploadUnavailable": "L'envoi d'une archive depuis le navigateur n'est pas encore disponible dans cette version de Timon.",
    "errors.invalid_manifest": "Cette archive ne contient aucun agent lisible par Timon : v\xE9rifiez qu'il s'agit bien d'un export d'agents.",
    "otherAgentSource.label": "Grok Bot, Hermes ou un autre agent",
    "otherAgentSource.description": "Copiez le skill d'export de Timon, collez-le \xE0 l'autre agent (Hermes, Grok Bot\u2026) et demandez-lui de l'enregistrer comme skill nomm\xE9 timon-export. Demandez-lui ensuite : Export my agents for Timon, puis choisissez le .zip qu'il produit.",
    "otherAgentSource.copySkill": "Copier le skill d'export",
    "otherAgentSource.skillCopied": "Copi\xE9",
    "otherAgentSource.copyFailed": "Le skill d'export n'a pas pu \xEAtre copi\xE9 : v\xE9rifiez que vous \xEAtes connect\xE9, puis r\xE9essayez.",
    "export.open": "Exporter",
    "export.title": "Exporter des agents",
    "export.description": "Choisissez les agents \xE0 emporter vers un autre Timon. Vous obtenez un .zip \xE0 importer l\xE0-bas.",
    "export.loading": "Chargement des agents\u2026",
    "export.empty": "Il n'y a aucun agent \xE0 exporter.",
    "export.all": "Tous les agents ({count})",
    "export.secrets": "Les secrets, conversations et journaux ne sont pas dans l'archive : seulement les noms des secrets, \xE0 saisir de nouveau de l'autre c\xF4t\xE9.",
    "export.tooMany": "Une archive contient {max} agents au plus : exportez-les en plusieurs fois.",
    "export.run": "Exporter {count} agent(s)",
    "export.running": "Export en cours\u2026",
    "export.done": "{count} agent(s) export\xE9(s) : l'archive est dans vos t\xE9l\xE9chargements.",
    "export.errors.unauthorized": "Connectez-vous pour exporter des agents.",
    "export.errors.forbidden": "Votre compte n'a pas le droit de lire les agents.",
    "export.errors.invalid": "La demande a \xE9t\xE9 refus\xE9e comme mal form\xE9e.",
    "export.errors.not_found": "Un agent de la s\xE9lection n'existe plus : rouvrez la liste.",
    "export.errors.too_many": "Une archive contient 100 agents au plus : exportez-les en plusieurs fois.",
    "export.errors.too_large": "Ces agents ne tiennent pas dans une seule archive : exportez-les en plusieurs fois.",
    "export.errors.unavailable": "L'export n'est pas disponible sur ce Timon.",
    "export.errors.network": "Le daemon n'a pas r\xE9pondu. R\xE9essayez.",
    "export.one": "Exporter",
    "export.failed": "Impossible d'exporter {name}",
    "export.ok": "OK",
    openIcon: "Importer des agents"
  }
};

// src/export-dialog.tsx
var t = ui.createTranslator(messages_default);
var Button2 = ui.Button;
var Switch2 = ui.Switch;
var Label2 = ui.Label;
var Dialog2 = ui.Dialog;
var DialogContent2 = ui.DialogContent;
var DialogHeader2 = ui.DialogHeader;
var DialogTitle2 = ui.DialogTitle;
var DialogDescription2 = ui.DialogDescription;
async function bodyOf(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function ExportBody({ api }) {
  const [agents, setAgents] = React2.useState(null);
  const [selected, setSelected] = React2.useState([]);
  const [busy, setBusy] = React2.useState(false);
  const [error, setError] = React2.useState(null);
  const [done, setDone] = React2.useState(null);
  const id = React2.useId();
  React2.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await api("agents");
        const json = await bodyOf(response);
        if (!live) return;
        if (!response.ok) {
          setError(t(exportFailureKey(response.status, json)));
          setAgents([]);
          return;
        }
        const list = json?.agents ?? [];
        setAgents(list);
        setSelected((current) => kept(current, list));
      } catch {
        if (live) {
          setError(t("export.errors.network"));
          setAgents([]);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);
  const body = exportBody(selected);
  const run = async () => {
    if (!body) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await api("export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        setError(t(exportFailureKey(response.status, await bodyOf(response))));
        return;
      }
      save(await response.blob(), exportFileName(/* @__PURE__ */ new Date()));
      setDone(t("export.done", { count: body.agents.length }));
    } catch {
      setError(t("export.errors.network"));
    } finally {
      setBusy(false);
    }
  };
  if (agents === null) return /* @__PURE__ */ React2.createElement("p", { className: "text-sm text-muted-foreground" }, t("export.loading"));
  const everyone = agents.length > 0 && agents.every((a) => selected.includes(a.name));
  return /* @__PURE__ */ React2.createElement("div", { className: "flex flex-col gap-4" }, agents.length === 0 && !error && /* @__PURE__ */ React2.createElement("p", { className: "text-sm text-muted-foreground" }, t("export.empty")), agents.length > 0 && /* @__PURE__ */ React2.createElement(React2.Fragment, null, /* @__PURE__ */ React2.createElement("div", { className: "flex items-center gap-3" }, /* @__PURE__ */ React2.createElement(
    Switch2,
    {
      id: `${id}-all`,
      checked: everyone,
      disabled: busy,
      onCheckedChange: () => setSelected((current) => toggledAll(current, agents))
    }
  ), /* @__PURE__ */ React2.createElement(Label2, { htmlFor: `${id}-all`, className: "text-sm font-medium" }, t("export.all", { count: agents.length }))), /* @__PURE__ */ React2.createElement("ul", { className: "flex max-h-80 flex-col gap-1 overflow-y-auto" }, agents.map((agent, index) => /* @__PURE__ */ React2.createElement("li", { key: agent.name, className: "flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40" }, /* @__PURE__ */ React2.createElement(
    Switch2,
    {
      id: `${id}-${index}`,
      checked: selected.includes(agent.name),
      disabled: busy,
      onCheckedChange: () => setSelected((current) => toggled(current, agent.name))
    }
  ), /* @__PURE__ */ React2.createElement(Label2, { htmlFor: `${id}-${index}`, className: "flex min-w-0 flex-1 flex-col" }, /* @__PURE__ */ React2.createElement("span", { className: "truncate text-sm" }, agent.name), (agent.role || agent.project) && /* @__PURE__ */ React2.createElement("span", { className: "truncate text-xs text-muted-foreground" }, [agent.role, agent.project].filter(Boolean).join(" \xB7 "))))))), /* @__PURE__ */ React2.createElement("p", { className: "rounded-md bg-muted/40 p-3 text-xs text-muted-foreground" }, t("export.secrets")), selected.length > EXPORT_DIALOG_MAX && /* @__PURE__ */ React2.createElement("p", { role: "alert", className: "text-sm text-destructive" }, t("export.tooMany", { max: EXPORT_DIALOG_MAX })), error && /* @__PURE__ */ React2.createElement("p", { role: "alert", className: "rounded-md bg-destructive/10 p-3 text-sm text-destructive" }, error), done && /* @__PURE__ */ React2.createElement("p", { role: "status", className: "text-sm text-muted-foreground" }, done), /* @__PURE__ */ React2.createElement("div", { className: "flex justify-end" }, /* @__PURE__ */ React2.createElement(Button2, { disabled: busy || body === null, onClick: () => void run() }, busy ? t("export.running") : t("export.run", { count: selected.length }))));
}
function ExportDialog({ api, open, onOpenChange }) {
  return /* @__PURE__ */ React2.createElement(Dialog2, { open, onOpenChange }, /* @__PURE__ */ React2.createElement(DialogContent2, { style: { maxWidth: 560, maxHeight: "85vh", overflowY: "auto" } }, /* @__PURE__ */ React2.createElement(DialogHeader2, null, /* @__PURE__ */ React2.createElement(DialogTitle2, null, t("export.title")), /* @__PURE__ */ React2.createElement(DialogDescription2, null, t("export.description"))), open && /* @__PURE__ */ React2.createElement(ExportBody, { api })));
}
function ExportEntry({ api }) {
  const [open, setOpen] = React2.useState(false);
  return /* @__PURE__ */ React2.createElement(React2.Fragment, null, /* @__PURE__ */ React2.createElement(Button2, { size: "sm", variant: "outline", className: "h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium", onClick: () => setOpen(true) }, /* @__PURE__ */ React2.createElement("svg", { viewBox: "0 0 24 24", className: "size-3.5", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, /* @__PURE__ */ React2.createElement("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }), /* @__PURE__ */ React2.createElement("path", { d: "m17 8-5-5-5 5" }), /* @__PURE__ */ React2.createElement("path", { d: "M12 3v12" })), t("export.open")), /* @__PURE__ */ React2.createElement(ExportDialog, { api, open, onOpenChange: setOpen }));
}
var MenuItem = ui.DropdownMenuItem;
async function exportOne(api, name) {
  const body = exportBody([name]);
  if (!body) return "export.errors.invalid";
  try {
    const response = await api("export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) return exportFailureKey(response.status, await bodyOf(response));
    save(await response.blob(), exportFileName(/* @__PURE__ */ new Date()));
    return null;
  } catch {
    return "export.errors.network";
  }
}
function ExportAgentMenuItem({ api }) {
  const agent = ui.useAgentMenuItem();
  if (!agent) return null;
  return /* @__PURE__ */ React2.createElement(
    MenuItem,
    {
      onSelect: () => {
        void exportOne(api, agent.name).then((failure) => {
          if (failure) void ui.confirmAction({ title: t("export.failed", { name: agent.name }), description: t(failure), confirmLabel: t("export.ok") });
        });
      }
    },
    t("export.one")
  );
}

// src/sources/openbot-client.tsx
import React3 from "react";
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
async function copyExportSkill(api) {
  try {
    const response = await api("export-skill");
    if (!response.ok) return false;
    return await copyText(await response.text());
  } catch {
    return false;
  }
}
var COPIED_MS = 2e3;
function OpenBotSource({ label, description, skillLabel, skillCopied, skillFailed, api }) {
  const value = useAgentImport();
  const register = value?.registerSource;
  const [failed, setFailed] = React3.useState(false);
  const [copied, setCopied] = React3.useState(false);
  const run = React3.useCallback(async () => {
    const ok = await copyExportSkill(api);
    setFailed(!ok);
    setCopied(ok);
  }, [api]);
  React3.useEffect(() => {
    if (!copied) return void 0;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const actionLabel = copied ? skillCopied : skillLabel;
  React3.useEffect(
    () => register?.({ id: "openbot", label, description, accepts: ["zip"], action: { label: actionLabel, run } }),
    [register, label, description, actionLabel, run]
  );
  return failed ? /* @__PURE__ */ React3.createElement("p", { role: "alert", className: "text-sm text-destructive" }, skillFailed) : null;
}

// src/sources/hermes-client.tsx
import React4 from "react";
import * as ui2 from "@timon/ui";
var t2 = ui2.createTranslator(messages_default);
var Button4 = ui2.Button;
var HERMES_SOURCE_ID = "hermes";
function HermesSource({ detect, stage }) {
  const value = useAgentImport();
  const [found, setFound] = React4.useState(null);
  const [checked, setChecked] = React4.useState(/* @__PURE__ */ new Set());
  const id = React4.useId();
  React4.useEffect(() => {
    let live = true;
    detect().then((answer) => {
      if (!live || !answer?.found || answer.profiles.length === 0) return;
      setFound({ label: answer.label ?? "", profiles: answer.profiles });
      setChecked(new Set(answer.profiles.map((p) => p.name)));
    }).catch(() => void 0);
    return () => {
      live = false;
    };
  }, [detect]);
  if (!value || !found) return null;
  const chosen = found.profiles.map((p) => p.name).filter((name) => checked.has(name));
  const toggle = (name, on) => {
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  };
  return /* @__PURE__ */ React4.createElement("div", { className: "flex flex-col gap-3 rounded-lg bg-muted/40 p-3", "data-source": HERMES_SOURCE_ID }, /* @__PURE__ */ React4.createElement("div", { className: "flex min-w-0 flex-col gap-0.5" }, /* @__PURE__ */ React4.createElement("span", { className: "text-sm font-medium" }, t2("hermesSource.label")), /* @__PURE__ */ React4.createElement("span", { className: "text-xs text-muted-foreground" }, t2("hermesSource.description", { label: found.label }))), /* @__PURE__ */ React4.createElement("fieldset", { className: "flex flex-wrap gap-x-4 gap-y-2", disabled: value.busy }, /* @__PURE__ */ React4.createElement("legend", { className: "sr-only" }, t2("hermesSource.profiles")), found.profiles.map((profile) => /* @__PURE__ */ React4.createElement("label", { key: profile.name, htmlFor: `${id}-${profile.name}`, className: "flex items-center gap-2 text-sm" }, /* @__PURE__ */ React4.createElement(
    "input",
    {
      id: `${id}-${profile.name}`,
      type: "checkbox",
      name: profile.name,
      className: "h-4 w-4 accent-primary",
      checked: checked.has(profile.name),
      onChange: (event) => toggle(profile.name, event.target.checked)
    }
  ), profile.displayName))), /* @__PURE__ */ React4.createElement("div", { className: "flex justify-end" }, /* @__PURE__ */ React4.createElement(
    Button4,
    {
      size: "sm",
      disabled: value.busy || chosen.length === 0,
      onClick: () => void value.submitStaged(HERMES_SOURCE_ID, () => stage(chosen))
    },
    t2("hermesSource.import")
  )));
}

// src/client.tsx
var t3 = ui3.createTranslator(messages_default);
var Slot2 = ui3.Slot;
var Button6 = ui3.Button;
var TooltipProvider2 = ui3.TooltipProvider;
var Tooltip2 = ui3.Tooltip;
var TooltipTrigger2 = ui3.TooltipTrigger;
var TooltipContent2 = ui3.TooltipContent;
var Input2 = ui3.Input;
var Label4 = ui3.Label;
var Switch4 = ui3.Switch;
var Select2 = ui3.Select;
var SelectTrigger2 = ui3.SelectTrigger;
var SelectValue2 = ui3.SelectValue;
var SelectContent2 = ui3.SelectContent;
var SelectItem2 = ui3.SelectItem;
var Dialog4 = ui3.Dialog;
var DialogContent4 = ui3.DialogContent;
var DialogHeader4 = ui3.DialogHeader;
var DialogTitle4 = ui3.DialogTitle;
var DialogDescription4 = ui3.DialogDescription;
var TIMON_SOURCE = {
  id: "timon",
  label: t3("timonSource.label"),
  description: t3("timonSource.description"),
  accepts: ["zip"]
};
var INITIAL = {
  step: "source",
  staged: null,
  warnings: [],
  sourceId: null,
  preview: null,
  ready: false,
  choices: {},
  result: null,
  busy: false,
  error: null
};
function say(failure) {
  return "text" in failure ? failure.text : t3(failure.key, failure.vars);
}
var CallFailure = class extends Error {
  constructor(failure) {
    super("agent import call failed");
    this.failure = failure;
    this.name = "CallFailure";
  }
  failure;
};
var networkFailure = { key: "errors.network" };
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
async function sendArchive(api, file) {
  let response;
  try {
    response = await api("stage", { method: "POST", headers: { "content-type": "application/zip" }, body: file });
  } catch {
    throw new CallFailure(networkFailure);
  }
  const json = await readJson(response);
  if (!response.ok) throw new CallFailure(failureOf("stage", response.status, json));
  return json;
}
async function detectHermes(api) {
  try {
    const response = await api("hermes", { method: "GET" });
    return response.ok ? await readJson(response) : null;
  } catch {
    return null;
  }
}
async function stageHermes(api, profiles) {
  let response;
  try {
    response = await api("hermes/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles })
    });
  } catch {
    throw new CallFailure(networkFailure);
  }
  const json = await readJson(response);
  if (!response.ok) throw new CallFailure(failureOf("hermes/stage", response.status, json));
  return json;
}
var ControlsContext = React5.createContext(null);
function AgentImportProvider({ api, children }) {
  const [state, setState] = React5.useState(INITIAL);
  const [sources, setSources] = React5.useState([TIMON_SOURCE]);
  const [dirty, setDirty] = React5.useState(false);
  const token = React5.useRef(null);
  const latest = React5.useRef(state);
  latest.current = state;
  const post = React5.useCallback(async (path, body) => {
    let response;
    try {
      response = await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new CallFailure(networkFailure);
    }
    const json = await readJson(response);
    if (!response.ok) throw new CallFailure(failureOf(path, response.status, json));
    return json;
  }, [api]);
  const discard = React5.useCallback(() => {
    const held = token.current;
    token.current = null;
    if (held) post("discard", { token: held }).catch(() => void 0);
  }, [post]);
  React5.useEffect(() => discard, [discard]);
  const fail = React5.useCallback((err) => {
    const failure = err instanceof CallFailure ? err.failure : networkFailure;
    setState((current) => ({ ...current, busy: false, error: say(failure) }));
  }, []);
  const addWarning = React5.useCallback((text) => {
    setState((current) => ({ ...current, warnings: [...current.warnings, text] }));
  }, []);
  const registerSource = React5.useCallback((source) => {
    setSources((current) => [...current.filter((s) => s.id !== source.id), source]);
    return () => setSources((current) => current.filter((s) => s !== source));
  }, []);
  const submitStaged = React5.useCallback(async (sourceId, stage) => {
    discard();
    setDirty(false);
    setState({ ...INITIAL, sourceId, busy: true });
    try {
      const staged = await stage();
      token.current = staged.token;
      const archive = { sha256: staged.sha256, size: staged.size, expiresAt: staged.expiresAt };
      setState((current) => ({ ...current, staged: archive }));
      const answer = await post("preview", { token: staged.token });
      setState((current) => ({
        ...current,
        step: "preview",
        busy: false,
        staged: answer.archive,
        preview: answer.preview,
        ready: answer.ready,
        choices: mergeChoices({}, answer.preview)
      }));
    } catch (err) {
      discard();
      fail(err);
    }
  }, [discard, fail, post]);
  const submitFile = React5.useCallback(async (sourceId, file) => {
    const refused = fileFailure(file);
    if (refused) {
      setState((current) => ({ ...current, error: say(refused) }));
      return;
    }
    await submitStaged(sourceId, () => sendArchive(api, file));
  }, [api, submitStaged]);
  const setChoice = React5.useCallback((sourceRef, patch) => {
    setDirty(true);
    setState((current) => {
      const before = current.choices[sourceRef] ?? { sourceRef };
      return { ...current, choices: { ...current.choices, [sourceRef]: { ...before, ...patch, sourceRef } } };
    });
  }, []);
  const refresh = React5.useCallback(async () => {
    const held = token.current;
    const now = latest.current;
    if (!held || !now.preview) return;
    setState((current) => ({ ...current, busy: true, error: null }));
    try {
      const body = requestBody(held, now.ready, importOptions(now.sourceId, now.preview, now.choices));
      const answer = await post("preview", body);
      setDirty(false);
      setState((current) => ({
        ...current,
        busy: false,
        staged: answer.archive,
        preview: answer.preview,
        ready: answer.ready,
        choices: mergeChoices(current.choices, answer.preview)
      }));
    } catch (err) {
      fail(err);
    }
  }, [fail, post]);
  const apply2 = React5.useCallback(async () => {
    const held = token.current;
    const now = latest.current;
    if (!held || !now.preview || !now.ready) return;
    const { included, updated } = applySummary(now.preview, now.choices);
    if (included === 0) return;
    const description = updated > 0 ? `${t3("confirm.body")} ${t3("confirm.bodyUpdate", { updated })}` : t3("confirm.body");
    const yes = await ui3.confirmAction({
      title: t3("confirm.title", { count: included }),
      description,
      confirmLabel: t3("confirm.yes")
    });
    if (!yes) return;
    setState((current) => ({ ...current, busy: true, error: null }));
    token.current = null;
    try {
      const result = await post("apply", requestBody(held, now.ready, importOptions(now.sourceId, now.preview, now.choices)));
      setState((current) => ({ ...current, step: "result", busy: false, staged: null, result }));
    } catch (err) {
      setState((current) => ({ ...INITIAL, sourceId: current.sourceId }));
      fail(err);
    }
  }, [fail, post]);
  const reset = React5.useCallback(() => {
    discard();
    setDirty(false);
    setState(INITIAL);
  }, [discard]);
  const value = React5.useMemo(
    () => ({ ...state, sources, addWarning, registerSource, submitFile, submitStaged }),
    [state, sources, addWarning, registerSource, submitFile, submitStaged]
  );
  const controls = React5.useMemo(
    () => ({ setChoice, refresh, apply: apply2, reset, dirty }),
    [setChoice, refresh, apply2, reset, dirty]
  );
  const Context = agentImportContext();
  return /* @__PURE__ */ React5.createElement(Context.Provider, { value }, /* @__PURE__ */ React5.createElement(ControlsContext.Provider, { value: controls }, children));
}
function useImport() {
  const value = React5.useContext(agentImportContext());
  const controls = React5.useContext(ControlsContext);
  if (!value || !controls) throw new Error("The import assistant is rendered outside of its provider.");
  return { value, controls };
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function formatTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString(ui3.getLocale(), { hour: "2-digit", minute: "2-digit" });
}
function Notice({ tone = "muted", children }) {
  const toneClass = tone === "error" ? "bg-destructive/10 text-destructive" : tone === "warning" ? "bg-amber-500/10 text-foreground" : "bg-muted/40 text-muted-foreground";
  return /* @__PURE__ */ React5.createElement("div", { role: tone === "error" ? "alert" : void 0, className: ui3.cn("rounded-md p-3 text-sm", toneClass) }, children);
}
function WarningList({ items }) {
  if (items.length === 0) return null;
  return /* @__PURE__ */ React5.createElement("ul", { className: "flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground" }, items.map((item, index) => /* @__PURE__ */ React5.createElement("li", { key: `${index}:${item}` }, item)));
}
function SourceCard({ source }) {
  const { value } = useImport();
  const picker = React5.useRef(null);
  const takesZip = source.accepts.includes("zip");
  return /* @__PURE__ */ React5.createElement("li", { className: "flex flex-wrap items-center gap-3 rounded-lg bg-muted/40 p-3" }, /* @__PURE__ */ React5.createElement("div", { className: "flex min-w-0 flex-1 flex-col gap-0.5" }, /* @__PURE__ */ React5.createElement("span", { className: "text-sm font-medium" }, source.label), source.description && /* @__PURE__ */ React5.createElement("span", { className: "text-xs text-muted-foreground" }, source.description)), /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col items-stretch gap-2" }, source.action && /* @__PURE__ */ React5.createElement(Button6, { size: "sm", variant: "outline", disabled: value.busy, onClick: () => void source.action?.run() }, source.action.label), takesZip && /* @__PURE__ */ React5.createElement(React5.Fragment, null, /* @__PURE__ */ React5.createElement(
    "input",
    {
      ref: picker,
      type: "file",
      accept: ".zip,application/zip,application/x-zip-compressed",
      className: "sr-only",
      tabIndex: -1,
      "aria-hidden": true,
      onChange: (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void value.submitFile(source.id, file);
      }
    }
  ), /* @__PURE__ */ React5.createElement(Button6, { size: "sm", variant: "outline", disabled: value.busy, onClick: () => picker.current?.click() }, t3("pickZip")))));
}
function SourceStep() {
  const { value } = useImport();
  return /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-3" }, /* @__PURE__ */ React5.createElement("h3", { className: "text-sm font-medium" }, t3("sources")), value.sources.length > 0 ? /* @__PURE__ */ React5.createElement("ul", { className: "flex flex-col gap-2" }, value.sources.map((source) => /* @__PURE__ */ React5.createElement(SourceCard, { key: source.id, source }))) : /* @__PURE__ */ React5.createElement("p", { className: "text-sm text-muted-foreground" }, t3("noSource")), /* @__PURE__ */ React5.createElement(Slot2, { name: SOURCE_SLOT }), value.busy && /* @__PURE__ */ React5.createElement("p", { role: "status", className: "text-sm text-muted-foreground" }, value.staged ? t3("previewing") : t3("staging")));
}
var ACTION_CLASS = {
  create: "bg-primary/15 text-foreground",
  update: "bg-amber-500/15 text-foreground",
  skip: "bg-muted text-muted-foreground"
};
function Chip({ className, children }) {
  return /* @__PURE__ */ React5.createElement("span", { className: ui3.cn("shrink-0 rounded-full px-2 py-0.5 text-xs", className) }, children);
}
function ElementToggle({ element, count, on, disabled, onToggle }) {
  const label = t3(`element.${element}`);
  return /* @__PURE__ */ React5.createElement(
    "button",
    {
      type: "button",
      "aria-pressed": on,
      disabled,
      onClick: onToggle,
      className: ui3.cn(
        "rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
        on ? "bg-primary/15 text-foreground hover:bg-primary/25" : "bg-muted/60 text-muted-foreground line-through hover:bg-muted"
      )
    },
    count > 0 ? t3("elementCount", { label, count }) : label
  );
}
function AgentCard({ agent }) {
  const { value, controls } = useImport();
  const choice = value.choices[agent.sourceRef];
  const shown = shownChoice(agent, choice);
  const id = React5.useId();
  const included = shown.include;
  const locked = value.busy || !included;
  const elements = IMPORT_ELEMENTS.filter((element) => agent.elements?.[element] !== void 0);
  return /* @__PURE__ */ React5.createElement("li", { className: ui3.cn("flex flex-col gap-3 rounded-lg bg-muted/40 p-3", !included && "opacity-70") }, /* @__PURE__ */ React5.createElement("div", { className: "flex items-center gap-3" }, /* @__PURE__ */ React5.createElement(
    Switch4,
    {
      checked: included,
      disabled: value.busy || shown.lockedOut,
      "aria-label": t3("agent.include"),
      onCheckedChange: (checked) => controls.setChoice(agent.sourceRef, { include: checked })
    }
  ), /* @__PURE__ */ React5.createElement("div", { className: "flex min-w-0 flex-1 flex-col" }, /* @__PURE__ */ React5.createElement("span", { className: "truncate text-sm font-medium" }, shown.name || agent.displayName), /* @__PURE__ */ React5.createElement("span", { className: "truncate text-xs text-muted-foreground" }, t3("agent.from", { name: agent.displayName }))), /* @__PURE__ */ React5.createElement(Chip, { className: ACTION_CLASS[agent.action] }, t3(`action.${agent.action}`))), included && /* @__PURE__ */ React5.createElement("div", { className: "grid gap-3 sm:grid-cols-2" }, /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1.5" }, /* @__PURE__ */ React5.createElement(Label4, { htmlFor: `${id}-name`, className: "text-xs" }, t3("agent.name")), /* @__PURE__ */ React5.createElement(
    Input2,
    {
      id: `${id}-name`,
      value: shown.name,
      maxLength: 100,
      disabled: locked,
      onChange: (event) => controls.setChoice(agent.sourceRef, { name: event.target.value })
    }
  )), /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1.5" }, /* @__PURE__ */ React5.createElement(Label4, { htmlFor: `${id}-role`, className: "text-xs" }, t3("agent.role")), /* @__PURE__ */ React5.createElement(
    Select2,
    {
      value: shown.role,
      disabled: locked,
      onValueChange: (role) => controls.setChoice(agent.sourceRef, { role })
    },
    /* @__PURE__ */ React5.createElement(SelectTrigger2, { id: `${id}-role`, "aria-label": t3("agent.role") }, /* @__PURE__ */ React5.createElement(SelectValue2, null)),
    /* @__PURE__ */ React5.createElement(SelectContent2, null, IMPORT_ROLES.map((role) => /* @__PURE__ */ React5.createElement(SelectItem2, { key: role, value: role }, t3(`role.${role}`))), !IMPORT_ROLES.includes(shown.role) && /* @__PURE__ */ React5.createElement(SelectItem2, { value: shown.role }, shown.role))
  )), /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1.5" }, /* @__PURE__ */ React5.createElement(Label4, { htmlFor: `${id}-project`, className: "text-xs" }, t3("agent.project")), /* @__PURE__ */ React5.createElement(
    Input2,
    {
      id: `${id}-project`,
      value: shown.project ?? "",
      placeholder: t3("agent.projectNone"),
      maxLength: 64,
      disabled: locked,
      onChange: (event) => controls.setChoice(agent.sourceRef, { project: event.target.value.trim() || null })
    }
  )), /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1.5" }, /* @__PURE__ */ React5.createElement(Label4, { htmlFor: `${id}-cwd`, className: "text-xs" }, t3("agent.cwd")), /* @__PURE__ */ React5.createElement(
    Input2,
    {
      id: `${id}-cwd`,
      value: shown.cwd ?? "",
      placeholder: t3("agent.cwdNone"),
      maxLength: 1024,
      disabled: locked,
      "aria-invalid": agent.cwdMissing === true,
      onChange: (event) => controls.setChoice(agent.sourceRef, { cwd: event.target.value })
    }
  ))), included && agent.cwdMissing && /* @__PURE__ */ React5.createElement(Notice, { tone: "warning" }, t3("agent.cwdMissing")), included && agent.cwdSuggestion && !shown.cwd && /* @__PURE__ */ React5.createElement(Notice, { tone: "warning" }, /* @__PURE__ */ React5.createElement("div", { className: "flex flex-wrap items-center gap-2" }, /* @__PURE__ */ React5.createElement("span", { className: "min-w-0 break-all" }, t3("agent.cwdSuggested", { path: agent.cwdSuggestion })), /* @__PURE__ */ React5.createElement(
    Button6,
    {
      size: "sm",
      variant: "outline",
      disabled: locked,
      onClick: () => controls.setChoice(agent.sourceRef, { cwd: agent.cwdSuggestion ?? null })
    },
    t3("agent.cwdUse")
  ))), included && elements.length > 0 && /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1.5" }, /* @__PURE__ */ React5.createElement("span", { className: "text-xs text-muted-foreground" }, t3("agent.elements")), /* @__PURE__ */ React5.createElement("div", { className: "flex flex-wrap gap-1.5" }, elements.map((element) => {
    const on = shown.elements[element] ?? true;
    return /* @__PURE__ */ React5.createElement(
      ElementToggle,
      {
        key: element,
        element,
        count: agent.elements?.[element]?.count ?? 0,
        on,
        disabled: locked,
        onToggle: () => controls.setChoice(agent.sourceRef, { elements: { ...choice?.elements, [element]: !on } })
      }
    );
  }))), included && (agent.activeRoutines ?? 0) > 0 && shown.elements.routines === true && /* @__PURE__ */ React5.createElement("div", { className: "flex items-start gap-3" }, /* @__PURE__ */ React5.createElement(
    Switch4,
    {
      id: `${id}-routines`,
      checked: shown.keepRoutinesActive,
      disabled: locked,
      onCheckedChange: (checked) => controls.setChoice(agent.sourceRef, { keepRoutinesActive: checked })
    }
  ), /* @__PURE__ */ React5.createElement("div", { className: "flex min-w-0 flex-col gap-0.5" }, /* @__PURE__ */ React5.createElement(Label4, { htmlFor: `${id}-routines`, className: "text-xs" }, t3("agent.routinesActive", { count: agent.activeRoutines ?? 0 })), /* @__PURE__ */ React5.createElement("span", { className: "text-xs text-muted-foreground" }, t3("agent.routinesActiveHint")))), /* @__PURE__ */ React5.createElement(WarningList, { items: agent.warnings }));
}
function PreviewStep() {
  const { value, controls } = useImport();
  const preview = value.preview;
  const { included } = applySummary(preview, value.choices);
  const warnings = [...value.warnings, ...preview?.warnings ?? []];
  return /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-4" }, /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1" }, /* @__PURE__ */ React5.createElement("h3", { className: "text-sm font-medium" }, t3("preview.title")), value.staged && /* @__PURE__ */ React5.createElement("p", { className: "text-xs text-muted-foreground" }, t3("preview.archive", { size: formatSize(value.staged.size), time: formatTime(value.staged.expiresAt) }))), !value.ready && /* @__PURE__ */ React5.createElement(Notice, { tone: "warning" }, t3("preview.notReady")), value.ready && preview && preview.agents.length === 0 && /* @__PURE__ */ React5.createElement(Notice, null, t3("preview.empty")), warnings.length > 0 && /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1.5 rounded-md bg-amber-500/10 p-3" }, /* @__PURE__ */ React5.createElement("span", { className: "text-sm font-medium" }, t3("preview.warnings")), /* @__PURE__ */ React5.createElement(WarningList, { items: warnings })), preview && preview.agents.length > 0 && /* @__PURE__ */ React5.createElement(React5.Fragment, null, /* @__PURE__ */ React5.createElement("p", { className: "text-xs text-muted-foreground" }, t3("preview.count", { count: preview.agents.length })), /* @__PURE__ */ React5.createElement("ul", { className: "flex flex-col gap-3" }, preview.agents.map((agent) => /* @__PURE__ */ React5.createElement(AgentCard, { key: agent.sourceRef, agent })))), value.busy && /* @__PURE__ */ React5.createElement("p", { role: "status", className: "text-sm text-muted-foreground" }, t3("previewing")), /* @__PURE__ */ React5.createElement("div", { className: "flex flex-wrap items-center justify-end gap-2" }, /* @__PURE__ */ React5.createElement(Button6, { variant: "ghost", disabled: value.busy, onClick: controls.reset }, t3("preview.back")), value.ready && controls.dirty && /* @__PURE__ */ React5.createElement(Button6, { variant: "outline", disabled: value.busy, onClick: () => void controls.refresh() }, t3("preview.refresh")), /* @__PURE__ */ React5.createElement(Button6, { disabled: value.busy || !value.ready || controls.dirty || included === 0, onClick: () => void controls.apply() }, t3("preview.apply", { count: included }))));
}
var STATUS_CLASS = {
  created: "bg-primary/15 text-foreground",
  updated: "bg-primary/15 text-foreground",
  skipped: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive"
};
function ResultStep({ onDone }) {
  const { value, controls } = useImport();
  const result = value.result;
  if (!result) return null;
  const ok = result.agents.filter((agent) => agent.status === "created" || agent.status === "updated").length;
  const failed = result.agents.filter((agent) => agent.status === "failed").length;
  return /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-4" }, /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1" }, /* @__PURE__ */ React5.createElement("h3", { className: "text-sm font-medium" }, t3("result.title")), /* @__PURE__ */ React5.createElement("p", { className: "text-xs text-muted-foreground" }, t3("result.summary", { ok, failed }))), /* @__PURE__ */ React5.createElement(WarningList, { items: result.warnings }), /* @__PURE__ */ React5.createElement("ul", { className: "flex flex-col gap-2" }, result.agents.map((agent) => /* @__PURE__ */ React5.createElement("li", { key: agent.sourceRef, className: "flex flex-col gap-1.5 rounded-lg bg-muted/40 p-3" }, /* @__PURE__ */ React5.createElement("div", { className: "flex items-center gap-3" }, /* @__PURE__ */ React5.createElement("span", { className: "min-w-0 flex-1 truncate text-sm font-medium" }, agent.agent ?? agent.displayName), /* @__PURE__ */ React5.createElement(Chip, { className: STATUS_CLASS[agent.status] }, t3(`result.${agent.status}`))), agent.error && /* @__PURE__ */ React5.createElement("p", { className: "text-xs text-destructive" }, agent.error), /* @__PURE__ */ React5.createElement(WarningList, { items: agent.warnings })))), /* @__PURE__ */ React5.createElement("div", { className: "flex flex-wrap items-center justify-end gap-2" }, /* @__PURE__ */ React5.createElement(Button6, { variant: "outline", onClick: controls.reset }, t3("result.again")), onDone && /* @__PURE__ */ React5.createElement(Button6, { onClick: onDone }, t3("result.done"))));
}
function Assistant({ onDone }) {
  const { value } = useImport();
  return /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-4" }, value.error && /* @__PURE__ */ React5.createElement(Notice, { tone: "error" }, value.error), value.step === "source" && /* @__PURE__ */ React5.createElement(SourceStep, null), value.step === "preview" && /* @__PURE__ */ React5.createElement(PreviewStep, null), value.step === "result" && /* @__PURE__ */ React5.createElement(ResultStep, { onDone }));
}
function AgentImportSettings({ api }) {
  return /* @__PURE__ */ React5.createElement(AgentImportProvider, { api }, /* @__PURE__ */ React5.createElement("section", { className: "flex flex-col gap-5 p-4" }, /* @__PURE__ */ React5.createElement("div", { className: "flex flex-col gap-1" }, /* @__PURE__ */ React5.createElement("h2", { className: "text-base font-semibold" }, t3("title")), /* @__PURE__ */ React5.createElement("p", { className: "text-sm text-muted-foreground" }, t3("intro"))), /* @__PURE__ */ React5.createElement(Assistant, null)));
}
function DialogBody({ onPending, onDone }) {
  const { value } = useImport();
  const pending = value.step === "preview" || value.busy;
  React5.useEffect(() => onPending(pending), [onPending, pending]);
  return /* @__PURE__ */ React5.createElement(Assistant, { onDone });
}
function ImportDialog({ api, open, onOpenChange }) {
  const pending = React5.useRef(false);
  const setPending = React5.useCallback((value) => {
    pending.current = value;
  }, []);
  const close = React5.useCallback(async (ask) => {
    if (ask && pending.current) {
      const yes = await ui3.confirmAction({
        title: t3("closeConfirm.title"),
        description: t3("closeConfirm.body"),
        confirmLabel: t3("closeConfirm.yes"),
        destructive: true
      });
      if (!yes) return;
    }
    pending.current = false;
    onOpenChange(false);
  }, [onOpenChange]);
  return /* @__PURE__ */ React5.createElement(Dialog4, { open, onOpenChange: (next) => {
    if (!next) void close(true);
  } }, /* @__PURE__ */ React5.createElement(DialogContent4, { style: { maxWidth: 720, maxHeight: "85vh", overflowY: "auto" } }, /* @__PURE__ */ React5.createElement(DialogHeader4, null, /* @__PURE__ */ React5.createElement(DialogTitle4, null, t3("title")), /* @__PURE__ */ React5.createElement(DialogDescription4, null, t3("dialogDescription"))), open && /* @__PURE__ */ React5.createElement(AgentImportProvider, { api }, /* @__PURE__ */ React5.createElement(DialogBody, { onPending: setPending, onDone: () => void close(false) }))));
}
function ToolbarEntry({ api }) {
  const [open, setOpen] = React5.useState(false);
  return /* @__PURE__ */ React5.createElement(React5.Fragment, null, /* @__PURE__ */ React5.createElement(Button6, { size: "sm", variant: "outline", className: "h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium", onClick: () => setOpen(true) }, /* @__PURE__ */ React5.createElement("svg", { viewBox: "0 0 24 24", className: "size-3.5", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, /* @__PURE__ */ React5.createElement("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }), /* @__PURE__ */ React5.createElement("path", { d: "m7 10 5 5 5-5" }), /* @__PURE__ */ React5.createElement("path", { d: "M12 15V3" })), t3("open")), /* @__PURE__ */ React5.createElement(ImportDialog, { api, open, onOpenChange: setOpen }));
}
function RailEntry({ api }) {
  const [open, setOpen] = React5.useState(false);
  return /* @__PURE__ */ React5.createElement(React5.Fragment, null, /* @__PURE__ */ React5.createElement(TooltipProvider2, { delayDuration: 300 }, /* @__PURE__ */ React5.createElement(Tooltip2, null, /* @__PURE__ */ React5.createElement(TooltipTrigger2, { asChild: true }, /* @__PURE__ */ React5.createElement(
    "button",
    {
      type: "button",
      "aria-label": t3("openIcon"),
      onClick: () => setOpen(true),
      className: "grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    },
    /* @__PURE__ */ React5.createElement("svg", { viewBox: "0 0 24 24", className: "size-4", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, /* @__PURE__ */ React5.createElement("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }), /* @__PURE__ */ React5.createElement("path", { d: "m7 10 5 5 5-5" }), /* @__PURE__ */ React5.createElement("path", { d: "M12 15V3" }))
  )), /* @__PURE__ */ React5.createElement(TooltipContent2, { side: "top", sideOffset: 6, className: "rounded-md bg-popover px-2 py-1 text-[11.5px] font-medium text-popover-foreground shadow-elev-2" }, t3("openIcon")))), /* @__PURE__ */ React5.createElement(ImportDialog, { api, open, onOpenChange: setOpen }));
}
function OnboardingEntry({ api }) {
  const [open, setOpen] = React5.useState(false);
  return /* @__PURE__ */ React5.createElement(React5.Fragment, null, /* @__PURE__ */ React5.createElement(
    "button",
    {
      type: "button",
      className: "text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground",
      onClick: () => setOpen(true)
    },
    t3("openOnboarding")
  ), /* @__PURE__ */ React5.createElement(ImportDialog, { api, open, onOpenChange: setOpen }));
}
function OpenBotEntry({ api }) {
  return /* @__PURE__ */ React5.createElement(
    OpenBotSource,
    {
      label: t3("otherAgentSource.label"),
      description: t3("otherAgentSource.description"),
      skillLabel: t3("otherAgentSource.copySkill"),
      skillCopied: t3("otherAgentSource.skillCopied"),
      skillFailed: t3("otherAgentSource.copyFailed"),
      api
    }
  );
}
var ENTRY_SLOTS = ["agents.toolbar", "onboarding.agent"];
var RAIL_SLOT = "bots.rail.action";
var AGENT_MENU_SLOT = "agent.menu.item";
function apply(ctx) {
  const api = (path, init) => ctx.api(path, init);
  const Settings = () => /* @__PURE__ */ React5.createElement(AgentImportSettings, { api });
  const Toolbar = () => /* @__PURE__ */ React5.createElement(ToolbarEntry, { api });
  const Onboarding = () => /* @__PURE__ */ React5.createElement(OnboardingEntry, { api });
  const Export = () => /* @__PURE__ */ React5.createElement(ExportEntry, { api });
  const Rail = () => /* @__PURE__ */ React5.createElement(RailEntry, { api });
  const ExportAgent = () => /* @__PURE__ */ React5.createElement(ExportAgentMenuItem, { api });
  const detect = () => detectHermes(api);
  const stage = (profiles) => stageHermes(api, profiles);
  const HermesEntry = () => /* @__PURE__ */ React5.createElement(HermesSource, { detect, stage });
  const OtherAgents = () => /* @__PURE__ */ React5.createElement(OpenBotEntry, { api });
  const disposers = [
    ctx.slots.register({ slot: "settings.section", children: { [SOURCE_SLOT]: "list" } }, Settings),
    // After the section: the socket only exists while the section holds it open.
    ctx.slots.register({ slot: SOURCE_SLOT }, OtherAgents),
    ctx.slots.register({ slot: SOURCE_SLOT }, HermesEntry),
    ctx.slots.register({ slot: ENTRY_SLOTS[0] }, Toolbar),
    ctx.slots.register({ slot: ENTRY_SLOTS[0] }, Export),
    ctx.slots.register({ slot: ENTRY_SLOTS[1] }, Onboarding),
    ctx.slots.register({ slot: RAIL_SLOT }, Rail),
    ctx.slots.register({ slot: AGENT_MENU_SLOT }, ExportAgent)
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
export {
  AGENT_MENU_SLOT,
  ENTRY_SLOTS,
  RAIL_SLOT,
  apply
};
