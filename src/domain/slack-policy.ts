/**
 * Guardrails for what an agent may write to Slack through the bot identity.
 *
 * These live in code, not in a prompt, because a prompt is a request and this is a
 * rule: whatever the model decides, a reply that would open a new top-level post,
 * ping a whole channel, reach a Slack Connect partner or carry a credential is
 * refused before any write call is made. Pure functions plus one injected clock --
 * no I/O -- so every rule is testable on its own and the provider only has to ask.
 *
 * A refusal names the rule that matched and never echoes the offending text back:
 * the reason is what an agent (and the audit log) sees, and repeating a leaked
 * token in an error message is just leaking it one hop later.
 */

export interface SlackPolicyConfig {
  /** Reaction names the bot may add, without colons (e.g. "eyes"). */
  allowedReactions: string[];
  /** Channel ids the bot must never write to, whatever else the call says. */
  denyChannels: string[];
  /** Posts per portico user per rolling hour. */
  maxPostsPerHour: number;
  /** Characters per message. Slack truncates past 40k; a reply this long is a wall. */
  maxMessageLength: number;
}

export const DEFAULT_SLACK_POLICY: SlackPolicyConfig = {
  allowedReactions: ["eyes", "white_check_mark", "pray"],
  denyChannels: [],
  maxPostsPerHour: 20,
  maxMessageLength: 4000,
};

export type SlackVerdict = { allowed: true } | { allowed: false; rule: string; reason: string };

const ALLOW: SlackVerdict = { allowed: true };
const deny = (rule: string, reason: string): SlackVerdict => ({ allowed: false, rule, reason });

/** Only a one-to-one DM (`D…`) may take a message outside a thread. */
export const isDirectMessage = (channel: string): boolean => /^D[A-Z0-9]+$/i.test(channel);

/** A Slack message timestamp, e.g. "1730800000.123456". */
const isTs = (v: string): boolean => /^\d+\.\d+$/.test(v);

interface TextRule { rule: string; reason: string; test: (text: string) => boolean }
const re = (r: RegExp) => (t: string) => r.test(t);

const PRIVATE_IPV4 = (text: string): boolean => {
  // Every dotted quad, then range-checked numerically: a single regex for
  // 172.16/12 and 100.64/10 is unreadable, and a number check cannot be off by one
  // in a character class.
  for (const m of text.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d])/g)) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((o) => o > 255)) continue;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
};

/**
 * Outbound-text rules, checked in order; the first match wins. The secret rules
 * come before the generic `credential_assignment`, so a recognisable token is
 * reported as what it is rather than as "something after `token=`".
 */
const TEXT_RULES: TextRule[] = [
  { rule: "slack_token", reason: "contains a Slack token",
    test: re(/\bxox[abprs]-[A-Za-z0-9-]{8,}/) },
  { rule: "private_key", reason: "contains a private key block",
    test: re(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/) },
  { rule: "jwt", reason: "contains a JWT",
    test: re(/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/) },
  { rule: "aws_access_key", reason: "contains an AWS access key id",
    test: re(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/) },
  { rule: "github_token", reason: "contains a GitHub token",
    test: re(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/) },
  { rule: "connection_string", reason: "contains a connection string with credentials",
    test: re(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/<>]+:[^\s@/<>]+@/i) },
  // No leading word boundary on purpose: `client_secret=`, `db_password:` and
  // `access_token=` are the common shapes, and `_` is a word character.
  { rule: "credential_assignment", reason: "contains a credential assignment (password/secret/token/api key/psk = value)",
    test: re(/(password|passwd|secret|api[_-]?key|token|psk)["']?[ \t]*[:=][ \t]*["']?[^\s"'<>]+/i) },
  { rule: "private_ip", reason: "contains a private/internal IP address (10/8, 172.16/12, 192.168/16, 100.64/10)",
    test: PRIVATE_IPV4 },
  // Slack's encoded form (`<!here>`, `<!here|here>`) and the plain-typed one,
  // which chat.postMessage resolves too when link_names is on.
  { rule: "mass_mention", reason: "contains a mass mention (@here/@channel/@everyone)",
    test: re(/<!(here|channel|everyone)\b|(^|[^\w])@(here|channel|everyone)\b/i) },
];

