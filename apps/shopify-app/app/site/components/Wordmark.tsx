/**
 * The wordmark as text in the display face (YOY-156 AC-2): the name is a
 * text node, so it renders in the site's own Frank Ruhl Libre rather than
 * an SVG whose `<text>` fell back to a system serif. The circled-x mark
 * beside it is drawn inline and hidden from assistive tech — the name
 * already says it.
 */
export function Wordmark({ className }: { className: string }) {
  return (
    <span className={`site-wordmark ${className}`}>
      <span className="site-wordmark__name">Unfiltered</span>
      <svg
        className="site-wordmark__mark"
        viewBox="0 0 48 48"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2" y="2" width="44" height="44" rx="22" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="M17 17 L31 31 M31 17 L17 31"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
