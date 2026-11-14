# Translating Timon

<!-- french-ok-file: the glossaries quote every language the interface ships, French included -->

Timon's interface is translated in the files of this repository, by pull
request. There is no translation platform and no account to create: you edit
JSON files, run two commands, and open a pull request. You never touch
TypeScript.

Drafts made with a machine translation or an AI assistant are welcome, as long
as you read every line in context afterwards: a sentence that is correct on its
own can be wrong on the button it labels.

## Where the texts live

```
app/src/locales/
  en/   meta.json  core.json  agentChat.json  …  workspace.json
  fr/   meta.json  core.json  …
  <your language>/  …
```

- **One folder per language**, named by its BCP 47 tag: `de`, `es`, `ja`,
  `pt-BR` (region in capitals). A language exists as soon as its folder holds a
  `meta.json`: there is no list to update anywhere else, the language selector
  shows it on the next build.
- **English (`en/`) is the source.** It is the only language that must be
  complete. Every other language may be partial: a message your language lacks
  is shown in English, message by message. So you can translate one screen,
  open a pull request, and come back later.
- **Each file is a namespace**: `core.json` holds most of the interface,
  `agentChat.json` the chat, `login.json` the sign-in page, and so on. A key is
  the dotted path to a message: `{ "taskForm": { "create": "Create" } }` is the
  key `taskForm.create`. Your files use the same names and the same keys as the
  English ones; only the values change.
- `desktop.json`, when present, holds the texts of the desktop app's own
  windows and menus. It is translated the same way.

## Add a language

1. Create `app/src/locales/<tag>/meta.json`:

   ```json
   { "name": "Deutsch", "dir": "ltr" }
   ```

   - `name`: the name of the language **in that language**, shown as is in the
     selector (`Deutsch`, `日本語`, `Português (Brasil)`).
   - `dir`: `ltr`, or `rtl` for a right-to-left script.
   - `fallback` (optional): languages read before English, e.g.
     `"fallback": ["pt"]` for a regional variant.
   - `default` (optional): `true` on the variant chosen when a reader asks for
     the bare language (`pt` → `pt-BR`) and two variants exist.

2. Copy the English files you want to translate into your folder — all of them,
   or only some — and translate the **values**. Keep the keys, the structure
   and every `{argument}` exactly as they are.
   One part is required: the titles and subtitles of the first-run screens
   (`onboarding.json` and `onboardingPreparation.json`, the keys listed in
   `app/src/components/onboarding/onboarding-language.test.ts`). They are the
   first thing a new user reads, right after picking your language.
