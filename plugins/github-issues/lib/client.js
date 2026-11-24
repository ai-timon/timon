// ../plugins/github-issues/src/client.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ui from "@timon/ui";

// ../plugins/github-issues/src/messages.json
var messages_default = {
  en: {
    "widget.title": "Issues",
    "widget.description": "The open issues of the project's GitHub repository that carry its label, each imported as a TO DO idea on a click.",
    chooseProject: "Choose a project",
    chooseProjectOption: "Choose a project",
    selectProject: "Project of the Git stack",
    loading: "Reading the issues\u2026",
    empty: "No open issue labelled {label}",
    importByNumber: "Import an issue by its number\u2026",
    refresh: "Refresh",
    more: "More",
    import: "Import as TO DO",
    importing: "Importing\u2026",
    openTodo: "Open the TO DO",
    readText: "Read the text",
    openOnGitHub: "Open on GitHub",
    openPullRequest: "Open pull request #{number}",
    copyLink: "Copy the link",
    dismiss: "Do not suggest again",
    "chip.todo": "TO DO",
    "chip.pr": "PR #{number}",
    "notice.imported": "Imported as TO DO #{id}",
    "notice.known": "Already TO DO #{id}",
    "notice.copied": "Link copied",
    "notice.copyFailed": "The link could not be copied",
    "notice.dismissed": "#{number} will not be suggested again",
    deletedAuthor: "deleted account",
    "dialog.lookupTitle": "Import an issue",
    "dialog.lookupLabel": "Issue number or link",
    "dialog.lookupPlaceholder": "212, #212 or a GitHub link",
    "dialog.read": "Read",
    "dialog.reading": "Reading\u2026",
    "dialog.text": "Text of the issue \xB7 external data",
    "dialog.noText": "No text",
    "dialog.cut": "Cut at 4,000 characters, as the TO DO keeps it",
    "dialog.importSection": "Import",
    "dialog.project": "Project",
    "dialog.link": "Link kept",
    "dialog.state": "State",
    "dialog.stateClosed": "closed",
    "dialog.close": "Close",
    "dialog.closedHint": "A closed issue is not imported",
    "problem.empty": "Type a number or a link",
    "problem.invalid": "Not an issue number or link",
    "problem.otherRepo": "This issue belongs to another repository than {repo}",
    "settings.title": "GitHub issues",
    "settings.status": "Label {label} \xB7 {count, plural, =0 {nothing to import} one {# to import} other {# to import}}",
    "settings.statusNoCount": "Label {label}",
    "settings.configure": "Configure",
    "settings.useDefault": "Use the default label",
    "settings.dialogTitle": "GitHub issues of {project}",
    "settings.label": "Label of the issues to list",
    "settings.save": "Save",
    "settings.saving": "Saving\u2026",
    "settings.cancel": "Cancel",
    "labelProblem.empty": "Type a label",
    "labelProblem.tooLong": "50 characters at most",
    "labelProblem.comma": "One label, without a comma",
    "error.notConfigured": "This project does not open pull requests on GitHub",
    "error.forbidden": "Your account cannot manage this project",
    "error.signIn": "Sign in to read the issues",
    "error.unavailable": "GitHub did not answer",
    "error.busy": "Too many requests at once, try again",
    "error.notFound": "No such issue in this repository",
    "error.closed": "This issue is closed",
    "error.invalidLabel": "This label cannot be used",
    "error.generic": "Something went wrong"
  },
  fr: {
    "widget.title": "Issues",
    "widget.description": "Les issues ouvertes du d\xE9p\xF4t GitHub du projet qui portent son label, chacune import\xE9e en id\xE9e TO DO d'un clic.",
    chooseProject: "Choisis un projet",
    chooseProjectOption: "Choisir un projet",
    selectProject: "Projet de la pile Git",
    loading: "Lecture des issues\u2026",
    empty: "Aucune issue ouverte au label {label}",
    importByNumber: "Importer une issue par son num\xE9ro\u2026",
    refresh: "Rafra\xEEchir",
    more: "Plus",
    import: "Importer en TODO",
    importing: "Import\u2026",
    openTodo: "Ouvrir la TODO",
    readText: "Lire le texte",
    openOnGitHub: "Ouvrir sur GitHub",
    openPullRequest: "Ouvrir la PR #{number}",
    copyLink: "Copier le lien",
    dismiss: "Ne plus proposer",
    "chip.todo": "TODO",
    "chip.pr": "PR #{number}",
    "notice.imported": "Import\xE9e en TODO #{id}",
    "notice.known": "D\xE9j\xE0 la TODO #{id}",
    "notice.copied": "Lien copi\xE9",
    "notice.copyFailed": "Le lien n'a pas pu \xEAtre copi\xE9",
    "notice.dismissed": "#{number} ne sera plus propos\xE9e",
    deletedAuthor: "compte supprim\xE9",
    "dialog.lookupTitle": "Importer une issue",
    "dialog.lookupLabel": "Num\xE9ro ou lien de l'issue",
    "dialog.lookupPlaceholder": "212, #212 ou un lien GitHub",
    "dialog.read": "Lire",
    "dialog.reading": "Lecture\u2026",
    "dialog.text": "Texte de l'issue \xB7 donn\xE9e externe",
    "dialog.noText": "Aucun texte",
    "dialog.cut": "Coup\xE9 \xE0 4 000 caract\xE8res, comme la TODO le garde",
    "dialog.importSection": "Import",
    "dialog.project": "Projet",
    "dialog.link": "Lien gard\xE9",
    "dialog.state": "\xC9tat",
    "dialog.stateClosed": "ferm\xE9e",
    "dialog.close": "Fermer",
    "dialog.closedHint": "Une issue ferm\xE9e ne s'importe pas",
    "problem.empty": "Tape un num\xE9ro ou un lien",
    "problem.invalid": "Ce n'est ni un num\xE9ro ni un lien d'issue",
    "problem.otherRepo": "Cette issue appartient \xE0 un autre d\xE9p\xF4t que {repo}",
    "settings.title": "Issues GitHub",
    "settings.status": "Label {label} \xB7 {count, plural, =0 {rien \xE0 importer} one {# \xE0 importer} other {# \xE0 importer}}",
    "settings.statusNoCount": "Label {label}",
    "settings.configure": "Configurer",
    "settings.useDefault": "Revenir au label par d\xE9faut",
    "settings.dialogTitle": "Issues GitHub de {project}",
    "settings.label": "Label des issues \xE0 lister",
    "settings.save": "Enregistrer",
    "settings.saving": "Enregistrement\u2026",
    "settings.cancel": "Annuler",
    "labelProblem.empty": "Tape un label",
    "labelProblem.tooLong": "50 caract\xE8res au plus",
    "labelProblem.comma": "Un seul label, sans virgule",
    "error.notConfigured": "Ce projet n'ouvre pas de pull requests sur GitHub",
    "error.forbidden": "Ton compte ne peut pas g\xE9rer ce projet",
    "error.signIn": "Connecte-toi pour lire les issues",
    "error.unavailable": "GitHub n'a pas r\xE9pondu",
    "error.busy": "Trop de requ\xEAtes \xE0 la fois, r\xE9essaie",
    "error.notFound": "Aucune issue de ce num\xE9ro dans ce d\xE9p\xF4t",
    "error.closed": "Cette issue est ferm\xE9e",
    "error.invalidLabel": "Ce label n'est pas utilisable",
    "error.generic": "Quelque chose n'a pas march\xE9"
  }
};

