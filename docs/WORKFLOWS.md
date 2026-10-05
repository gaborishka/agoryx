# Structured work modes in Agoryx 0.1.0

**New conversation** opens one composer with two compact, independent choices: **Mode** and **Project**.
The mode picker explains when to use Chat, Work, Verification, Council, Tournament or Debate. Changing
it preserves the brief, agents and draft settings. A project-scoped New action preselects that project
and starts in Chat. In Work, the compact context chip shows the selected project, folder, or “New folder”.
The same menu contains project selection and working-folder/branch controls; there is no extra folder
row or contradictory “No project” label in the Work composer.

All conversations share one sidebar, grouped by project, with a mode icon on each row. Conversations
without a project stay together regardless of mode. A row opens its latest activity; the room's
Sessions view retains every protocol run, including older modes. Projects can contain Chat, Work and
all four protocols. Settings uses the same sidebar for its sections, without an additional column.

A conversation's `projectKey` is logical membership, separate from its execution `workspace` and its
saved Work workspace (`project`). Null means standalone; absent fields in old logs retain legacy folder
inference. Membership changes are event-backed and human-only, preserve files, and wait for idle
native/private execution. Switching native modes preserves explicit membership. Project Chat gets
shared project instructions and memory while keeping its conversation-materials workspace; it does not
receive additional writable CLI roots from project context folders.

Inside a conversation, the same mode/project choices let it evolve through Chat → Council → Work →
Verification. Before a private session, select which messages, finished results and text files to carry
forward. The server resolves IDs only within that conversation, excludes sealed submissions, and freezes
the selected copies identically for all participants. Final results retain decisions, checks and dissent.
The combined limit is 20 materials / 200 KB. Nothing is silently copied from native attachments or the
rest of the conversation. “Discuss in chat” prepares an editable result summary before sending.
For Verification, that draft also includes the latest revealed creation/repair artifact; private or
failed repair rounds never replace it.

Setup is a working desk, with the brief and observable criteria beside an editable team formation:
Verification connects an author with reviewers and a return loop; Council arranges independent
voices around a shared reveal; Tournament uses prototype lanes and an independent comparison bench;
Debate separates opposing advocates and the judge. Vacant roles have direct Add actions. Model
selection, role changes, participant removal and teams up to eight remain functional. Enter adds a
criterion; pasting multiple lines preserves separate criteria. Time/output controls are secondary.

Every existing chat has three persistent views: **Conversation**, **Table**, and **Sessions**.
Sessions lists current and saved runs across all four protocols. **New session** starts another
mode in the same chat. Chat remains the open conversation, and Table remains its shared decision
surface; neither is a protocol session. Chat and Work are separate modes in the UI and use their
existing `chat` / `work` execution semantics. Returning from a protocol to Conversation or Table
selects the room's own Chat or Work mode. A project's New action starts in Chat with that project selected.

Workflow creation first prepares the chat without starting a native agent turn, then opens the
room-scoped setup. This makes project material selection available before the private run starts.
A known created chat is retained for retry; an ambiguous creation response is surfaced for recovery
instead of automatically posting a duplicate. A late response cannot erase a newer creation draft.
A requested worktree requires a confirmed Git project and base; pending or failed checks cannot
silently switch execution to the source folder. New project folders remain an explicit choice.

Workspaces are addressable as `#workspace/council`; creation with project scope remains
`#new?mode=council&dir=…`. `#modes` is a compatibility entry to the Chat workspace. A chat's complete
session list remains `#<room>?view=sessions`. Saved runs use `#<room>?mode=council&run=<id>`; `run=new`
opens setup explicitly. Browser Back and reload preserve the selected view/run. Moving from a
protocol to Conversation creates a history entry so Back restores that exact run. Missing saved
runs show an unavailable state rather than silently displaying the latest result.

Results have mode-specific working surfaces. Verification places the artifact beside an evidence
desk with criterion counts and a review-record switch. Council separates synthesis with dissent in
the margin, independent voices, and peer rankings. Tournament provides prototype comparison and
implementation views, retaining human selection/combination and preview controls. Debate separates
the argument exchange from the judge's verdict and the human's decision. Completed process details
are expandable at every width; active phase controls remain visible. Hidden rounds use the team
formation with actual sealed/waiting/working states, without fabricated activity or partial text.
Layouts respond to available board width. A stopped session retains a neutral recovery notice;
unknowns and unresolved disagreements remain part of the visible evidence.

