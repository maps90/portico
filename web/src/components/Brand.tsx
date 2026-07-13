interface Props {
  size?: "md" | "lg";
}

/**
 * The portico mark: a gateway — one arch, many things passing through it. Drawn
 * inline rather than imported, so it inherits the theme's foreground colour.
 */
export function Brand({ size = "md" }: Props): JSX.Element {
  const large = size === "lg";

  return (
    <div
      className={`flex items-center font-semibold tracking-tight ${
        large ? "gap-3 text-2xl" : "gap-2 text-[17px]"
      }`}
    >
      <span
        className={`grid shrink-0 place-items-center bg-fg text-bg ${
          large ? "h-10 w-10 rounded-[11px]" : "h-7 w-7 rounded-lg"
        }`}
        aria-hidden="true"
      >
        <svg
          width={large ? 22 : 16}
          height={large ? 22 : 16}
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
