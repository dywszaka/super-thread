import { AlertTriangle, Clock } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AppSettings, WorkThread } from "@/shared/domain";
import { workThreadAge } from "@/shared/work-thread-age";

const AgeContext = createContext<{ settings: AppSettings; now: number } | null>(null);

export function WorkThreadAgeProvider({ settings, children }: { settings: AppSettings; children: ReactNode }): ReactNode {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = (): void => setNow(Date.now());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  return <AgeContext.Provider value={{ settings, now }}>{children}</AgeContext.Provider>;
}

export function WorkThreadAge({ thread, compact = false, details = false, visibility = "all" }: { thread: WorkThread; compact?: boolean; details?: boolean; visibility?: "all" | "normal" | "reminders" }): ReactNode {
  const context = useContext(AgeContext);
  const age = context && workThreadAge(thread, context.settings, context.now);
  if (!age) return null;
  if (visibility === "normal" && age.level !== "normal" || visibility === "reminders" && age.level === "normal") return null;
  const label = age.days === 0 ? "Less than 1 day old" : `${age.days} ${age.days === 1 ? "day" : "days"} old`;
  const advice = age.level === "strong" ? "Consider wrapping up or splitting the remaining work into smaller work threads. Review and merge completed changes."
    : age.level === "reminder" ? "Check your completion criteria. Review and merge finished changes, then wrap up or split the remaining work." : "";
  const Icon = age.level === "strong" ? AlertTriangle : Clock;
  const tooltip = `Created ${new Date(thread.createdAt).toLocaleString()} · ${label}${advice ? `. ${advice}` : ""}`;
  return <span className={`thread-age-display ${details ? "with-details" : ""}`}>
    <span className={`thread-age ${age.level} ${compact ? "compact" : ""}`} title={tooltip} aria-label={tooltip}>
      {!compact && <Icon size={12} aria-hidden="true" />}{compact && age.level !== "normal" && <span aria-hidden="true">{age.level === "strong" ? "!" : "·"}</span>}
      {compact ? age.days === 0 ? "<1d" : `${age.days}d` : label}
    </span>
    {details && advice && <span className={`thread-age-advice ${age.level}`}>{advice}</span>}
  </span>;
}
