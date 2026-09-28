import type { ReactNode } from "react";

/**
 * The design export's Button (readme "Hover", "Press", "Disabled"): primary
 * steps to `--accent-hover`, secondary inverts to solid ink, press is a 1px
 * downward translate, disabled is 40% opacity. Only the variants and sizes
 * the site pages use are carried over.
 *
 * With `href` it renders an anchor wearing the button's skin — the export
 * wrapped a `<button>` in an `<a>`, which is not valid HTML.
 */
export type ButtonVariant = "primary" | "secondary";
export type ButtonSize = "sm" | "md" | "lg";

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  href,
  disabled,
  onClick,
  children,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  href?: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const className = [
    "unf-btn",
    `unf-btn--${variant}`,
    `unf-btn--${size}`,
    block ? "unf-btn--block" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (href !== undefined) {
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
