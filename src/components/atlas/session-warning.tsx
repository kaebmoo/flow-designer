import { useEffect, useState } from "react";

/** Returns the browser-clock estimate used only to render the warning. Atlas remains authoritative. */
export function sessionWarningSeconds(
  expiresAt: string | undefined,
  now = Date.now(),
): number | null {
  if (!expiresAt) return null;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;
  return Math.ceil((expiresAtMs - now) / 1000);
}

export function SessionWarning({ expiresAt }: { expiresAt?: string }) {
  const [seconds, setSeconds] = useState(() => sessionWarningSeconds(expiresAt));

  useEffect(() => {
    const update = () => setSeconds(sessionWarningSeconds(expiresAt));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  if (seconds === null || seconds > 300) return null;

  const remaining =
    seconds > 0
      ? ` Atlas session expires in ${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? "" : "s"}.`
      : "";
  return (
    <div
      data-testid="session-warning"
      role="status"
      aria-live="polite"
      className="border-b border-warning/40 bg-warning/10 px-8 py-2 text-xs text-foreground"
    >
      {remaining || "Atlas session expiry has passed; the next Atlas request will verify it."} Do
      not rely on the browser clock alone; logout, expiry, or the five-session cap can end the
      session.
    </div>
  );
}
