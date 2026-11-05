import { describe, it, expect } from "vitest";
import {
  DEFAULT_SLACK_POLICY,
  PostRateLimiter,
  checkChannelAudience,
  checkReaction,
  checkReply,
  isDirectMessage,
  normalizeReaction,
  scanText,
  type SlackPolicyConfig,
} from "./slack-policy.js";

const cfg = (over: Partial<SlackPolicyConfig> = {}): SlackPolicyConfig => ({ ...DEFAULT_SLACK_POLICY, ...over });
const TS = "1730800000.123456";
const rule = (v: ReturnType<typeof checkReply>) => (v.allowed ? null : v.rule);

describe("scanText", () => {
  // Each rule: a string it must catch, and a near-miss it must leave alone, so a
  // rule that matches everything (or nothing) fails here rather than in Slack.
  const cases: Array<[string, string, string]> = [
    ["slack_token", "here: xo" + "xb-1234567890-abcdefghij", "the xox prefix alone is fine"],
    ["slack_token", "xo" + "xp-11111111-22222222-abc", "xoxz-123 is not a slack token type"],
    ["private_key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE...", "-----BEGIN CERTIFICATE-----"],
    ["private_key", "-----BEGIN OPENSSH PRIVATE KEY-----", "we rotated the private key yesterday"],
    ["jwt", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk", "eyJ on its own"],
    ["aws_access_key", "AKIAIOSFODNN7EXAMPLE", "AKIA is the prefix"],
    ["github_token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_short"],
    ["github_token", "gho_abcdefghijklmnopqrstuvwxyz0123", "the gh cli is installed"],
    ["github_token", "github_pat_11ABCDEFG0123456789_abcdefghij", "github_pat_ is a prefix"],
    ["connection_string", "postgres://portico:hunter2@db.internal:5432/x", "https://example.com/path"],
    ["connection_string", "redis://default:pw@cache:6379", "mailto:someone@okadoc.com"],
    ["credential_assignment", "password: hunter2", "please reset your password"],
    ["credential_assignment", "client_secret=abc123", "the secret sauce"],
    ["credential_assignment", "API_KEY = 'sk-live-1'", "api keys are in the vault"],
    ["credential_assignment", "wifi psk: correcthorse", "psk auth is enabled"],
    ["credential_assignment", "access_token=abc", "token expired, reconnect"],
    ["private_ip", "db is at 10.1.2.3", "version 10.1.2"],
    ["private_ip", "try 172.16.0.5", "172.32.0.5 is public"],
    ["private_ip", "172.31.255.255 too", "172.15.0.1 is public"],
    ["private_ip", "router 192.168.1.1", "192.169.1.1 is public"],
    ["private_ip", "cgnat 100.64.0.1", "100.128.0.1 is public"],
    ["private_ip", "subnet 10.0.0.0/8", "8.8.8.8 is public"],
    ["mass_mention", "hey <!here> look", "hey <@U123> look"],
    ["mass_mention", "<!channel|channel> deploy done", "the channel is quiet"],
    ["mass_mention", "<!everyone>", "everyone knows"],
    ["mass_mention", "@here please", "mail ops@here.example? no -- user@channel.com"],
    ["mass_mention", "ping @channel", "a@channel"],
  ];
  for (const [r, bad, fine] of cases) {
    it(`${r}: catches "${bad.slice(0, 24)}…" but not "${fine.slice(0, 24)}…"`, () => {
      expect(scanText(bad)?.rule).toBe(r);
      expect(scanText(fine)).toBeNull();
    });
  }

  it("never echoes the matched secret in its reason", () => {
    const hit = scanText("token is xo" + "xb-1234567890-SECRETSECRET")!;
    expect(hit.reason).not.toContain("SECRETSECRET");
    expect(hit.reason).not.toContain("xo" + "xb-");
  });

  it("reports a recognisable token as itself, not as a generic assignment", () => {
    expect(scanText("SLACK_TOKEN=xo" + "xb-1234567890-abcdefghij")?.rule).toBe("slack_token");
  });

  it("passes ordinary replies", () => {
    expect(scanText("Thanks! I've opened OPS-123 and will update this thread by 5pm.")).toBeNull();
  });
});

describe("checkReply", () => {
  it("requires thread_ts outside a DM -- the bot never starts a top-level post", () => {
    expect(rule(checkReply({ channel: "C123", text: "hi" }, cfg()))).toBe("thread_required");
    expect(rule(checkReply({ channel: "G123", text: "hi" }, cfg()))).toBe("thread_required");
    expect(checkReply({ channel: "C123", threadTs: TS, text: "hi" }, cfg()).allowed).toBe(true);
  });

  it("lets a DM take a message without a thread", () => {
    expect(checkReply({ channel: "D123ABC", text: "hi" }, cfg()).allowed).toBe(true);
    expect(isDirectMessage("D123ABC")).toBe(true);
    expect(isDirectMessage("C123ABC")).toBe(false);
  });

  it("rejects a malformed thread_ts", () => {
    expect(rule(checkReply({ channel: "C1", threadTs: "yesterday", text: "hi" }, cfg()))).toBe("bad_thread_ts");
  });

  it("refuses a deny-listed channel, case-insensitively, even in a thread", () => {
    const c = cfg({ denyChannels: ["C0GENERAL"] });
    expect(rule(checkReply({ channel: "c0general", threadTs: TS, text: "hi" }, c))).toBe("channel_denied");
    expect(checkReply({ channel: "C0OTHER", threadTs: TS, text: "hi" }, c).allowed).toBe(true);
  });

  it("enforces the length limit", () => {
    const c = cfg({ maxMessageLength: 10 });
    expect(rule(checkReply({ channel: "D1", text: "x".repeat(11) }, c))).toBe("too_long");
    expect(checkReply({ channel: "D1", text: "x".repeat(10) }, c).allowed).toBe(true);
  });

  it("refuses empty text and a missing channel", () => {
    expect(rule(checkReply({ channel: "D1", text: "  " }, cfg()))).toBe("empty_text");
    expect(rule(checkReply({ channel: "", text: "hi" }, cfg()))).toBe("missing_channel");
  });

  it("runs the text scan and names the rule", () => {
    const v = checkReply({ channel: "C1", threadTs: TS, text: "use 192.168.0.10" }, cfg());
    expect(rule(v)).toBe("private_ip");
    expect(v.allowed ? "" : v.reason).not.toContain("192.168.0.10");
  });
});

describe("checkChannelAudience", () => {
  it("refuses Slack Connect and shared channels", () => {
    expect(checkChannelAudience({ isExtShared: true }).allowed).toBe(false);
    expect(checkChannelAudience({ isShared: true }).allowed).toBe(false);
    expect(checkChannelAudience({ isPendingExtShared: true }).allowed).toBe(false);
  });
  it("allows an internal channel", () => {
    expect(checkChannelAudience({ isExtShared: false, isShared: false }).allowed).toBe(true);
  });
});

describe("checkReaction", () => {
  it("allows the default set, with or without colons", () => {
    for (const name of ["eyes", ":white_check_mark:", "pray"]) {
      expect(checkReaction({ channel: "C1", timestamp: TS, name }, cfg()).allowed).toBe(true);
    }
    expect(normalizeReaction(":eyes:")).toBe("eyes");
  });
  it("refuses anything outside the allowlist", () => {
    const v = checkReaction({ channel: "C1", timestamp: TS, name: "middle_finger" }, cfg());
    expect(v.allowed ? null : v.rule).toBe("reaction_not_allowed");
  });
  it("honours a configured allowlist", () => {
    const c = cfg({ allowedReactions: ["rocket"] });
    expect(checkReaction({ channel: "C1", timestamp: TS, name: "rocket" }, c).allowed).toBe(true);
    expect(checkReaction({ channel: "C1", timestamp: TS, name: "eyes" }, c).allowed).toBe(false);
  });
  it("refuses a deny-listed channel and a malformed timestamp", () => {
    const c = cfg({ denyChannels: ["C1"] });
    const d = checkReaction({ channel: "C1", timestamp: TS, name: "eyes" }, c);
    expect(d.allowed ? null : d.rule).toBe("channel_denied");
    const t = checkReaction({ channel: "C2", timestamp: "now", name: "eyes" }, cfg());
    expect(t.allowed ? null : t.rule).toBe("bad_timestamp");
  });
});

describe("PostRateLimiter", () => {
  it("allows up to max posts per user per rolling hour, then refuses", () => {
    let now = 0;
    const l = new PostRateLimiter(2, 3_600_000, () => now);
    l.record("u1"); l.record("u1");
    const v = l.check("u1");
    expect(v.allowed ? null : v.rule).toBe("rate_limited");
    expect(l.check("u2").allowed).toBe(true); // per user
    now = 3_600_001; // the window rolls
    expect(l.check("u1").allowed).toBe(true);
  });
  it("only counts posts inside the window", () => {
    let now = 0;
    const l = new PostRateLimiter(2, 1000, () => now);
    l.record("u1");
    now = 600; l.record("u1");
    now = 1001; // the first post has aged out
    expect(l.check("u1").allowed).toBe(true);
  });
});
