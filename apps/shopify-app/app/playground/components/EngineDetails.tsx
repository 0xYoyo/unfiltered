import { SEARCH_STAGES } from "../../search/stages";
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
 *
 * The stage rows (YOY-114) say where the latency went: one row per pipeline
 * stage the search actually ran, in pipeline order, as `<stage> · <ms> ms`.
 * A stage that did not run has no row — an absent row is the evidence that
 * a classic search made no LLM call.
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
    // Which engine answered (YOY-165 AC-2).
    { label: strings.detailsEngine, value: response.details.engine },
    { label: strings.detailsRoute, value: response.route },
    { label: strings.detailsRouteReason, value: response.details.routeReason },
    // Which tier answered the intent call (YOY-116): "lite", "accuracy", or
    // none when no intent call ran — a classic route or a chip removal.
    {
      label: strings.detailsIntentTier,
      value: response.details.intentTier ?? strings.detailsNone,
    },
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
  const stageRows = SEARCH_STAGES.flatMap((stage) => {
    const ms = response.details.stages[stage];
    return ms === undefined ? [] : [{ stage, ms }];
  });

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
          <div className="detailsStagesRow">
            <span className="detailsStagesLabel">{strings.detailsStages}</span>
            <ul
              className="detailsStages"
              data-testid="playground-details-stages"
              dir="ltr"
            >
              {stageRows.map((row) => (
                <li key={row.stage}>
                  <bdi dir="ltr">
                    {row.stage} · {row.ms} ms
                  </bdi>
                </li>
              ))}
            </ul>
          </div>
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