Start with a task, explicit acceptance criteria, participants and session roles. Roles apply only to
this run. Optional project materials are copied once at the start, so every participant sees the same
input even if the original files change later. Each room has at most one active workflow. Finish or
stop it before starting a normal chat turn or changing its participants.

## Mode contracts

| Mode | Participants | Process and result |
| --- | --- | --- |
| Verification | One author, one or more independent reviewers | Create → review every original criterion → return failed criteria to the author → revise → recheck. The final report records passed, failed and unknown criteria with evidence and remaining uncertainty. |
| Council | Two to eight members | Parallel private answers → anonymous peer review → synthesis → a different member's dissent audit. Two members critique each other; three or more rank all peers without self-ranking. Different models offer more useful diversity. |
| Tournament | At least two contenders and one separate evaluator | Parallel short prototypes with identical inputs and limits → independent comparison → human selects one or combines several → full artifact. Evaluators never author prototypes in the same run. |
| Debate | One advocate for, one against, at least one separate judge | Private openings → each restates the other → original authors explicitly accept or request corrections → new arguments → rebuttals. Concessions reference a newly introduced opponent argument. The judge preserves unresolved disagreements and possible decisive tests; the human can override the verdict without deleting it. |

The system validates structured reviews, criterion coverage, peer rankings, acceptance booleans,
argument references, participant roles and human decision gates. It does not claim that syntactic
validation proves a model's reasoning correct. Reviewers must distinguish checks they executed from
inspection and inference. Exhausting repairs preserves failed criteria; failure to agree on
restatements reaches an unresolved-disagreement verdict without allowing rebuttals.
Debaters may report no new argument instead of inventing one; then they cannot concede on the basis
of nonexistent novelty. When judges disagree, the report retains each judge's evidence, lists the
disagreement, and aggregates each criterion conservatively: failed, then unknown, then passed.

