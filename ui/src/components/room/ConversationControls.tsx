import { useState } from "react";
import { toast } from "sonner";
import { ModePicker, ProjectPicker } from "@/components/ConversationOptions";
import { api, roomPath } from "@/lib/api";
import { useStore } from "@/lib/store";
import { activeWorkflow, useWorkflow } from "@/lib/workflow-state";
import { isProtocolMode, nativeRoomMode, type WorkMode } from "@/lib/workflow";

export function ConversationControls() {
  const room = useStore((s) => s.snap?.state),
    mode = useStore((s) => s.workspaceMode);
  const summary = useStore((s) =>
    s.rooms.find((r) => r.id === s.snap?.state.id),
  );
  const privateActive = useWorkflow(
    (s) => s.roomId === room?.id && activeWorkflow(s.run),
  );
  const [busy, setBusy] = useState(false);
  if (!room) return null;
  const working =
    busy || privateActive || room.runs.at(-1)?.status === "active";
  const membership =
    room.projectKey !== undefined
      ? room.projectKey
      : (summary?.projectKey ??
        (room.mode !== "chat"
          ? (room.worktree?.source ?? room.workspace)
          : null));
  const chooseMode = (next: WorkMode) => {
    const s = useStore.getState();
    if (next === mode) return;
    if (isProtocolMode(next)) s.openWorkflow(room.id, next, "new");
    else if (next === nativeRoomMode(room)) s.setView("chat");
    else s.openDialog({ kind: "mode" });
  };
  const chooseProject = async (projectKey: string | null) => {
    if (working || membership === projectKey) return;
    setBusy(true);
    try {
      await api("POST", roomPath(room.id, "/project"), { projectKey });
      await useStore.getState().openRoom(room.id, true);
      await useStore.getState().loadRooms();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-background px-4 py-2"
      aria-label="Conversation options"
    >
      <ModePicker mode={mode} onSelect={chooseMode} disabled={working} />
      <ProjectPicker
        value={membership}
        name={summary?.projectName}
        onSelect={(key) => void chooseProject(key)}
        disabled={working || Boolean(room.parent)}
      />
      <span className="ml-auto hidden text-meta text-faint @min-[40rem]/roomhead:block">
        {working
          ? "Finish or stop the current work to change modes"
          : "One conversation · different ways to work"}
      </span>
    </div>
  );
}
