import type { ReactNode } from "react";

import { SiteFooter } from "./SiteFooter";
import { SiteNav } from "./SiteNav";

/**
 * One marketing page: nav, the page's sections, footer. `ground` is the
 * page background the design gives it — ivory everywhere except /pricing,
 * which sits on white. `fill` stretches a short page so the footer meets
 * the bottom of the viewport.
 */
export function SitePage({
  ground = "ivory",
  fill = false,
  children,
}: {
  ground?: "ivory" | "white";
  fill?: boolean;
  children: ReactNode;
}) {
  const className = [
    "site-page",
    ground === "white" ? "site-page--white" : "",
    fill ? "site-page--fill" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className}>
      <SiteNav />
      {children}
      <SiteFooter />
    </div>
  );
}
