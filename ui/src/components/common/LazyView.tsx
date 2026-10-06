import { Component, type ReactNode, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/common/states";

/**
 * A view loaded with its route. When its chunk does not load (the page outlived an update of Agoryx, the daemon went
 * away), this says so in place, with a reload, instead of React unmounting the whole page.
 */
class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="grid flex-1 place-items-center p-6">
        <ErrorNote className="flex max-w-md flex-col items-start gap-3">
          This part of the page did not load. Agoryx may have been updated since the page opened.
          <Button size="sm" variant="outline" onClick={() => location.reload()}>
            Reload the page
          </Button>
        </ErrorNote>
      </div>
    );
  }
}

export function LazyView({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return (
    <LoadBoundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LoadBoundary>
  );
}
