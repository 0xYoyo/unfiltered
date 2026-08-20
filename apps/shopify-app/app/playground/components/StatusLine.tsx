/**
 * The page's single status surface (YOY-92 AC-7): loading, empty, and
 * request failure are all one quiet muted sentence under the bar. No
 * spinner, no error colour, no error language (F-6, X-4, X-5, W-8).
 *
 * It renders even when empty so the grid below never moves when a status
 * appears (F-8) — the reserved height lives in the stylesheet.
 */
export function StatusLine({ text }: { text: string | null }) {
  return (
    <p className="statusLine" role="status" data-testid="playground-status">
      {text ?? ""}
    </p>
  );
}
