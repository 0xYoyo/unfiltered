import type { PlaygroundSearchResponse } from "../api.server";
import type { PlaygroundStrings } from "../strings";

/**
 * "How it understood you" (YOY-93 AC-5, P-4).
 *
 * Engine details are opt-in and off by default: the page's job is to look
 * like a storefront, and route/latency/intent are proof a sceptic asks for,
 * not decoration a shopper needs. The toggle's state rides `?details=1` so
 * the opened panel survives a reload and can be shared as a link.
 *
 * When off the panel is not rendered at all — collapsed means gone, not
 * hidden with its space reserved. Muted text throughout and no accent: this
 * is evidence, not emphasis. The intent JSON is the one place monospace is
 * permitted on the page (DESIGN §2).
 *
 * The control is an anchor whose click is handled in JS: navigating to
 * `?details=1` would reload the page and throw away the very answer the
 * panel is meant to explain — the held intent is memory-only, so the
 * visitor would be asked to search again just to see how the last search
 * was understood. The `href` stays correct so the toggle still works
 * without JavaScript and can be opened in a new tab.
 */
export function EngineDetails({
  response,
  strings,
  open,
  toggleHref,
  onToggle,
}: {
  response: PlaygroundSearchResponse;
  strings: PlaygroundStrings;
  open: boolean;
  toggleHref: string;
  onToggle: () => void;
}) {
  const rows: { label: string; value: string }[] = [
    { label: strings.detailsRoute, value: response.route },
    { label: strings.detailsRouteReason, value: response.details.routeReason },
    { label: strings.detailsLatency, value: `${response.details.latencyMs} ms` },
    {
      label: strings.detailsDegraded,
      value: response.degraded ? strings.detailsYes : strings.detailsNo,
    },
    {
      label: strings.detailsLimited,
      value: response.details.limited ?? strings.detailsNone,
    },
  ];

  return (
    <div className="details">
      <a
        className="detailsToggle"
        href={toggleHref}
        aria-expanded={open}
        data-testid="playground-details-toggle"
        onClick={(event) => {
          // Modified clicks keep their browser meaning (new tab, download).
          if (
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            event.button !== 0
          ) {
            return;
          }
          event.preventDefault();
          onToggle();
        }}
      >
        {strings.engineDetailsToggle}
      </a>

      {!open ? null : (
        <div className="detailsPanel" data-engine-details data-testid="playground-details-panel">
          <dl className="detailsRows">
            {rows.map((row) => (
              <div className="detailsRow" key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  <bdi dir="ltr">{row.value}</bdi>
                </dd>
              </div>
            ))}
          </dl>
          <div className="detailsIntentRow">
            <span className="detailsIntentLabel">{strings.detailsIntent}</span>
            <pre className="detailsIntent" data-testid="playground-details-intent" dir="ltr">
              <code>{JSON.stringify(response.intent, null, 2)}</code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
