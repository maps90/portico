import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BuiltinCtx, BuiltinProvider, BuiltinTool, RestResponse } from "../../../ports/builtin.js";
import {
  DEFAULT_SLACK_POLICY,
  PostRateLimiter,
  checkChannelAudience,
  checkReaction,
  checkReply,
  normalizeReaction,
  type SlackPolicyConfig,
  type SlackVerdict, isDirectMessage,
} from "../../../domain/slack-policy.js";

const ok = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError: true,
});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

const API = "https://slack.com/api";
/** Without the charset Slack accepts the JSON body but answers with a `missing_charset` warning. */
const JSON_UTF8 = { headers: { "Content-Type": "application/json; charset=utf-8" } };

/**
 * Slack answers HTTP 200 for almost every failure and puts the verdict in the
 * body: `{ok:false, error:"channel_not_found"}`. Checking `res.ok` alone would
 * report a refused post as a success, so both have to hold.
 */
const slackOk = (res: RestResponse): boolean =>
  res.ok && typeof res.body === "object" && res.body !== null && (res.body as { ok?: unknown }).ok === true;
const slackError = (res: RestResponse): string => {
  const b = res.body as { error?: unknown } | null;
  return `Slack error (HTTP ${res.status}): ${typeof b?.error === "string" ? b.error : JSON.stringify(res.body)}`;
};
const result = (res: RestResponse): CallToolResult => (slackOk(res) ? ok(res.body) : fail(slackError(res)));

/** One line per write attempt. Never carries the message text -- only where it was going and why. */
export interface SlackAuditEvent {
  userId: string;
  tool: "reply" | "react";
  channel: string;
  thread_ts?: string;
  outcome: "posted" | "refused" | "failed";
  rule?: string;
}
export type SlackAuditLog = (e: SlackAuditEvent) => void;
const consoleAudit: SlackAuditLog = (e) => console.log(`slack audit ${JSON.stringify(e)}`);

export interface SlackProviderDeps {
  audit?: SlackAuditLog;
  now?: () => number;
}

/**
 * Builds the Slack provider around one policy and one rate-limit budget. A
 * factory rather than a constant because the guardrails are configured per
 * deployment (allowed reactions, deny list, post budget) and the budget is state.
 *
 * The connection is a *user* token, so everything here speaks as the person who
 * connected it, under their own name. That is the point (a reply in their voice),
 * and it is why the guardrails below are enforced in code on every write. Send-only by design: exactly `reply` and
 * `react`. Reading Slack stays on the Slack MCP the user already has; there is no
 * read, edit, delete, upload, invite, channel-create or search tool here. The
 * only reads are the ones the guardrails themselves need (conversations.info for
 * the Slack Connect check, chat.getPermalink for the thread check and the link
 * reply returns).
 */
