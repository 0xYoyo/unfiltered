/**
 * The page's single status surface (YOY-92 AC-7): loading, empty, and
 * request failure are all one quiet sentence under the bar. No spinner, no
 * error box, no error language (F-6, X-4, X-5, W-8).
 *
 * A failed request is the one status that changes ink — `--text-critical`,
 * a plain sentence in the page's own oxblood, never a red panel (DESIGN §2
 * States). The words still invite a retry rather than reporting an error.
 *
 * It renders even when empty so the grid below never moves when a status
 * appears (F-8) — the reserved height lives in the stylesheet.
 */
export function StatusLine({
  text,
  failed = false,
}: {
  text: string | null;
  failed?: boolean;
}) {
  return (
    <p
      className={failed ? "statusLine statusLineFailed" : "statusLine"}
      role="status"
      data-testid="playground-status"
      data-failed={failed ? "true" : undefined}
    >
      {text ?? ""}
    </p>
  );
}