3. Check your work (see [Check your work](#check-your-work)).
4. Open a pull request titled `i18n(<tag>): …`.

## Fix a translation

1. Find the text: search for the wrong sentence under `app/src/locales/<tag>/`.
   To find the key of a text you only see in English, search for the English
   sentence under `app/src/locales/en/`, then open the same file and the same
   key in your language.
2. Change the value, never the key.
3. Check your work, then open a pull request.

If a text on screen does not change when you switch language, it is written
in the code instead of a message file. That is a bug: open an issue naming the
screen and the text.

## The message format

Messages use **ICU MessageFormat**. Most messages are plain text, sometimes
with an argument in braces:

```json
"renameLabel": "Rename {name}"
```

`{name}` is replaced by a value at run time. Keep it, spelled exactly the same,
anywhere the sentence of your language needs it. Never translate what is
between braces.

### Plurals

A count is written as a plural, inside one message:

```json
"selected": "{count, plural, one {# file selected} other {# files selected}}"
```

- `#` is the number, written as your language writes numbers.
- Use the categories **your language** has — not English's. `other` is always
  required:

  | Language | Categories |
  |---|---|
  | English, German, Dutch | `one`, `other` |
  | French, Spanish, Italian, Portuguese (Brazil) | `one`, `many`, `other` (`many` only for very large round numbers; it may be left out) |
  | Polish | `one`, `few`, `many`, `other` |
  | Japanese, Korean | `other` only |

  Any other language: `new Intl.PluralRules('<tag>').resolvedOptions().pluralCategories`
  in a browser console lists them.
- An exact value is written `=0 {No file}` and works in every language.

Polish, for example:

```json
"selected": "Wybrano {count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}"
```

A `select` chooses between variants, for example on a status:
`{state, select, done {Finished} failed {Failed} other {Running}}`. Translate
the texts in the braces, never the words before them (`done`, `failed`,
`other`).

### Braces and apostrophes

- A literal brace is written between apostrophes: `'{'` and `'}'`
  (`"Use '{{name}}' in the template"`).
- An apostrophe in ordinary text stays as is: `l'agent`, `don't`.
- An ASCII apostrophe directly before `{`, `}`, `#` or another apostrophe must
  be doubled: `''`. The typographic apostrophe (`’`) never needs escaping.

### No markup

A message is plain text: `<b>` or a link written inside it is shown as typed.
When a sentence holds a link or a button, the code assembles it from two or
three messages; translate each part so that the whole reads naturally.

## Glossary

Never translate:

- **Timon**, the product name, nor `{brand}`, the argument that stands for it.
- Anything between braces: `{name}`, `{count}`, the words of a `plural` or
  `select` (`one`, `other`, `done`…).
- Commands, options and code: `timon service install`, `--dry-run`, `npm`,
  `git push`, file names and paths (`~/.timon`, `SKILL.md`, `.mcp.json`),
  environment variables (`TIMON_HOME`), keys of a configuration file.
- Names of other products and protocols: Claude Code, Codex, GitHub, Docker,
  MCP, SSH, Kanban.
- Keyboard keys as the keyboard prints them: `Ctrl`, `Cmd`, `Shift`, `Enter`
  (translate them only where your users' keyboards print another word, as
  German `Strg`).

Translate, and keep the same word everywhere in your language: the concepts
of the product — agent, mission, task, skill, project, widget, island,
cockpit, plugin, routine, memory, workspace. When a term already has a
translation in your language's files, reuse it: search the folder before
choosing a new one.

Each language keeps its own short glossary below, so that the next
translator picks the same words. Add yours when you add a language.

### Français (`fr`)

Address the reader with **vous** (`Réessayez`, `votre agent`); a few older
messages still say `tu`, fix them when you touch them. French typography: a
space before `:` `?` `!` `;`, quotes « … ».

| English | Français | Note |
|---|---|---|
| agent, mission, workflow, routine, widget, plugin, skill, cockpit, backend | identical | masculine: `l'agent`, `le skill`, `le workflow` |
| task | tâche | `task` survives in older Kanban messages; write `tâche` in new ones |
| project | projet | |
| island | îlot | |
| team (of agents, of bots) | équipe | `team` survives in the Bots rail |
| turn (of an agent) | tour | |
| steer / queue (a message) | réorienter / mettre en file | |
| memory, rule, pitfall | mémoire, règle, piège | |
| idea (of the TO DO notebook) | idée | the notebook itself stays « TO DO » |
| secrets vault | coffre de secrets | |
| provider (of models) | fournisseur | |
| model | modèle | |
| pair (a device) | appairer | |
| sign-in | connexion | |
| license | licence | |
| settings | Réglages (in sentences), Paramètres (dialog title) | |
| draft | brouillon | |
| layout | disposition | |
| run (of a workflow), merge, worktree, commit, push, trigger | identical | developer vocabulary, kept in English: `mergée`, `committer` |
| not found | introuvable | `Agent introuvable.` |

### Español (`es`)

Neutral Spanish, informal *tú* ("Comprueba la conexión"); buttons and menu
items in the infinitive ("Guardar", "Eliminar la tarea"); opening `¿` and `¡`.

| English | es | English | es |
|---|---|---|---|
| agent | agente | mission | misión |
| task | tarea | skill | skill (la skill) |
| project | proyecto | island | isla |
| plugin | plugin | widget | widget |
| routine | rutina | trigger | disparador |
| workflow | workflow | memory | memoria |
| dreams | sueños | inbox | bandeja de entrada |
| workspace | espacio de trabajo | settings | configuración |
| secret | secreto | secrets vault | almacén de secretos |
| model | modelo | orchestrator | orquestador |
| branch | rama | file / folder | archivo / carpeta |
| user | usuario | sign in | iniciar sesión |
| save / delete / remove | Guardar / Eliminar / Quitar | try again | vuelve a intentarlo |

### Italiano (`it`)

Informal *tu*; buttons and menu items in the imperative ("Salva", "Elimina
l’attività"). The typographic apostrophe `’` everywhere: an ASCII `'` is an
escape character in ICU.

| English | it | English | it |
|---|---|---|---|
| agent | agente | mission | missione |
| task | attività | skill | skill (la skill) |
| project | progetto | island | isola |
| plugin | plugin | widget | widget |
| routine | routine | trigger | trigger |
| workflow | workflow | memory | memoria |
| dreams | sogni | inbox | posta in arrivo |
| workspace | area di lavoro | settings | impostazioni |
| secret | segreto | secrets vault | archivio dei segreti |
| model | modello | orchestrator | orchestratore |
| branch | branch | file / folder | file / cartella |
| user | utente | sign in | accedi |
| save / delete / remove | Salva / Elimina / Rimuovi | try again | Riprova |

### Português (Brasil) (`pt-BR`)

Brazilian vocabulary only (*arquivo*, *tela*, *usuário*, *aplicativo*,
*excluir*, *salvar*), never the European forms (*ficheiro*, *ecrã*,
*utilizador*); *você*; buttons and menu items in the infinitive ("Salvar",
"Excluir a tarefa").

| English | pt-BR | English | pt-BR |
|---|---|---|---|
| agent | agente | mission | missão |
| task | tarefa | skill | skill (a skill) |
| project | projeto | island | ilha |
| plugin | plugin | widget | widget |
| routine | rotina | trigger | gatilho |
| workflow | workflow | memory | memória |
| dreams | sonhos | inbox | caixa de entrada |
| workspace | espaço de trabalho | settings | configurações |
| secret | segredo | secrets vault | cofre de segredos |
| model | modelo | orchestrator | orquestrador |
| branch | branch | file / folder | arquivo / pasta |
| user | usuário | sign in | entrar |
| save / delete / remove | Salvar / Excluir / Remover | try again | Tentar novamente |

Kept as is in all three: Cockpit, Brain, Multichat, Kanban, Git, MCP, Apps,
Bots, backend, daemon, worktree, commit, merge, push, pull, the vault of notes.

#### Polski (`pl`)

Informal *ty* ("Sprawdź połączenie"); buttons and menu items in the
imperative ("Zapisz", "Usuń zadanie"); Polish quotation marks „…”, never
ASCII `"`. Every count goes through a plural with the four categories, even
where the English message prints a bare `{count} task(s)`: write
`{count} {count, plural, one {zadanie} few {zadania} many {zadań} other {zadania}}`,
the number kept as an argument and the plural choosing only the noun, so a
count the code already formatted still reads right. A short status reads as a
label, not a sentence: "zadania: {count}".

| English | pl | English | pl |
|---|---|---|---|
| agent | agent | mission | misja |
| task | zadanie | skill | umiejętność |
| project | projekt | island | wyspa |
| plugin | wtyczka | widget | widżet |
| routine | rutyna | trigger | wyzwalacz |
| workflow | przepływ | memory | pamięć |
| dreams | sny | inbox | skrzynka odbiorcza |
| workspace | obszar roboczy | settings | ustawienia |
| secret | sekret | secrets vault | sejf sekretów |
| model | model | orchestrator | orkiestrator |
| branch | gałąź | file / folder | plik / folder |
| user | użytkownik | sign in | zaloguj się |
| daemon | demon | pipeline | potok |
| review / merge | przegląd / scalanie | push | wypchnij |
| save / delete / remove | Zapisz / Usuń / Usuń | try again | Spróbuj ponownie |

Kept as is: Cockpit (Kokpit), Kanban, Git, MCP, backend, worktree, commit,
slug, prompt, CLI, TO DO.

### 日本語 (`ja`)

Polite standard register of software (です／ます) in sentences and messages;
buttons and labels are nouns or verb stems (`保存`, `削除`, `エージェントを追加`).
Half-width spaces around Latin words and numbers (`Timon に接続`, `{count} 件`),
Japanese brackets `「」` around a quoted name, `？` after a question, ASCII
`:` before a value.

| English | 日本語 | English | 日本語 |
|---|---|---|---|
| agent | エージェント | mission | ミッション |
| task | タスク | skill | スキル |
| project | プロジェクト | workspace | ワークスペース |
| widget | ウィジェット | island | アイランド |
| cockpit | コックピット | plugin | プラグイン |
| routine | ルーティン | trigger | トリガー |
| workflow | ワークフロー | memory | メモリ |
| dream | ドリーム | vault (notes) | ボールト |
| secrets vault | シークレット保管庫 | secret | シークレット |
| backend | バックエンド | provider | プロバイダー |
| model | モデル | orchestrator | オーケストレーター |
| daemon | デーモン | service | サービス |
| worktree | ワークツリー | branch / commit / merge / push | ブランチ / コミット / マージ / プッシュ |
| review | レビュー | fallback | フォールバック |
| quota | クォータ | turn | ターン |
| sign in | サインイン | settings | 設定 |
| browser | ブラウザー | folder | フォルダー |
| permission | 権限 | role | ロール |
| licence | ライセンス | superadmin | スーパー管理者 |
| machine | マシン | device | デバイス |
| inbox | 受信箱 | notification | 通知 |
| dictation | 音声入力 | annotation | 注釈 |
| compact (a conversation) | 圧縮 | pole | ポール |

### 한국어 (`ko`)

Formal register (합니다체) in sentences and messages; buttons and labels are
nouns (`저장`, `삭제`, `에이전트 추가`). Korean particles after an argument use
the double form, since the value is unknown: `{name}을(를)`, `{name}이(가)`,
`{name}(으)로`, `{name}와(과)`. Spaces between words as in Korean prose; no
space before `:`.

| English | 한국어 | English | 한국어 |
|---|---|---|---|
| agent | 에이전트 | mission | 미션 |
| task | 작업 | skill | 스킬 |
| project | 프로젝트 | workspace | 워크스페이스 |
| widget | 위젯 | island | 아일랜드 |
| cockpit | 콕핏 | plugin | 플러그인 |
| routine | 루틴 | trigger | 트리거 |
| workflow | 워크플로 | memory | 메모리 |
| dream | 드림 | vault (notes, secrets) | 볼트 |
| secret | 시크릿 | backend | 백엔드 |
| provider | 공급자 | model | 모델 |
| orchestrator | 오케스트레이터 | daemon | 데몬 |
| worktree | 워크트리 | branch / commit / merge / push | 브랜치 / 커밋 / 병합 / 푸시 |
| review | 리뷰 | fallback | 대체 |
| quota | 할당량 | turn | 턴 |
| sign in | 로그인 | settings | 설정 |
| permission | 권한 | role | 역할 |
| licence | 라이선스 | superadmin | 최고 관리자 |
| machine (the Machines plugin) | 머신 | machine (a computer) | 컴퓨터 |
| device | 기기 | inbox | 받은편지함 |
| notification | 알림 | dictation | 받아쓰기 |
| annotation | 주석 | compact (a conversation) | 압축 |
| pole | 폴 | attach (a skill) | 연결 |

### Deutsch (`de`)

Informal "du", imperative on buttons ("Speichern", "Agenten bearbeiten").
Tech terms that German developers use as is stay in English: Backend, Branch,
Commit, Merge, Push, Prompt, Token, Tool, Trigger, Workflow, Worktree, Skill,
Plugin, Widget, Cockpit, Kanban, Daemon, Turn (a model's turn), Fallback.

| English | Deutsch |
|---|---|
| agent / main agent | Agent / Hauptagent |
| mission | Mission |
| task | Aufgabe |
| project | Projekt |
| island | Insel |
| routine | Routine |
| memory | Gedächtnis |
| workspace | Arbeitsbereich |
| settings | Einstellungen |
| appearance | Darstellung |
| provider | Anbieter |
| quota | Kontingent |
| secret / vault | Geheimnis / Tresor |
| permission | Berechtigung |
| approve / approval | freigeben / Freigabe |
| notification | Benachrichtigung |
| sign in / sign out | anmelden / abmelden |
| machine (a computer running Timon) | Rechner |
| conversation | Unterhaltung |
| compact (a conversation) | kompaktieren |
| steer (a running turn) | umlenken |
| queue (a message) | einreihen |
| Retry / Try again (button) | Wiederholen |

### Nederlands (`nl`)

Informal "je/jij", infinitive on buttons, without article ("Opslaan", "Agent
bewerken", "Account toevoegen"). Tech terms that stay in English: backend,
branch, commit, merge, push, prompt, token, tool, trigger, workflow, worktree,
skill, widget, cockpit, Kanban, daemon, provider, payload.

| English | Nederlands |
|---|---|
| agent / main agent | agent / hoofdagent |
| mission | missie |
| task | taak |
| project | project |
| island | eiland |
| plugin | plug-in |
| routine | routine |
| memory | geheugen |
| workspace | werkruimte |
| settings | instellingen |
| appearance | weergave |
| quota | quotum |
| fallback | reserve |
| secret / vault | geheim / kluis |
| permission | toestemming |
| approve / approval | goedkeuren / goedkeuring |
| notification | melding |
| sign in / sign out | aanmelden / afmelden |
| machine | machine |
| conversation | gesprek |
| turn (a model's turn) | beurt |
| compact (a conversation) | comprimeren |
| steer (a running turn) | bijsturen |
| connect / disconnect | koppelen / ontkoppelen |

### 简体中文 (`zh-CN`)

Address the reader as 你. Use Chinese punctuation in prose and keep command
examples, shortcuts, paths and product names intact. Plural messages use
`other` and any exact-number variants from English.

| English | 简体中文 | English | 简体中文 |
|---|---|---|---|
| agent | 智能体 | orchestrator | 协调器 |
| mission | 任务会话 | task | 任务 |
| project | 项目 | cockpit | 控制台 |
| island | 面板 | widget | 小组件 |
| plugin | 插件 | skill | 技能 |
| routine | 例行任务 | workflow | 工作流 |
| trigger | 触发器 | memory | 记忆 |
| workspace | 工作区 | settings | 设置 |
| backend | 后端 | provider | 提供商 |
| Kanban | 看板 | worktree | 工作树 |

## Tone

- Plain, short and direct. A label says what happens: "Save", "Delete the
  agent", not "Click here to save".
- Sentence case for titles and buttons, unless your language's rules say
  otherwise ("Delete branch?", not "Delete Branch?").
- No exclamation marks, no jokes, no marketing. An error says what went wrong,
  then what to do: "Cannot reach Timon. Check your connection and try again."
- Address the reader the way modern software in your language usually does,
  and stay consistent: if your language's files already use an informal or a
  formal "you", follow them.
- Keep the punctuation of your language (French puts a space before `:` `?`
  `!`, Spanish opens `¿`…).

## Check your work

From the root of the repository, with Node.js 22 or later:

```bash
cd app && npm ci && node scripts/check-locales.mjs
```

It must end with `0 error(s)`. It refuses a file that is not valid JSON, a
message that does not parse, an argument that differs from English, a plural
category your language does not have. A warning about an "unknown key" means
your file holds a key English no longer has: remove it.

```bash
node scripts/i18n-report.mjs --missing <tag>
```

(from the repository root) prints the coverage of every language and lists,
file by file, the English messages your language still lacks.

To see your translation on screen, run the app from source
([GETTING-STARTED.md](GETTING-STARTED.md)), open **Settings › Interface ›
Language** and pick your language. Look for:

- **Length**: German, Dutch, Polish or Spanish run 20 to 40 % longer than
  English. A cut or overlapping label needs a shorter wording, or an issue if
  no wording fits.
- **Context**: a word that is right alone and wrong on its button.
- **Japanese and Korean**: line breaks and the font in use.

In development (`npm run dev`), the pseudo-language **en-XA** turns every
translated text into a longer, accented version between brackets: a text that
stays plain English is written in the code, a bracket cut off is a text that
overflows.

## Checklist for a pull request

- [ ] `node scripts/check-locales.mjs` (in `app/`) reports `0 error(s)`.
- [ ] Keys, file names and `{arguments}` are unchanged; only values are
      translated.
- [ ] Nothing from the glossary's "never translate" list was translated.
- [ ] Your new language has a `meta.json` with its name in that language.
- [ ] You looked at the screens you translated, in the app.
