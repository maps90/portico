import { Plug } from "lucide-react";
import { siJira, siGoogledrive, siGithub, type SimpleIcon } from "simple-icons";

/**
 * Official brand marks (via simple-icons) rather than hand-copied approximations,
 * tinted with each vendor's own colour so a service is recognisable before you read
 * the row. Anything not in the map falls back to a neutral icon, so the registry can
 * grow without the UI breaking.
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
      className={
        "grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-line bg-surface-2 " +
        // GitHub's brand black would sink into the dark surface, so lift it to the
        // foreground there. The mark draws in currentColor to make that possible.
        (id === "github" ? "dark:!text-fg" : "")
      }
      style={brand ? { color: `#${brand.hex}` } : undefined}
      aria-hidden="true"
    >
      {brand ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]">
          <path d={brand.path} />
        </svg>
      ) : (
        <Plug size={18} strokeWidth={1.75} />
      )}
    </span>
  );
}
