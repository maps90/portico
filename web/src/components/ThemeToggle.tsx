import { useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

const STORAGE_KEY = "portico-theme";

/** The boot script in index.html already resolved this before first paint. */
const currentTheme = (): Theme =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";

export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const target: Theme = theme === "dark" ? "light" : "dark";

  const toggle = () => {
    localStorage.setItem(STORAGE_KEY, target);
    document.documentElement.dataset.theme = target;
    setTheme(target);
  };

  return (
    <button
      type="button"
      className="btn btn-quiet btn-icon"
      onClick={toggle}
      aria-label={`Switch to ${target} theme`}
      title={`Switch to ${target} theme`}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