// ../plugins/github-issues/src/issues-model.ts
var MAX_NUMBER = 1e9;
var LABEL_LIMIT = 50;
function parseIssueInput(text, repo) {
  const value = text.trim();
  if (!value) return { problem: "empty" };
  let named = null;
  let digits;
  const url = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/i.exec(value);
  const ref = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(value);
  const bare = /^#?(\d+)$/.exec(value);
  if (url) {
    named = url[1];
    digits = url[2];
  } else if (ref) {
    named = ref[1];
    digits = ref[2];
  } else if (bare) digits = bare[1];
  if (digits === void 0) return { problem: "invalid" };
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_NUMBER) return { problem: "invalid" };
  if (named && repo && named.toLowerCase() !== repo.toLowerCase()) return { problem: "otherRepo" };
  return { number };
}
function sortCandidates(issues) {
  return [...issues.filter((i) => !i.todo), ...issues.filter((i) => i.todo)];
}
function toImport(issues) {
  return issues.filter((i) => !i.todo).length;
}
function labelProblem(label) {
  const value = label.trim();
  if (!value) return "empty";
  if (value.length > LABEL_LIMIT) return "tooLong";
  if (value.includes(",")) return "comma";
  return null;
}
function errorKey(code) {
  switch (code) {
    case "not_configured":
      return "error.notConfigured";
    case "forbidden":
      return "error.forbidden";
    case "sign_in_required":
      return "error.signIn";
    case "unavailable":
      return "error.unavailable";
    case "busy":
      return "error.busy";
    case "issue_not_found":
      return "error.notFound";
    case "issue_closed":
      return "error.closed";
    case "invalid_label":
      return "error.invalidLabel";
    default:
      return "error.generic";
  }
}
function safeHref(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}
var HIDDEN_LIST_FRESH_MS = 6e4;
function shouldRead(front, readAt, now) {
  return front || readAt === null || now - readAt >= HIDDEN_LIST_FRESH_MS;
}

