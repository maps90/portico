import { Plug } from "lucide-react";
import { siJira, siGoogledrive, siGithub, type SimpleIcon } from "simple-icons";

/**
 * Official brand marks (via simple-icons) rather than hand-copied approximations,
 * tinted with each vendor's own colour so a service is recognisable before you read
 * the row. Anything not in the map falls back to a neutral icon, so the registry can
 * grow without the UI breaking.
 *
 * The mark is drawn in `currentColor` and the brand colour is applied as `color`, so
 * a near-black mark like GitHub's can be lifted to the foreground colour in dark mode
 * (see `[data-brand="github"]` in styles.css) instead of disappearing into the card.
 */
const BRANDS: Record<string, SimpleIcon> = {
  atlassian: siJira,
  "google-drive": siGoogledrive,
  github: siGithub,
};

export function ServiceLogo({ id }: { id: string }): JSX.Element {
  const brand = BRANDS[id];

  return (
    <span
      className="service-logo"
      data-brand={brand ? id : undefined}
      style={brand ? { color: `#${brand.hex}` } : undefined}
      aria-hidden="true"
    >
      {brand ? (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d={brand.path} />
        </svg>
      ) : (
        <Plug size={18} strokeWidth={1.75} />
      )}
    </span>
  );
}