export function createSlackProvider(
  cfg: SlackPolicyConfig = DEFAULT_SLACK_POLICY,
  deps: SlackProviderDeps = {},
): BuiltinProvider {
  const audit = deps.audit ?? consoleAudit;
  const limiter = new PostRateLimiter(cfg.maxPostsPerHour, 60 * 60 * 1000, deps.now);

  /** Logs the refusal and turns it into the tool result; no Slack call has been made. */
  const refuse = (base: Omit<SlackAuditEvent, "outcome" | "rule">, v: Exclude<SlackVerdict, { allowed: true }>): CallToolResult => {
    audit({ ...base, outcome: "refused", rule: v.rule });
    return fail(`Refused by Slack guardrail '${v.rule}': ${v.reason}.`);
  };

  /**
   * Asks Slack who can see the channel. Fails closed: if the token cannot read the
   * channel's info, it cannot know the channel is internal, so it does not post.
   */
  const audience = async (ctx: BuiltinCtx, channel: string): Promise<SlackVerdict> => {
    const res = await ctx.http.get(`${API}/conversations.info`, { query: { channel } });
    if (!slackOk(res)) return { allowed: false, rule: "channel_unverified", reason: `could not verify the channel (${slackError(res)})` };
    const c = (res.body as { channel?: Record<string, unknown> }).channel ?? {};
    return checkChannelAudience({
      isExtShared: c.is_ext_shared === true,
      isShared: c.is_shared === true,
      isPendingExtShared: c.is_pending_ext_shared === true,
    });
  };

  const tools: BuiltinTool[] = [
    {
      def: { name: "reply", description:
          "Reply in Slack as the person who connected Slack to Portico (their own name, no app label). " +
          (cfg.allowTopLevelPosts
            ? "Pass thread_ts to reply inside a thread; without it the message is a new top-level post " +
              "(in a DM, or in an internal channel). "
            : "Outside a DM this ONLY replies inside an existing thread: thread_ts is required and a new " +
              "top-level channel post is refused. ") +
          "Also refused: Slack Connect / shared channels, @here/@channel/@everyone, any " +
          "text containing credentials, tokens, keys or private IP addresses, text over " +
          `${cfg.maxMessageLength} characters, and more than ${cfg.maxPostsPerHour} posts ` +
          "per hour. Returns the permalink of the posted message.",
        inputSchema: {
          type: "object",
          properties: { channel: { type: "string", description: "channel id (C…/G…), or a DM id (D…)" },
            thread_ts: { type: "string", description: cfg.allowTopLevelPosts
              ? "ts of the thread's parent message; omit for a new top-level post"
              : "ts of the thread's parent message; required unless channel is a DM" },
            text: { type: "string", description: "message text (Slack mrkdwn)" } },
          required: ["channel", "text"] } },
      handle: async (ctx, a) => {
        const channel = str(a.channel);
        const threadTs = str(a.thread_ts) || undefined;
        const base = { userId: ctx.userId ?? "", tool: "reply" as const, channel, ...(threadTs ? { thread_ts: threadTs } : {}) };
        // Order matters: every check that needs no network runs before the first
        // Slack call, so the common violations cost nothing and touch nothing.
        if (!ctx.userId) return refuse(base, { allowed: false, rule: "no_user", reason: "no portico user on the call" });
        // With top-level posts allowed, a blank thread_ts must not silently become a
        // top-level post: a caller that sent the field meant a thread. Omit it to post top-level.
        if (cfg.allowTopLevelPosts && a.thread_ts !== undefined && !threadTs && !isDirectMessage(channel)) {
          return refuse(base, { allowed: false, rule: "bad_thread_ts",
            reason: "thread_ts is empty; omit it for a top-level post, or pass the parent message ts" });
        }
        const v = checkReply({ channel, text: str(a.text), ...(threadTs ? { threadTs } : {}) }, cfg);
        if (!v.allowed) return refuse(base, v);
        const rate = limiter.check(ctx.userId);
        if (!rate.allowed) return refuse(base, rate);

        const aud = await audience(ctx, channel);
        if (!aud.allowed) return refuse(base, aud);
        if (threadTs) {
          // A thread_ts that names no message, or names a reply rather than a
          // parent, is not reliably an error to chat.postMessage -- it can land as
          // a top-level post, the one thing this tool promises not to do. So the
          // parent is proven first. chat.getPermalink is used rather than
          // conversations.replies because it needs no *:history scope (the token is
          // send-only): it fails with message_not_found for a ts that is not in
          // the channel, and a reply's permalink carries `thread_ts=<parent>`.
          const t = await ctx.http.get(`${API}/chat.getPermalink`, { query: { channel, message_ts: threadTs } });
          const link = slackOk(t) ? str((t.body as { permalink?: unknown }).permalink) : "";
          const parentOf = link ? new URL(link).searchParams.get("thread_ts") : null;
          if (!link || (parentOf !== null && parentOf !== threadTs)) {
            return refuse(base, { allowed: false, rule: "thread_not_found",
              reason: "thread_ts does not name a parent message in this channel" });
          }
        }

        const res = await ctx.http.post(`${API}/chat.postMessage`, {
          channel, text: str(a.text),
          ...(threadTs ? { thread_ts: threadTs, reply_broadcast: false } : {}),
        }, JSON_UTF8);
        if (!slackOk(res)) {
          audit({ ...base, outcome: "failed", rule: "slack_error" });
          return fail(slackError(res));
        }
        limiter.record(ctx.userId);
        audit({ ...base, outcome: "posted" });
        const ts = str((res.body as { ts?: unknown }).ts);
        const link = await ctx.http.get(`${API}/chat.getPermalink`, { query: { channel, message_ts: ts } });
        const permalink = slackOk(link) ? str((link.body as { permalink?: unknown }).permalink) : "";
        return ok({ ok: true, channel, ts, ...(threadTs ? { thread_ts: threadTs } : {}),
          permalink: permalink || null });
      },
    },
    {
      def: { name: "react", description:
          `Add an emoji reaction as the person who connected Slack. Only these are allowed: ${cfg.allowedReactions.join(", ")}. ` +
          "Shared / Slack Connect channels are refused.",
        inputSchema: {
          type: "object",
          properties: { channel: { type: "string" }, timestamp: { type: "string", description: "ts of the message to react to" },
            name: { type: "string", description: `reaction name without colons, one of: ${cfg.allowedReactions.join(", ")}` } },
          required: ["channel", "timestamp", "name"] } },
      handle: async (ctx, a) => {
        const channel = str(a.channel);
        const base = { userId: ctx.userId ?? "", tool: "react" as const, channel };
        if (!ctx.userId) return refuse(base, { allowed: false, rule: "no_user", reason: "no portico user on the call" });
        const v = checkReaction({ channel, timestamp: str(a.timestamp), name: str(a.name) }, cfg);
        if (!v.allowed) return refuse(base, v);
        const aud = await audience(ctx, channel);
        if (!aud.allowed) return refuse(base, aud);
        const res = await ctx.http.post(`${API}/reactions.add`, {
          channel, timestamp: str(a.timestamp), name: normalizeReaction(str(a.name)),
        }, JSON_UTF8);
        if (!slackOk(res)) {
          audit({ ...base, outcome: "failed", rule: "slack_error" });
          return fail(slackError(res));
        }
        audit({ ...base, outcome: "posted" });
        return ok(`Reacted :${normalizeReaction(str(a.name))}: on ${str(a.timestamp)}.`);
      },
    },
  ];

  return { id: "slack", toolPrefix: "slack", tools };
}

/** Default-policy instance; the composition root builds its own from Settings. */
export const slackProvider: BuiltinProvider = createSlackProvider();
