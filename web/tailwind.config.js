/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],

  // A boot script stamps data-theme on <html> before first paint, so the attribute
  // is always present and `dark:` works without a second prefers-color-scheme path.
  darkMode: ["selector", '[data-theme="dark"]'],

  theme: {
    extend: {
      /**
       * Colours resolve to CSS variables rather than literal hexes. Switching theme
       * then flips the variables in one place, and every utility (bg-surface,
       * text-fg-muted, …) follows — no `dark:` twin for each class.
       */
      colors: {
        bg: "var(--bg)",
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
        },
        fg: {
          DEFAULT: "var(--fg)",
          muted: "var(--fg-muted)",
          subtle: "var(--fg-subtle)",
        },
        line: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          fg: "var(--accent-fg)",
          soft: "var(--accent-soft)",
          line: "var(--accent-line)",
        },
        warn: {
          DEFAULT: "var(--warn)",
          soft: "var(--warn-soft)",
          line: "var(--warn-line)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          soft: "var(--danger-soft)",
        },
        ring: "var(--ring)",
      },
      fontFamily: {
        sans: ["Inter Variable", "Inter", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: {
        card: "14px",
      },
      boxShadow: {
        card: "var(--shadow-sm)",
        float: "var(--shadow-md)",
      },
      keyframes: {
        reveal: {
          from: { opacity: "0", transform: "translateY(-4px)" },
        },
        shimmer: {
          from: { backgroundPosition: "100% 50%" },
          to: { backgroundPosition: "0 50%" },
        },
      },
      animation: {
        reveal: "reveal 260ms cubic-bezier(0.2, 0, 0.13, 1)",
        shimmer: "shimmer 1.4s ease-in-out infinite",
      },
    },
  },

  plugins: [],
};
