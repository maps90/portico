import { Check } from "lucide-react";
import { Brand } from "./Brand.js";
import { ThemeToggle } from "./ThemeToggle.js";

const POINTS = [
  "One bearer token reaches every service you link",
  "Vendor tokens stay encrypted on the server, never in your client",
  "Link or unlink a service without reissuing anything",
];

/** Signed-out state. One way in, one thing to do. */
export function SignIn(): JSX.Element {
  return (
    <main className="signin">
      <div style={{ position: "fixed", top: 16, right: 16 }}>
        <ThemeToggle />
      </div>

      <Brand size="lg" />

      <p className="signin-copy">
        A single MCP gateway to Jira, Drive, GitHub and everything else you link.
      </p>

      <ul className="signin-points">
        {POINTS.map((point) => (
          <li key={point}>
            <Check size={15} strokeWidth={2.5} aria-hidden="true" />
            {point}
          </li>
        ))}
      </ul>

      <a className="btn btn-google" href="/login">
        <GoogleMark />
        Sign in with Google
      </a>

      <p className="signin-foot">You'll be redirected to Google to authorize.</p>
    </main>
  );
}

/** Google's mark, in its official four colours — required by their branding rules. */
function GoogleMark(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