/** The first outbound-text rule `text` breaks, or null when it is clean. */
export function scanText(text: string): { rule: string; reason: string } | null {
  for (const r of TEXT_RULES) if (r.test(text)) return { rule: r.rule, reason: r.reason };
  return null;
}

const denied = (channel: string, cfg: SlackPolicyConfig): boolean =>
  cfg.denyChannels.some((c) => c.toUpperCase() === channel.toUpperCase());

export interface ReplyRequest { channel: string; threadTs?: string; text: string }

/**
 * Everything decidable about a reply without asking Slack. Run first, so a
 * violation costs no API call at all.
 */
export function checkReply(req: ReplyRequest, cfg: SlackPolicyConfig): SlackVerdict {
  if (!req.channel) return deny("missing_channel", "channel is required");
  if (denied(req.channel, cfg)) return deny("channel_denied", `channel ${req.channel} is on the deny list`);
  if (req.threadTs !== undefined && !isTs(req.threadTs)) {
    return deny("bad_thread_ts", "thread_ts must be a Slack message timestamp like 1730800000.123456");
  }
  if (!req.threadTs && !isDirectMessage(req.channel)) {
    return deny("thread_required",
      "replies outside a DM must go in an existing thread: pass thread_ts (the bot never starts a top-level channel post)");
  }
  if (!req.text.trim()) return deny("empty_text", "text is empty");
  if (req.text.length > cfg.maxMessageLength) {
    return deny("too_long", `text is ${req.text.length} characters; the limit is ${cfg.maxMessageLength}`);
  }
  const hit = scanText(req.text);
  return hit ? deny(hit.rule, `text ${hit.reason}; refusing to post it`) : ALLOW;
}

/** What conversations.info says about who else can see a channel. */
export interface ChannelFacts { isExtShared?: boolean; isShared?: boolean; isPendingExtShared?: boolean }

/**
 * Slack Connect channels have members from other organisations. `is_shared` is
 * also set for channels shared between workspaces of one Enterprise Grid org;
 * refusing both is the conservative reading -- the bot has no way to tell an
 * internal workspace from a partner's.
 */
export function checkChannelAudience(facts: ChannelFacts): SlackVerdict {
  if (facts.isExtShared || facts.isShared || facts.isPendingExtShared) {
    return deny("shared_channel", "channel is externally shared (Slack Connect); the bot does not write there");
  }
  return ALLOW;
}

/** Accepts `eyes` or `:eyes:`; returns the bare name Slack expects. */
export const normalizeReaction = (name: string): string => name.trim().replace(/^:|:$/g, "");

export function checkReaction(req: { channel: string; timestamp: string; name: string }, cfg: SlackPolicyConfig): SlackVerdict {
  if (!req.channel) return deny("missing_channel", "channel is required");
  if (denied(req.channel, cfg)) return deny("channel_denied", `channel ${req.channel} is on the deny list`);
  if (!isTs(req.timestamp)) return deny("bad_timestamp", "timestamp must be a Slack message timestamp like 1730800000.123456");
  const name = normalizeReaction(req.name);
  if (!cfg.allowedReactions.includes(name)) {
    return deny("reaction_not_allowed", `reaction '${name}' is not allowed; allowed: ${cfg.allowedReactions.join(", ")}`);
  }
  return ALLOW;
}

/**
 * Posts per user over a rolling window. In memory, so the budget is per process:
 * N replicas give a user N times the limit, and a restart resets it. Good enough
 * to stop a looping agent; not an accounting system.
 */
export class PostRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(userId: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.hits.get(userId) ?? []).filter((t) => t > cutoff);
    this.hits.set(userId, kept);
    return kept;
  }

  check(userId: string): SlackVerdict {
    return this.recent(userId).length >= this.max
      ? deny("rate_limited", `post limit reached: ${this.max} per hour per user`)
      : ALLOW;
  }

  record(userId: string): void {
    this.recent(userId).push(this.now());
  }
}
