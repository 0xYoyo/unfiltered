import type { ReactNode } from "react";

/** The design export's Badge: uppercase, 2px corners (readme "Corners"). */
export type BadgeTone = "neutral" | "accent" | "warning" | "outline";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return <span className={`unf-badge unf-badge--${tone}`}>{children}</span>;
}
