import { PanelLeftIcon, SearchIcon } from "lucide-react";
import { Wordmark } from "@/components/brand/Mark";
import { useStore } from "@/lib/store";

export function WorkspaceBar() {
  return (
    <header className="workspace-bar workspace-bar-left">
      <div className="workspace-brand">
        <button
          type="button"
          aria-label="Toggle sidebar"
          className="chrome-button"
          onClick={() => {
            const s = useStore.getState();
            if (innerWidth >= 1024) s.setNavCollapsed(!s.navCollapsed);
            else s.setNavOpen(!s.navOpen);
          }}
        >
          <PanelLeftIcon size={17} />
        </button>
        <Wordmark className="text-[20px]" />
      </div>
      <div className="flex-1" />
      <div className="workspace-tools">
        <button
          type="button"
          className="chrome-button"
          aria-label="Search everything"
          onClick={() => useStore.getState().setPaletteOpen(true)}
        >
          <SearchIcon size={17} />
        </button>
      </div>
    </header>
  );
}
