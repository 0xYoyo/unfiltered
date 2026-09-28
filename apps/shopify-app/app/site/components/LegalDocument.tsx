import type { ReactNode } from "react";

import { Badge } from "./Badge";
import { SitePage } from "./SitePage";

/**
 * The shared frame of /privacy and /terms: the draft badge, the title, the
 * standfirst, numbered sections, and the closing draft note.
 */
export function LegalDocument({
  title,
  standfirst,
  closing,
  children,
}: {
  title: string;
  standfirst: string;
  closing: ReactNode;
  children: ReactNode;
}) {
  return (
    <SitePage>
      <section className="site-legal">
        <div className="site-legal__inner">
          <div className="site-legal__status">
            <Badge tone="warning">Draft — legal review pending</Badge>
            <span className="site-legal__updated">
              Last updated: draft, unpublished
            </span>
          </div>
          <h1 className="site-legal__title">{title}</h1>
          <p className="site-legal__standfirst">{standfirst}</p>
          <div className="site-legal__sections">{children}</div>
          <p className="site-legal__closing">{closing}</p>
        </div>
      </section>
    </SitePage>
  );
}

export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h2 className="site-legal__heading">{heading}</h2>
      {children}
    </div>
  );
}