Council follows the independent-answer, anonymous-review, synthesis pattern described in
[karpathy/llm-council](https://github.com/karpathy/llm-council), with reciprocal critique for two
participants and a separate check for lost disagreements.

## Hidden phases

A different working directory or an instruction to keep work private would still let native agent
tools read sibling work. Workflows instead run the entire CLI and all subprocesses inside the OS
boundary. Each submission starts with a fresh temporary working directory and isolated native homes,
with no resumed conversation, inherited hooks, MCP servers, project instructions or room credentials.
Real subscription credentials stay in the trusted parent; the worker receives dummy credentials and
a private per-execution certificate. Agents can create and inspect files inside their own temporary
workspace.

The sanitized PATH includes the trusted Node runtime, including user-local installations. Npm CLI
launchers receive read access to their own installed package and resolved dependencies, plus required
Node library files. The enclosing installation prefix, unrelated packages and native session homes
remain outside that grant.

The tested backend is macOS Seatbelt. Unsupported platforms or a failed sandbox probe disable starts;
there is no fallback to a shared or merely read-only workspace. A private TLS-terminating provider
gateway permits generation and the native CLI's required model/routing metadata. It uses explicit
method, path and payload schemas, refuses stored conversation/file references and hosted tools, and
injects authentication only when forwarding an allowed request. Room APIs, other local services,
account histories, arbitrary hosts and private DNS addresses are inaccessible. The model provider
necessarily receives that participant's prompt and output through the user's existing subscription.
Certificates are trusted only by the temporary CLI; nothing is installed in the system trust store.

On a provider authentication rejection, the trusted parent can ask the native CLI to refresh its
credentials and retry the request once. Same-account refreshes are coalesced and bounded; cancelling
the last waiting worker stops the helper. Codex uses its account API without starting a model turn.
Claude uses a fixed, tool-free health turn because its CLI has no refresh-only command. No task data
is sent to that helper. If the native client cannot refresh, reconnect with `claude auth login` or
`codex login`; a caller-supplied static OAuth token must be replaced by its owner.

The parent service keeps sealed submissions outside worker sandboxes. Partial text, files and tool
traces never enter the room event log, stream or native session. A complete validated round is revealed
atomically. A failed or stopped round stays sealed, including when another member already finished.
Every later phase receives only the specific revealed material its role needs. API inspection and
control are available only to the human, including paired devices; room agent keys are refused.

This boundary protects workflow workers from one another. It is not a security boundary against the
human operating the host or unrelated unrestricted processes running as that user.

## Budgets and artifacts

The common budget is an enforced deadline per submission, a maximum returned-text size and a bounded
number of repair attempts. These limits are equal across participants; they are not a promise of
equal token usage or subscription cost.

Up to 20 explicitly selected UTF-8 input files totaling 200 KB can be frozen as shared materials.
Paths escaping the workspace, internal `.git` / `.agoryx` paths and binary inputs are refused.
File-producing phases can author regular UTF-8 files in their private `artifacts/` directory. Bounded
file contents return with the artifact after the phase completes. Symlinks and binary exports are
refused. Structured review phases return validated JSON. Returned code is inspectable and exportable;
it is not automatically applied to the connected project or deployed.

The board previews returned HTML/SVG inside nested opaque-origin sandbox frames. The outer frame
loads an authenticated document with its own restrictive HTTP CSP; using only `srcdoc` beneath the
application would inherit its strict script policy and disable artifact interaction. The main
application policy stays unchanged. Local returned CSS, JavaScript and SVG dependencies can be
bundled into the preview. The trusted outer frame restricts the inner frame's navigation; resource
and form policies also block outside requests. Expanding the preview and switching to source keep
the same frame and preserve its interactive state. Named exports form the download bundle without
duplicating source echoed in the author's explanation. Technical prose preserves literal HTML tags
such as `<script>` instead of dropping the remainder of the explanation.
Download the named files or the full Markdown record to inspect the artifact elsewhere.
The record includes roles, models, budgets, frozen materials, revealed rounds and human decisions.
Chat handoff keeps the human decision, criterion findings and unresolved disagreements even when
the long narrative needs an excerpt. Free-form JSON artifacts and Council answers remain intact.

## Persistence and recovery

Runs and prior reports are stored under `<AGORYX_HOME>/workflows/<room>/workflow/` with private file
permissions. The shared room's JSONL schema and native sessions stay independent. Reloading the page
does not restart work. After a daemon interruption, the run is marked failed and can be retried from
its last fully revealed phase; unfinished batches run again. Stopping kills the worker process group,
terminates observed descendants and closes its gateway. A deliberately reparented process may evade
best-effort descendant tracking; it retains the kernel restrictions and loses its gateway, so this
does not grant access to another participant's work. Actions carry a run ID so stale pages cannot
select or cancel a replacement run. The room remains locked during bounded worker cleanup.
Automatic native-session and child-thread replies wait behind the private session. They can
resume after it finishes or its own Stop button releases the room. The room's general Stop
command also clears queued native work; shutdown never resumes it.
A corrupt private record blocks only its affected room and shows a recovery notice; other rooms
remain usable. The original file is preserved for recovery instead of silently resetting the session.

## HTTP contract

All routes use the room's existing human authentication and origin checks.
Browser and paired-device cookies are scoped to the daemon's persistent identity, so signing into
another localhost instance does not overwrite the first session. Existing legacy cookies remain
supported; an invalid scoped cookie never falls back to a legacy credential.

- `GET /api/rooms/:id/workflow` → `{workflow, capabilities: {isolation}}`.
- `GET /api/rooms/:id/workflow/history` → `{workflows}`; unfinished round texts remain sealed.
- `GET /api/rooms/:id/workflow/preview?runId=...&entryId=...` → a sandboxed HTML document for a
  completed entry in a revealed round of that exact current or historical run. This human-only
  response is never cached; unknown, sealed and nonvisual entries do not produce a preview.
- `GET /api/workflows` → `{workflows, unavailable}`. Human-only cross-room navigation index:
  IDs, mode, status/phase, original task, dates, room name, participant count and optional project.
  It excludes submission text, frozen context, reports and native traces. A corrupt room is reported
  separately while other rooms remain navigable. The client coalesces overlapping refreshes,
  retains the last good list on transient failure. The primary sidebar uses the unified room summaries.
- `POST /api/rooms/:id/workflow/start` → `{workflow}` (201). Body: `{mode, task, criteria,
  participantIds, roles?, budget?, contextPaths?, messageIds?, resultIds?}`. The daemon resolves model, provider and label from
  the room roster; clients cannot inject an executable or alternate model.
- `POST /api/rooms/:id/project` accepts `{projectKey: absoluteFolder | null}` to change logical
  membership while idle. `POST /api/rooms` accepts the same optional field independently of `mode`
  and `dir`. Reassigning a project never moves or grants write access to the execution folder.
- `POST /api/rooms/:id/workflow/action` accepts `{type: "retry", runId}`, `{type: "select", runId,
  entryIds, instruction?}`, or `{type: "override", runId, text}`.
- `POST /api/rooms/:id/workflow/stop` accepts `{runId}`.

Budget fields: `timeoutMs` (1,000–1,200,000), `maxOutputChars` (500–100,000), and `maxRounds` (1–5).
Defaults are 180,000 ms, 20,000 returned characters and two repair attempts.

## Validation and limits

The 0.1.0 implementation was validated on macOS with Node 26.8.1 and Codex CLI
0.160.0. Real protocol runs used Claude Code 2.1.288; native startup in the final
sandbox also passed with Claude Code 2.1.289.

- The complete guarded suite passed **1525/1525**, with no failures or skips, at
  concurrency two. The guard checked for test-created changes to real state,
  worktrees and branches. Core typechecking, core compilation and the UI production
  build passed.
- Boundary tests exercised the real Seatbelt sandbox: sibling files and volume
  aliases, peer terminals, process arguments/environment, task ports, provider
  conversation references, local services, forbidden network requests and bounded
  cancellation. Relocated Node/npm CLI fixtures initialized while unrelated
  packages and credentials remained inaccessible.
- Real subscription runs on October 4–5, 2026 completed all four protocols,
  including tournament selection and a human debate override. A later Verification
  completed with a Codex author and Claude reviewer, three passed criteria and
  explicit browser-related unknowns. These runs are provider smoke evidence,
  not proof that every future model response will satisfy its task.
- Browser checks covered setup/results, saved sessions, downloads, editable chat
  handoff, project membership, mode switching and Back navigation. They included
  desktop and 390 px layouts. Hostile artifact previews made no outside requests
  or successful navigation while local controls worked; preview state survived
  expansion and source toggles.
- Final integration checks covered the shared Work table, private-session request
  gates and Verification handoff with a large artifact. The handoff preserves the
  latest revealed artifact, the report, failed checks and unknowns; sealed repairs
  do not replace the visible result.

Browser and real-provider checks were performed during implementation. They are
not automatically rerun by the unit suite or by packaging a release. Signature,
notarization and packaged startup are separate checks described in
[Releasing](RELEASING.md). Other operating systems were not validated for hidden
execution; unsupported backends refuse starts.

Repeat the automated checks from the repository root:

```sh
npm run typecheck
npm run build:core
npm --prefix ui run build
node scripts/test-guard.mjs ./node_modules/.bin/tsx --test --test-concurrency=2 'tests/**/*.test.ts'
```

Protocol/API regressions are in `tests/agora/workflows.test.ts` and
`tests/agora/workflow-api.test.ts`; native boundary coverage is in
`tests/agora/workflow-executor.test.ts`; parent authentication replay/refresh coverage is in
`tests/agora/workflow-auth.test.ts`. UI regressions cover artifact framing, report handoff,
creation, routing and asynchronous state under `tests/ui/`. Preview authorization, reveal gates,
history and policy headers are covered by `tests/agora/workflow-preview.test.ts`; parallel daemon
cookies by `tests/agora/daemon-auth.test.ts`. Project membership and handoff boundaries have their
own conversation-projects and workflow-handoff suites.

Browser and native-provider smoke checks are separate from the deterministic automated suite.
Other operating systems were not validated; hidden phases fail closed outside the supported backend.
