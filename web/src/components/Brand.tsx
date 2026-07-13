interface Props {
  size?: "md" | "lg";
}

/**
 * The portico mark: a gateway — one arch, many things passing through it. Drawn
 * rather than imported so it inherits the theme's foreground colour.
 */
export function Brand({ size = "md" }: Props): JSX.Element {
  return (
    <div className={`brand ${size === "lg" ? "brand-lg" : ""}`}>
      <span className="brand-mark" aria-hidden="true">
        <svg
          width={size === "lg" ? 22 : 16}
          height={size === "lg" ? 22 : 16}
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M4 17V8a6 6 0 0 1 12 0v9" />
          <path d="M10 17v-5" />
          <path d="M2 17h16" />
        </svg>
      </span>
      <span>portico</span>
    </div>
  );
}
