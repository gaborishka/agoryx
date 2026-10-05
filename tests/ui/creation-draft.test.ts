import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../ui/src/lib/api.js";
import {
  CreationDrafts,
  creationDraftKey,
  creationProjectInput,
} from "../../ui/src/lib/creation-draft.js";

const storage = () => {
  const data = new Map<string, string>();
  return {
    get: (key: string) => data.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) data.delete(key);
      else data.set(key, value);
    },
  };
};
const codex = {
  id: "c",
  kind: "codex" as const,
  label: "Codex",
  model: "chosen-codex",
};
const claude = { id: "a", kind: "claude" as const, label: "Claude" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

test("brief and human-selected models survive mode changes and reload; each mode keeps its own rules", () => {
  const saved = storage();
  const drafts = new CreationDrafts(saved);
  const key = creationDraftKey();
  drafts.update(key, { brief: "Compare these designs" });
  drafts.setSeats(key, [codex, claude]);
  drafts.updateWorkflow(key, "verification", {
    criteria: "Fits mobile",
    roles: { c: "author", a: "reviewer" },
    seconds: 300,
  });
  drafts.updateWorkflow(key, "debate", {
    criteria: "States a decisive test",
    roles: { c: "pro", a: "con" },
    rounds: 3,
  });
  const reopened = new CreationDrafts(saved);
  assert.equal(reopened.read(key).brief, "Compare these designs");
  assert.equal(reopened.read(key).seats![0]!.model, "chosen-codex");
  assert.equal(reopened.workflow(key, "verification").criteria, "Fits mobile");
  assert.equal(reopened.workflow(key, "verification").seconds, 300);
  assert.equal(reopened.workflow(key, "debate").rounds, 3);
  assert.equal(reopened.workflow(key, "debate").roles.c, "pro");
});

test("a late roster reply does not overwrite human seat edits, including an intentionally empty selection", () => {
  const saved = storage();
  const drafts = new CreationDrafts(saved);
  const key = creationDraftKey();
  drafts.setSeats(key, [codex]);
  drafts.seedSeats(key, [claude, { ...codex, model: "default" }]);
  assert.deepEqual(drafts.read(key).seats, [codex]);
  drafts.setSeats(key, []);
  const reopened = new CreationDrafts(saved);
  reopened.seedSeats(key, [claude, codex]);
  assert.deepEqual(reopened.read(key).seats, []);
});

test("project context remains separate from the collaboration method and from another project's draft", () => {
  const drafts = new CreationDrafts(storage());
  const key = creationDraftKey("/project one");
  assert.equal(drafts.read(key, "/project one").project, true);
  assert.equal(drafts.read(key).folder, "/project one");
  drafts.updateWorkflow(key, "council", { criteria: "Clear" });
  assert.equal(drafts.read(key).folder, "/project one");
  assert.equal(drafts.read(creationDraftKey()).project, false);
  assert.notEqual(key, creationDraftKey("/project two"));
});

test("parallel submissions share one room creation and a remount reuses its durable result", async () => {
  const saved = storage();
  const drafts = new CreationDrafts(saved);
  const key = creationDraftKey();
  const response = deferred<string>();
  let calls = 0;
  const create = () => {
    calls++;
    return response.promise;
  };
  const first = drafts.prepare(key, "council", create);
  const second = drafts.prepare(key, "council", create);
  await Promise.resolve();
  assert.equal(calls, 1);
  response.resolve("created-room");
  assert.equal((await first).roomId, "created-room");
  assert.equal((await second).roomId, "created-room");
  const reopened = new CreationDrafts(saved);
  const recovered = await reopened.prepare(key, "council", async () => {
    calls++;
    return "duplicate";
  });
  assert.equal(recovered.roomId, "created-room");
  assert.equal(calls, 1);
});

test("an unresolved creation survives reload and prevents blind duplicate retries; a definite rejection can retry", async () => {
  const saved = storage();
  const key = creationDraftKey();
  const drafts = new CreationDrafts(saved);
  await assert.rejects(
    drafts.prepare(key, "chat", async () => {
      throw new TypeError("connection lost after POST");
    }),
  );
  const reopened = new CreationDrafts(saved);
  let calls = 0;
  await assert.rejects(
    reopened.prepare(key, "chat", async () => {
      calls++;
      return "duplicate";
    }),
    /no confirmed result/,
  );
  assert.equal(calls, 0);
  reopened.release(key); // The human checked the room list and explicitly chose another room.
  await assert.rejects(
    reopened.prepare(key, "chat", async () => {
      throw new ApiError("invalid roster", 400, {});
    }),
  );
  assert.equal(reopened.read(key).preparing, undefined);
  assert.equal(
    (await reopened.prepare(key, "chat", async () => "valid-room")).roomId,
    "valid-room",
  );
});

test("late native completion and later recovery keep a newer brief instead of clearing it", async () => {
  const drafts = new CreationDrafts(storage());
  const key = creationDraftKey();
  drafts.update(key, { brief: "Submitted brief" });
  const original = drafts.read(key).revision;
  const response = deferred<string>();
  const creating = drafts.prepare(key, "chat", () => response.promise);
  drafts.update(key, { brief: "Newer unsent brief" });
  response.resolve("room-A");
  const prepared = await creating;
  assert.equal(prepared.revision, original);
  drafts.finish(key, prepared.revision, prepared.roomId);
  assert.equal(drafts.read(key).brief, "Newer unsent brief");
  assert.equal(drafts.read(key).prepared, undefined);
});

test("workflow preparation adopts all setup into its created room; failed launch/reload retains recovery", async () => {
  const saved = storage();
  const drafts = new CreationDrafts(saved);
  const key = creationDraftKey("/repo");
  drafts.read(key, "/repo");
  drafts.update(key, { brief: "Review the actual project" });
  drafts.setSeats(key, [codex, claude]);
  drafts.updateWorkflow(key, "verification", {
    criteria: "Builds",
    roles: { c: "author", a: "reviewer" },
    seconds: 600,
    chars: 32000,
    rounds: 4,
  });
  const source = drafts.read(key);
  const created = await drafts.prepareWorkflow(
    key,
    "verification",
    source,
    async () => "room-work",
  );
  assert.equal(created.roomId, "room-work");
  const reopened = new CreationDrafts(saved);
  const setup = reopened.workflow(key, "verification", "room-work");
  assert.equal(setup.task, source.brief);
  assert.equal(setup.criteria, "Builds");
  assert.deepEqual(setup.selected, ["c", "a"]);
  assert.deepEqual([setup.seconds, setup.chars, setup.rounds], [600, 32000, 4]);
  assert.equal(reopened.read(key).prepared!.roomId, "room-work");
  reopened.updateWorkflow(
    key,
    "verification",
    { contextPaths: ["README.md"] },
    "room-work",
  );
  assert.deepEqual(
    new CreationDrafts(saved).workflow(key, "verification", "room-work")
      .contextPaths,
    ["README.md"],
  );
  reopened.finish(key, setup.origin!.revision, "room-work");
  assert.equal(reopened.read(key).brief, "");
  assert.equal(reopened.read(key).prepared, undefined);
});

test("a restored worktree choice blocks submission until its own folder and selected base are confirmed", () => {
  const saved = storage();
  const key = creationDraftKey("/selected-repo");
  const beforeReload = new CreationDrafts(saved);
  beforeReload.read(key, "/selected-repo");
  beforeReload.update(key, { worktree: true, base: "release" });
  const restored = new CreationDrafts(saved).read(key);
  // Pending/failed checks and a late reply for the previous folder must never
  // turn the requested worktree into direct execution in the source folder.
  assert.throws(() => creationProjectInput(restored, null), /not confirmed/);
  assert.throws(
    () =>
      creationProjectInput(restored, {
        folder: "/previous-repo",
        git: { head: "abc", branches: ["release"] },
      }),
    /not confirmed/,
  );
  assert.throws(
    () =>
      creationProjectInput(restored, { folder: restored.folder!, git: null }),
    /no confirmed Git commit/,
  );
  assert.throws(
    () =>
      creationProjectInput(restored, {
        folder: restored.folder!,
        git: { head: null, branches: ["release"] },
      }),
    /no confirmed Git commit/,
  );
  assert.throws(
    () =>
      creationProjectInput(restored, {
        folder: restored.folder!,
        git: { head: "abc", branches: ["main"] },
      }),
    /base.*unavailable/,
  );
  assert.deepEqual(
    creationProjectInput(restored, {
      folder: restored.folder!,
      git: { head: "abc", branches: ["main", "release"] },
    }),
    { mode: "work", projectKey: "/selected-repo", dir: "/selected-repo", worktree: true, base: "release" },
  );
});

test("only an explicit direct-folder choice removes worktree from the request; default base retains worktree", () => {
  const draft = { project: true, folder: "/repo", worktree: true, base: null };
  assert.deepEqual(
    creationProjectInput(draft, {
      folder: "/repo",
      git: { head: "abc", branches: [] },
    }),
    { mode: "work", dir: "/repo", worktree: true },
  );
  assert.deepEqual(creationProjectInput({ ...draft, worktree: false }, null), {
    mode: "work",
    dir: "/repo",
  });
  assert.deepEqual(creationProjectInput({ ...draft, project: false }, null), {
    mode: "chat",
  });
  assert.deepEqual(
    creationProjectInput({ ...draft, folder: null, worktree: false }, null),
    { mode: "work" },
    "New folder is a supported workspace choice",
  );
  assert.throws(
    () => creationProjectInput({ ...draft, folder: null }, null),
    /existing Git project/,
    "a remembered worktree needs an explicit change before creating a new folder",
  );
});

test("prepared workflow recovery is never published before its complete setup is saved", async () => {
  const saved = storage();
  const drafts = new CreationDrafts(saved);
  const key = creationDraftKey();
  drafts.update(key, { brief: "Preserve this request" });
  drafts.updateWorkflow(key, "council", {
    criteria: "Keep disagreements",
    chars: 32000,
  });
  const source = drafts.read(key);
  let recoveredDuringPublish = false;
  const unsubscribe = drafts.subscribe(() => {
    if (!drafts.read(key).prepared) return;
    const reopened = new CreationDrafts(saved);
    const roomId = reopened.read(key).prepared!.roomId;
    const setup = reopened.workflow(key, "council", roomId);
    assert.equal(setup.task, source.brief);
    assert.equal(setup.criteria, "Keep disagreements");
    assert.equal(setup.chars, 32000);
    recoveredDuringPublish = true;
  });
  await drafts.prepareWorkflow(
    key,
    "council",
    source,
    async () => "recoverable-room",
  );
  unsubscribe();
  assert.equal(recoveredDuringPublish, true);
});


test("explicit Chat and Work override remembered project context without changing it", () => {
  const draft = { project: false, folder: "/repo", worktree: false, base: null };
  assert.deepEqual(creationProjectInput(draft, null, "work"), {mode:"work",dir:"/repo"});
  assert.deepEqual(creationProjectInput({...draft,folder:null},null,"work"),{mode:"work"});
  assert.deepEqual(creationProjectInput({...draft,project:true,worktree:true},null,"chat"),{mode:"chat"});
  assert.throws(() => creationProjectInput({...draft,worktree:true},null,"work"), /not confirmed/);
  assert.equal(draft.project,false);
  assert.deepEqual(creationProjectInput(draft,null,"council"),{mode:"chat"});
  assert.deepEqual(creationProjectInput({...draft,project:true},null,"council"),{mode:"work",dir:"/repo"});
});

test("Chat carries project membership without connecting its folder; Work can remain standalone", () => {
  const key = creationDraftKey("/project"), drafts = new CreationDrafts(storage());
  const draft = drafts.read(key, "/project");
  assert.deepEqual(creationProjectInput(draft, null, "chat"), { mode: "chat", projectKey: "/project" });
  drafts.update(key, { projectKey: null, project: false, folder: null, worktree: false });
  assert.deepEqual(creationProjectInput(drafts.read(key), null, "work"), { mode: "work", projectKey: null });
  assert.equal(drafts.read(key).projectKey, null);
});
