import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Component, type ErrorInfo, type ReactNode, useEffect } from "react";
import { Toaster, toast } from "sonner";
import { WorkspaceApp } from "../features/workspace/WorkspaceApp";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } });

class EmergencyErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error(error, info); }
  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="error-screen">
        <div className="drag error-drag" />
        <section>
          <span className="eyebrow">SuperThread could not start</span>
          <h1>Something went wrong.</h1>
          <p className="selectable">{this.state.error.message}</p>
          <button className="button primary no-drag" onClick={() => location.reload()}>Reload</button>
        </section>
      </main>
    );
  }
}

function BridgeEvents(): null {
  const client = useQueryClient();
  useEffect(() => window.desktop.onDataChanged(() => { void client.invalidateQueries({ queryKey: ["snapshot"] }); }), [client]);
  useEffect(() => {
    const handle = (event: PromiseRejectionEvent): void => { toast.error(event.reason?.message || "Unexpected error"); };
    window.addEventListener("unhandledrejection", handle);
    return () => window.removeEventListener("unhandledrejection", handle);
  }, []);
  return null;
}

export function AppKernel(): ReactNode {
  return (
    <EmergencyErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BridgeEvents />
        <WorkspaceApp />
        <Toaster theme="system" position="top-right" richColors closeButton />
      </QueryClientProvider>
    </EmergencyErrorBoundary>
  );
}