// ../plugins/github-issues/src/client.tsx
var t = ui.createTranslator(messages_default);
var Tile2 = ui.Tile;
var Button2 = ui.Button;
var Input2 = ui.Input;
var Label2 = ui.Label;
var Dialog2 = ui.Dialog;
var DialogContent2 = ui.DialogContent;
var DialogTitle2 = ui.DialogTitle;
var DialogDescription2 = ui.DialogDescription;
var DropdownMenu2 = ui.DropdownMenu;
var DropdownMenuTrigger2 = ui.DropdownMenuTrigger;
var DropdownMenuContent2 = ui.DropdownMenuContent;
var DropdownMenuItem2 = ui.DropdownMenuItem;
var NativeViewCover2 = ui.NativeViewCover;
var GitStackProjectPicker2 = ui.GitStackProjectPicker;
var cn2 = ui.cn;
async function call(api, path, init) {
  try {
    const response = await api(path, init ? { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : { cache: "no-store" });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json) return { ok: false, code: json?.error ?? null };
    return { ok: true, value: json };
  } catch {
    return { ok: false, code: null };
  }
}
var query = (project, extra = {}) => new URLSearchParams({ project, ...extra }).toString();
var ICON_BUTTON = "inline-flex h-7 w-7 shrink-0 items-center justify-center gap-1 rounded-md text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 text-muted-foreground hover:bg-muted hover:text-foreground";
var PRIMARY_ICON_BUTTON = "inline-flex h-7 w-7 shrink-0 items-center justify-center gap-1 rounded-md text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]";
var CHIP = "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium";
var LABEL_TONE = "bg-sky-500/15 text-sky-700 dark:text-sky-300";
var TODO_TONE = "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
var PR_TONE = "bg-amber-500/15 text-amber-700 dark:text-amber-300";
var MENU_ITEM = "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none focus:bg-muted";
var MENU = "z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2";
var ISLAND = "rounded-lg bg-foreground/[0.035]";
function Icon({ d, className = "size-3.5" }) {
  return /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", className, "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("path", { d }));
}
var ICONS = {
  import: "M12 4v11M7 10l5 5 5-5M5 20h14",
  todo: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  copy: "M9 9h10v10H9zM5 15V5h10",
  hide: "M6 6l12 12M18 6L6 18",
  read: "M4 5h7a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4zM20 5h-7a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h7z",
  issue: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v.01",
  pull: "M6 4v16M18 10v10M6 4a2 2 0 1 0 0 .01M18 10a2 2 0 1 0 0 .01M14 6h2a2 2 0 0 1 2 2v2"
};
var ISSUES_PICTO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5"/></svg>';
function LabelChips({ labels }) {
  return /* @__PURE__ */ React.createElement(React.Fragment, null, labels.slice(0, 2).map((label) => /* @__PURE__ */ React.createElement("span", { key: label.name, "data-issue-label": label.name, className: cn2(CHIP, LABEL_TONE, "max-w-[8rem] truncate"), title: label.name }, label.name)));
}
function TodoChips({ todo }) {
  if (!todo) return null;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { "data-issue-todo": String(todo.id), className: cn2(CHIP, TODO_TONE), title: `#${todo.id}` }, t("chip.todo")), todo.pr && /* @__PURE__ */ React.createElement("span", { "data-issue-pr": String(todo.pr.number), className: cn2(CHIP, PR_TONE) }, t("chip.pr", { number: todo.pr.number })));
}
var meta = (number, author) => `#${number} \xB7 ${author ?? t("deletedAuthor")}`;
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
function IssueRow({ issue, busy, onImport, onOpenTodo, onRead, onCopy, onDismiss }) {
  const imported = issue.todo !== null;
  const href = safeHref(issue.url);
  const pr = safeHref(issue.todo?.pr?.url);
  const action = imported ? t("openTodo") : busy ? t("importing") : t("import");
  return /* @__PURE__ */ React.createElement("li", { "data-issue-row": String(issue.number), className: "flex items-center gap-1 rounded-lg bg-muted/30 py-2 pl-2.5 pr-1 transition-colors hover:bg-muted/50" }, /* @__PURE__ */ React.createElement("div", { className: "min-w-0 flex-1" }, /* @__PURE__ */ React.createElement("div", { className: cn2("line-clamp-2 break-words text-[12.5px] font-medium leading-snug", imported ? "text-muted-foreground" : "text-foreground"), title: issue.title }, issue.title), /* @__PURE__ */ React.createElement("div", { className: "mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" }, /* @__PURE__ */ React.createElement("span", { className: "truncate tabular-nums" }, meta(issue.number, issue.author)), imported ? /* @__PURE__ */ React.createElement(TodoChips, { todo: issue.todo }) : /* @__PURE__ */ React.createElement(LabelChips, { labels: issue.labels }))), /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      "data-issue-action": imported ? "open" : "import",
      onClick: imported ? () => onOpenTodo(issue.todo.id) : onImport,
      disabled: busy,
      title: action,
      "aria-label": action,
      className: imported ? ICON_BUTTON : PRIMARY_ICON_BUTTON
    },
    /* @__PURE__ */ React.createElement(Icon, { d: imported ? ICONS.todo : ICONS.import })
  ), /* @__PURE__ */ React.createElement(DropdownMenu2, { modal: false }, /* @__PURE__ */ React.createElement(DropdownMenuTrigger2, { asChild: true }, /* @__PURE__ */ React.createElement("button", { type: "button", "data-issue-more": "", title: t("more"), "aria-label": t("more"), className: ICON_BUTTON }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.more }))), /* @__PURE__ */ React.createElement(DropdownMenuContent2, { sideOffset: 6, align: "end", className: MENU }, /* @__PURE__ */ React.createElement(NativeViewCover2, null), /* @__PURE__ */ React.createElement(DropdownMenuItem2, { "data-menu-read": "", onSelect: onRead, className: MENU_ITEM }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.read }), t("readText")), href && /* @__PURE__ */ React.createElement(DropdownMenuItem2, { onSelect: () => {
    window.open(href, "_blank", "noopener,noreferrer");
  }, className: MENU_ITEM }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.external }), t("openOnGitHub")), pr && issue.todo?.pr && /* @__PURE__ */ React.createElement(DropdownMenuItem2, { onSelect: () => {
    window.open(pr, "_blank", "noopener,noreferrer");
  }, className: MENU_ITEM }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.pull }), t("openPullRequest", { number: issue.todo.pr.number })), /* @__PURE__ */ React.createElement(DropdownMenuItem2, { "data-menu-copy": "", onSelect: onCopy, className: MENU_ITEM }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.copy }), t("copyLink")), !imported && /* @__PURE__ */ React.createElement(DropdownMenuItem2, { "data-menu-dismiss": "", onSelect: onDismiss, className: MENU_ITEM }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.hide }), t("dismiss")))));
}
function Empty({ text }) {
  return /* @__PURE__ */ React.createElement("div", { className: "flex flex-col items-center justify-center gap-2 py-6" }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.issue, className: "size-4 text-muted-foreground/60" }), /* @__PURE__ */ React.createElement("span", { "data-issues-empty": "", className: "text-center text-[12.5px] text-muted-foreground" }, text));
}
var lastRead = /* @__PURE__ */ new Map();
function IssuesWidget({ api, handle, className }) {
  const { project } = ui.useGitStackProject();
  const { openTodo, todoModal } = ui.useTodoOpener();
  const [load, setLoad] = useState({ kind: "idle" });
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [opened, setOpened] = useState(null);
  const front = ui.useWidgetInFront();
  const frontNow = useRef(front);
  frontNow.current = front;
  const reload = useCallback(async (quiet = false) => {
    if (!project) {
      setLoad({ kind: "idle" });
      return;
    }
    if (!quiet) setLoad({ kind: "loading" });
    const out = await call(api, `candidates?${query(project)}`);
    if (out.ok) lastRead.set(project, { list: out.value, at: Date.now() });
    setLoad(out.ok ? { kind: "ready", list: out.value } : { kind: "error", code: out.code });
  }, [api, project]);
  useEffect(() => {
    setNotice(null);
    const known = project ? lastRead.get(project) : void 0;
    if (known) setLoad({ kind: "ready", list: known.list });
    if (shouldRead(frontNow.current, known?.at ?? null, Date.now())) void reload(!!known);
  }, [reload, project]);
  const wasFront = useRef(front);
  useEffect(() => {
    if (front && !wasFront.current) void reload(true);
    wasFront.current = front;
  }, [front, reload]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4e3);
    return () => clearTimeout(timer);
  }, [notice]);
  const importIssue = useCallback(async (number) => {
    if (!project) return { code: null };
    setBusy(number);
    const out = await call(api, "import", { method: "POST", body: { project, issue: number } });
    setBusy(null);
    if (!out.ok) {
      setNotice({ text: t(errorKey(out.code)), tone: "error" });
      return { code: out.code };
    }
    setNotice({ text: t(out.value.created ? "notice.imported" : "notice.known", { id: out.value.todo.id }), tone: "info" });
    void reload(true);
    return { id: out.value.todo.id, status: "open", progress: null, pr: null };
  }, [api, project, reload]);
  const dismiss = async (number) => {
    if (!project) return;
    const out = await call(api, "dismiss", { method: "POST", body: { project, issue: number } });
    setNotice(out.ok ? { text: t("notice.dismissed", { number }), tone: "info" } : { text: t(errorKey(out.code)), tone: "error" });
    if (out.ok) void reload(true);
  };
  const copyLink = async (url) => {
    setNotice(await copy(url) ? { text: t("notice.copied"), tone: "info" } : { text: t("notice.copyFailed"), tone: "error" });
  };
  const issues = useMemo(() => load.kind === "ready" ? sortCandidates(load.list.issues) : [], [load]);
  const left = load.kind === "ready" ? toImport(load.list.issues) : null;
  const countOnTab = ui.useWidgetCount(left);
  const subtitle = left !== null && !countOnTab ? String(left) : void 0;
  const refreshInMenu = ui.useWidgetMenu(useMemo(() => project ? [{
    key: "refresh",
    label: t("refresh"),
    icon: /* @__PURE__ */ React.createElement(Icon, { d: ICONS.refresh }),
    onSelect: () => {
      void reload();
    }
  }] : [], [project, reload]));
  const actions = /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(GitStackProjectPicker2, { none: t("chooseProjectOption"), label: t("selectProject"), className: "max-w-[8rem]" }), project && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("button", { type: "button", "data-issues-add": "", onClick: () => setOpened({ lookup: true }), title: t("importByNumber"), "aria-label": t("importByNumber"), className: ICON_BUTTON }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.plus })), !refreshInMenu && /* @__PURE__ */ React.createElement("button", { type: "button", "data-issues-refresh": "", onClick: () => void reload(), disabled: load.kind === "loading", title: t("refresh"), "aria-label": t("refresh"), className: ICON_BUTTON }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.refresh }))), handle);
  return /* @__PURE__ */ React.createElement(
    Tile2,
    {
      title: t("widget.title"),
      subtitle,
      className: cn2(ui.HUD_SURFACE, className),
      bodyClassName: "px-1.5 pb-3 pt-1",
      actions
    },
    notice && /* @__PURE__ */ React.createElement("p", { "data-issues-notice": notice.tone, role: "status", className: cn2("px-1 pb-1 text-[11px]", notice.tone === "error" ? "text-red-600 dark:text-red-400" : "text-muted-foreground") }, notice.text),
    !project ? /* @__PURE__ */ React.createElement(Empty, { text: t("chooseProject") }) : load.kind === "loading" || load.kind === "idle" ? /* @__PURE__ */ React.createElement(Empty, { text: t("loading") }) : load.kind === "error" ? /* @__PURE__ */ React.createElement(Empty, { text: t(errorKey(load.code)) }) : issues.length === 0 ? /* @__PURE__ */ React.createElement(Empty, { text: t("empty", { label: load.kind === "ready" ? load.list.label : "" }) }) : /* @__PURE__ */ React.createElement("ul", { "data-issues-list": "", className: "flex flex-col gap-1" }, issues.map((issue) => /* @__PURE__ */ React.createElement(
      IssueRow,
      {
        key: issue.number,
        issue,
        busy: busy === issue.number,
        onImport: () => {
          void importIssue(issue.number);
        },
        onOpenTodo: openTodo,
        onRead: () => setOpened({ number: issue.number }),
        onCopy: () => {
          void copyLink(issue.url);
        },
        onDismiss: () => {
          void dismiss(issue.number);
        }
      }
    ))),
    opened && project && /* @__PURE__ */ React.createElement(
      IssueDialog,
      {
        api,
        project,
        repo: load.kind === "ready" ? load.list.repo : null,
        opened,
        onImport: importIssue,
        onOpenTodo: (id) => {
          setOpened(null);
          openTodo(id);
        },
        onClose: () => setOpened(null)
      }
    ),
    todoModal
  );
}
function Row({ label, children }) {
  return /* @__PURE__ */ React.createElement("div", { className: "flex min-w-0 items-baseline justify-between gap-3 rounded-md bg-background/60 px-3 py-2 text-xs" }, /* @__PURE__ */ React.createElement("dt", { className: "shrink-0 text-muted-foreground" }, label), /* @__PURE__ */ React.createElement("dd", { className: "min-w-0 truncate text-right" }, children));
}
function IssueDialog({ api, project, repo, opened, onImport, onOpenTodo, onClose }) {
  const lookup = "lookup" in opened;
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState(null);
  const [read, setRead] = useState({ kind: "idle" });
  const [importing, setImporting] = useState(false);
  const readIssue = useCallback(async (number) => {
    setRead({ kind: "loading" });
    const out = await call(api, `issue?${query(project, { issue: String(number) })}`);
    setRead(out.ok ? { kind: "ready", issue: out.value } : { kind: "error", text: t(errorKey(out.code)) });
  }, [api, project]);
  useEffect(() => {
    if ("number" in opened) void readIssue(opened.number);
  }, [opened, readIssue]);
  const submitLookup = () => {
    const parsed = parseIssueInput(typed, repo);
    if ("problem" in parsed) {
      setProblem(t(`problem.${parsed.problem}`, { repo: repo ?? "" }));
      return;
    }
    setProblem(null);
    void readIssue(parsed.number);
  };
  const issue = read.kind === "ready" ? read.issue : null;
  const closed = issue?.state === "closed";
  const runImport = async () => {
    if (!issue) return;
    setImporting(true);
    const out = await onImport(issue.number);
    setImporting(false);
    if ("id" in out) setRead({ kind: "ready", issue: { ...issue, todo: out } });
    else setRead({ kind: "error", text: t(errorKey(out.code)) });
  };
  const href = safeHref(issue?.url);
  return /* @__PURE__ */ React.createElement(Dialog2, { open: true, onOpenChange: (open) => {
    if (!open) onClose();
  } }, /* @__PURE__ */ React.createElement(DialogContent2, { "data-issue-dialog": "", className: "flex max-h-[85vh] max-w-[900px] flex-col gap-3 overflow-hidden" }, /* @__PURE__ */ React.createElement(DialogTitle2, { className: "flex min-w-0 flex-wrap items-center gap-2 text-sm" }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.issue, className: "size-4 shrink-0 text-muted-foreground" }), /* @__PURE__ */ React.createElement("span", { "data-issue-title": "", className: "min-w-0 truncate" }, issue ? issue.title : t("dialog.lookupTitle")), issue && /* @__PURE__ */ React.createElement("span", { className: cn2(CHIP, "bg-foreground/[0.06] text-muted-foreground") }, meta(issue.number, issue.author)), issue && /* @__PURE__ */ React.createElement(LabelChips, { labels: issue.labels })), /* @__PURE__ */ React.createElement(DialogDescription2, { className: "sr-only" }, t("dialog.text")), lookup && /* @__PURE__ */ React.createElement("div", { className: "flex items-end gap-2" }, /* @__PURE__ */ React.createElement("div", { className: "flex min-w-0 flex-1 flex-col gap-1" }, /* @__PURE__ */ React.createElement(Label2, { htmlFor: "github-issues-lookup", className: "text-[11.5px] text-muted-foreground" }, t("dialog.lookupLabel")), /* @__PURE__ */ React.createElement(
    Input2,
    {
      id: "github-issues-lookup",
      value: typed,
      autoFocus: true,
      maxLength: 300,
      placeholder: t("dialog.lookupPlaceholder"),
      "aria-invalid": problem !== null,
      onChange: (e) => {
        setTyped(e.target.value);
        setProblem(null);
      },
      onKeyDown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitLookup();
        }
      }
    }
  )), /* @__PURE__ */ React.createElement(Button2, { type: "button", variant: "outline", onClick: submitLookup, disabled: read.kind === "loading", className: "shrink-0" }, read.kind === "loading" ? t("dialog.reading") : t("dialog.read"))), problem && /* @__PURE__ */ React.createElement("p", { "data-issue-problem": "", className: "text-[11.5px] text-red-600 dark:text-red-400" }, problem), (issue || read.kind === "loading" || read.kind === "error") && /* @__PURE__ */ React.createElement("div", { className: "grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_19rem]" }, /* @__PURE__ */ React.createElement("section", { className: cn2(ISLAND, "flex min-h-0 min-w-0 flex-col gap-2 p-3"), "aria-label": t("dialog.text") }, /* @__PURE__ */ React.createElement("h3", { className: "text-[11.5px] font-medium text-muted-foreground" }, t("dialog.text")), read.kind === "loading" ? /* @__PURE__ */ React.createElement("p", { className: "text-xs text-muted-foreground" }, t("loading")) : read.kind === "error" ? /* @__PURE__ */ React.createElement("p", { "data-issue-error": "", className: "text-xs text-red-600 dark:text-red-400" }, read.text) : issue && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { "data-issue-body": "", className: "scrollbar-thin max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/60 px-3 py-2 text-[12.5px] leading-relaxed" }, issue.body.trim() ? issue.body : /* @__PURE__ */ React.createElement("span", { className: "text-muted-foreground" }, t("dialog.noText"))), issue.truncated && /* @__PURE__ */ React.createElement("p", { className: "text-[11px] text-muted-foreground" }, t("dialog.cut")))), issue && /* @__PURE__ */ React.createElement("section", { className: cn2(ISLAND, "flex min-w-0 flex-col gap-2 p-3"), "aria-label": t("dialog.importSection") }, /* @__PURE__ */ React.createElement("h3", { className: "text-[11.5px] font-medium text-muted-foreground" }, t("dialog.importSection")), /* @__PURE__ */ React.createElement("dl", { className: "flex flex-col gap-2" }, /* @__PURE__ */ React.createElement(Row, { label: t("dialog.project") }, project), /* @__PURE__ */ React.createElement(Row, { label: t("dialog.link") }, href ? /* @__PURE__ */ React.createElement("a", { href, target: "_blank", rel: "noopener noreferrer", className: "text-primary underline-offset-2 hover:underline" }, `github \xB7 ${issue.repo}#${issue.number}`) : `github \xB7 ${issue.repo}#${issue.number}`), closed && /* @__PURE__ */ React.createElement(Row, { label: t("dialog.state") }, t("dialog.stateClosed")), issue.todo && /* @__PURE__ */ React.createElement(Row, { label: t("chip.todo") }, /* @__PURE__ */ React.createElement("span", { className: cn2(CHIP, TODO_TONE) }, `#${issue.todo.id}`))))), /* @__PURE__ */ React.createElement("div", { className: "flex flex-wrap items-center justify-end gap-2" }, /* @__PURE__ */ React.createElement(Button2, { type: "button", variant: "ghost", size: "sm", onClick: onClose }, t("dialog.close")), issue?.todo ? /* @__PURE__ */ React.createElement(Button2, { type: "button", size: "sm", onClick: () => onOpenTodo(issue.todo.id) }, /* @__PURE__ */ React.createElement("span", { "data-issue-dialog-open": "", className: "inline-flex items-center gap-1.5" }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.todo }), t("openTodo"))) : /* @__PURE__ */ React.createElement(
    Button2,
    {
      type: "button",
      size: "sm",
      onClick: () => {
        void runImport();
      },
      disabled: !issue || closed || importing,
      title: closed ? t("dialog.closedHint") : void 0
    },
    /* @__PURE__ */ React.createElement("span", { "data-issue-dialog-import": "", className: "inline-flex items-center gap-1.5" }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.import }), importing ? t("importing") : t("import"))
  ))));
}
function SettingsRow({ api }) {
  const settings = ui.useProjectSettings();
  const project = settings?.project ?? null;
  const [state, setState] = useState({ kind: "loading" });
  const [editing, setEditing] = useState(false);
  const reload = useCallback(async () => {
    if (!project) {
      setState({ kind: "hidden" });
      return;
    }
    const out = await call(api, `project?${query(project)}`);
    if (!out.ok) {
      setState({ kind: "hidden" });
      return;
    }
    setState({ kind: "ready", label: out.value, count: null });
    const list = await call(api, `candidates?${query(project)}`);
    if (list.ok) setState({ kind: "ready", label: out.value, count: toImport(list.value.issues) });
  }, [api, project]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const useDefault = async () => {
    if (!project) return;
    const out = await call(api, "project", { method: "PUT", body: { project, label: null } });
    if (out.ok) void reload();
  };
  if (state.kind !== "ready" || !project) return null;
  const { label, count } = state;
  return /* @__PURE__ */ React.createElement("div", { "data-issues-settings": project, className: "flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2" }, /* @__PURE__ */ React.createElement("div", { className: "min-w-0 flex-1" }, /* @__PURE__ */ React.createElement("div", { className: "text-[12.5px] font-medium text-foreground" }, t("settings.title")), /* @__PURE__ */ React.createElement("div", { "data-issues-settings-status": "", className: "truncate text-[11px] text-muted-foreground" }, count === null ? t("settings.statusNoCount", { label: label.label }) : t("settings.status", { label: label.label, count }))), /* @__PURE__ */ React.createElement(Button2, { type: "button", variant: "outline", size: "sm", onClick: () => setEditing(true), className: "shrink-0" }, /* @__PURE__ */ React.createElement("span", { "data-issues-configure": "" }, t("settings.configure"))), label.custom && /* @__PURE__ */ React.createElement(DropdownMenu2, { modal: false }, /* @__PURE__ */ React.createElement(DropdownMenuTrigger2, { asChild: true }, /* @__PURE__ */ React.createElement("button", { type: "button", title: t("more"), "aria-label": t("more"), className: ICON_BUTTON }, /* @__PURE__ */ React.createElement(Icon, { d: ICONS.more }))), /* @__PURE__ */ React.createElement(DropdownMenuContent2, { sideOffset: 6, align: "end", className: MENU }, /* @__PURE__ */ React.createElement(NativeViewCover2, null), /* @__PURE__ */ React.createElement(DropdownMenuItem2, { "data-menu-default-label": "", onSelect: () => {
    void useDefault();
  }, className: MENU_ITEM }, t("settings.useDefault")))), editing && /* @__PURE__ */ React.createElement(LabelDialog, { api, project, current: label.label, onClose: () => setEditing(false), onSaved: () => {
    setEditing(false);
    void reload();
  } }));
}
function LabelDialog({ api, project, current, onClose, onSaved }) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const problem = labelProblem(value);
  const save = async () => {
    if (problem) return;
    setSaving(true);
    const out = await call(api, "project", { method: "PUT", body: { project, label: value.trim() } });
    setSaving(false);
    if (out.ok) onSaved();
    else setError(t(errorKey(out.code)));
  };
  return /* @__PURE__ */ React.createElement(Dialog2, { open: true, onOpenChange: (open) => {
    if (!open) onClose();
  } }, /* @__PURE__ */ React.createElement(DialogContent2, { "data-issues-label-dialog": "", className: "max-w-[460px]" }, /* @__PURE__ */ React.createElement(DialogTitle2, { className: "text-sm" }, t("settings.dialogTitle", { project })), /* @__PURE__ */ React.createElement(DialogDescription2, { className: "sr-only" }, t("settings.label")), /* @__PURE__ */ React.createElement("div", { className: "flex flex-col gap-1.5" }, /* @__PURE__ */ React.createElement(Label2, { htmlFor: "github-issues-label", className: "text-[11.5px] text-muted-foreground" }, t("settings.label")), /* @__PURE__ */ React.createElement(
    Input2,
    {
      id: "github-issues-label",
      value,
      autoFocus: true,
      maxLength: 60,
      "aria-invalid": problem !== null && value !== "",
      onChange: (e) => {
        setValue(e.target.value);
        setError(null);
      },
      onKeyDown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void save();
        }
      }
    }
  ), problem && value !== "" && /* @__PURE__ */ React.createElement("p", { className: "text-[11.5px] text-red-600 dark:text-red-400" }, t(`labelProblem.${problem}`)), error && /* @__PURE__ */ React.createElement("p", { className: "text-[11.5px] text-red-600 dark:text-red-400" }, error)), /* @__PURE__ */ React.createElement("div", { className: "flex justify-end gap-2" }, /* @__PURE__ */ React.createElement(Button2, { type: "button", variant: "ghost", size: "sm", onClick: onClose }, t("settings.cancel")), /* @__PURE__ */ React.createElement(Button2, { type: "button", size: "sm", onClick: () => {
    void save();
  }, disabled: !!problem || saving }, /* @__PURE__ */ React.createElement("span", { "data-issues-label-save": "" }, saving ? t("settings.saving") : t("settings.save"))))));
}
function apply(ctx) {
  const api = (path, init) => ctx.api(path, init);
  const Widget = (props) => /* @__PURE__ */ React.createElement(IssuesWidget, { api, ...props });
  const Settings = () => /* @__PURE__ */ React.createElement(SettingsRow, { api });
  const disposers = [
    ctx.slots.register({
      slot: "cockpit.widget",
      key: "issues",
      widget: {
        title: t("widget.title"),
        description: t("widget.description"),
        icon: ISSUES_PICTO,
        // Its count stays on its tab ("Issues 2") while another tab is in front.
        liveCount: true,
        zone: "droite",
        frame: "none",
        height: 320,
        minHeight: 160
      }
    }, Widget),
    ctx.slots.register({ slot: "project.settings" }, Settings)
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
export {
  apply
};
