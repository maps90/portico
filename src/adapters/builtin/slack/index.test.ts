import { describe, it, expect } from "vitest";
import { createSlackProvider, slackProvider, type SlackAuditEvent } from "./index.js";
import { DEFAULT_SLACK_POLICY, type SlackPolicyConfig } from "../../../domain/slack-policy.js";
import type { RestClient } from "../../../ports/builtin.js";

const TS = "1730800000.123456";
const PERMALINK = "https://okadoc.slack.com/archives/C1/p1730800000123456";
const INTERNAL = { ok: true, channel: { id: "C1", is_shared: false, is_ext_shared: false } };

/**
 * A fake Slack: every route answers HTTP 200 like the real one, with `ok` in the
 * body. `routes` maps a method name to the body it returns.
 */
function http(routes: Record<string, unknown> = {}, calls: any[] = []): RestClient {
  const defaults: Record<string, unknown> = {
    "conversations.info": INTERNAL,
    "chat.getPermalink": { ok: true, permalink: PERMALINK },
    "chat.postMessage": { ok: true, channel: "C1", ts: "1730800099.000100" },
    "reactions.add": { ok: true },
  };
  const find = (url: string) => {
    const m = url.split("/api/")[1] ?? "";
    return m in routes ? routes[m] : defaults[m];
  };
  return {
    get: async (url, init) => { calls.push(["GET", url, init]); return { status: 200, ok: true, body: find(url) ?? null }; },
    post: async (url, body, init) => { calls.push(["POST", url, body, init]); return { status: 200, ok: true, body: find(url) ?? null }; },
    put: async (url, body) => { calls.push(["PUT", url, body]); return { status: 200, ok: true, body: null }; },
  };
}

function setup(over: Partial<SlackPolicyConfig> = {}, now = () => 0) {
  const events: SlackAuditEvent[] = [];
  const p = createSlackProvider({ ...DEFAULT_SLACK_POLICY, ...over }, { audit: (e) => events.push(e), now });
  const tool = (name: string) => p.tools.find((t) => t.def.name === name)!;
  return { p, tool, events };
}
const text = (r: any) => (r.content[0] as any).text as string;
const posts = (calls: any[]) => calls.filter((c) => c[0] === "POST");
const ctx = (c: RestClient) => ({ http: c, userId: "u1" });

describe("slackProvider", () => {
  it("is send-only: exactly reply and react, bound to the slack connection", () => {
    expect(slackProvider.id).toBe("slack");
    expect(slackProvider.toolPrefix).toBe("slack");
    expect(slackProvider.tools.map((t) => t.def.name).sort()).toEqual(["react", "reply"]);
  });

  it("reply posts in the thread and returns the permalink of the posted message", async () => {
    const { tool, events } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({}, calls)), { channel: "C1", thread_ts: TS, text: "On it." });
    expect(res.isError).toBeFalsy();
    const post = posts(calls)[0];
    expect(post[1]).toBe("https://slack.com/api/chat.postMessage");
    expect(post[2]).toEqual({ channel: "C1", text: "On it.", thread_ts: TS, reply_broadcast: false });
    expect(post[3].headers["Content-Type"]).toContain("charset=utf-8");
    // The permalink lookup after the post is for the new message, not the parent.
    const lastGet = calls.filter((c) => c[0] === "GET").at(-1);
    expect(lastGet[1]).toContain("chat.getPermalink");
    expect(lastGet[2].query.message_ts).toBe("1730800099.000100");
    expect(JSON.parse(text(res)).permalink).toBe(PERMALINK);
    expect(events).toEqual([{ userId: "u1", tool: "reply", channel: "C1", thread_ts: TS, outcome: "posted" }]);
  });

  it("with allowTopLevelPosts, reply starts a top-level channel post (no thread_ts, no parent lookup)", async () => {
    const { tool, events } = setup({ allowTopLevelPosts: true });
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({}, calls)), { channel: "C1", text: "morning, quick update" });
    expect(res.isError).toBeFalsy();
    expect(posts(calls)[0][2]).toEqual({ channel: "C1", text: "morning, quick update" });
    // audience is still checked first; no chat.getPermalink before the post (there is no parent to prove)
    const gets = calls.filter((c) => c[0] === "GET").map((c) => c[1].split("/api/")[1]);
    expect(gets).toEqual(["conversations.info", "chat.getPermalink"]);
    expect(events).toEqual([{ userId: "u1", tool: "reply", channel: "C1", outcome: "posted" }]);
    expect(tool("reply").def.description).toContain("new top-level post");
  });

  it("with allowTopLevelPosts, a blank thread_ts is refused instead of silently posting top-level", async () => {
    const { tool, events } = setup({ allowTopLevelPosts: true });
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({}, calls)), { channel: "C1", thread_ts: "", text: "meant for a thread" });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(events[0]).toMatchObject({ outcome: "refused", rule: "bad_thread_ts" });
  });

  it("with allowTopLevelPosts, deny list and rate limit still stop a top-level post before any HTTP call", async () => {
    const denied = setup({ allowTopLevelPosts: true, denyChannels: ["C1"] });
    const c1: any[] = [];
    expect((await denied.tool("reply").handle(ctx(http({}, c1)), { channel: "C1", text: "hi" })).isError).toBe(true);
    expect(c1).toEqual([]);
    expect(denied.events[0]).toMatchObject({ rule: "channel_denied" });
    const limited = setup({ allowTopLevelPosts: true, maxPostsPerHour: 1 });
    await limited.tool("reply").handle(ctx(http()), { channel: "C1", text: "one" });
    const c2: any[] = [];
    expect((await limited.tool("reply").handle(ctx(http({}, c2)), { channel: "C1", text: "two" })).isError).toBe(true);
    expect(posts(c2)).toEqual([]);
    expect(limited.events.at(-1)).toMatchObject({ rule: "rate_limited" });
  });

  it("with allowTopLevelPosts, a DM still posts without thread_ts and an external group DM is refused", async () => {
    const { tool } = setup({ allowTopLevelPosts: true });
    const dm: any[] = [];
    expect((await tool("reply").handle(ctx(http({ "conversations.info": { ok: true, channel: { id: "D1" } } }, dm)), { channel: "D1", text: "hey" })).isError).toBeFalsy();
    expect(posts(dm)[0][2]).toEqual({ channel: "D1", text: "hey" });
    const g: any[] = [];
    const res = await tool("reply").handle(ctx(http({ "conversations.info": { ok: true, channel: { id: "G1", is_mpim: true, is_ext_shared: true } } }, g)),
      { channel: "G1", text: "hi all" });
    expect(res.isError).toBe(true);
    expect(posts(g)).toEqual([]);
  });

  it("with allowTopLevelPosts, a top-level post to a Slack Connect channel is still refused", async () => {
    const { tool, events } = setup({ allowTopLevelPosts: true });
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({ "conversations.info": { ok: true, channel: { id: "C1", is_ext_shared: true } } }, calls)),
      { channel: "C1", text: "hi partner" });
    expect(res.isError).toBe(true);
    expect(posts(calls)).toEqual([]);
    expect(events[0]).toMatchObject({ outcome: "refused", rule: "shared_channel" });
  });

  it("reply refuses a top-level channel post and makes no HTTP call at all", async () => {
    const { tool, events } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({}, calls)), { channel: "C1", text: "hello all" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("thread_required");
    expect(calls).toEqual([]);
    expect(events[0]).toMatchObject({ outcome: "refused", rule: "thread_required" });
  });

  it("reply lets a DM go without a thread", async () => {
    const { tool } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({}, calls)), { channel: "D1", text: "hi" });
    expect(res.isError).toBeFalsy();
    expect(posts(calls)[0][2]).toEqual({ channel: "D1", text: "hi" });
  });

  it("reply refuses a secret without calling Slack, and never echoes it", async () => {
    const { tool, events } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({}, calls)),
      { channel: "C1", thread_ts: TS, text: "token: xo" + "xb-1234567890-TOPSECRETVALUE" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("slack_token");
    expect(text(res)).not.toContain("TOPSECRETVALUE");
    expect(calls).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("TOPSECRETVALUE");
  });

  it("reply refuses mass mentions and private IPs without calling Slack", async () => {
    const { tool } = setup();
    for (const [t, r] of [["<!channel> fyi", "mass_mention"], ["host 10.0.4.2", "private_ip"]] as const) {
      const calls: any[] = [];
      const res = await tool("reply").handle(ctx(http({}, calls)), { channel: "C1", thread_ts: TS, text: t });
      expect(text(res)).toContain(r);
      expect(calls).toEqual([]);
    }
  });

  it("reply refuses a deny-listed channel and over-long text without calling Slack", async () => {
    const { tool } = setup({ denyChannels: ["C1"], maxMessageLength: 5 });
    const calls: any[] = [];
    expect(text(await tool("reply").handle(ctx(http({}, calls)), { channel: "C1", thread_ts: TS, text: "hi" }))).toContain("channel_denied");
    expect(text(await tool("reply").handle(ctx(http({}, calls)), { channel: "C2", thread_ts: TS, text: "too long" }))).toContain("too_long");
    expect(calls).toEqual([]);
  });

  it("reply refuses a Slack Connect channel after reading its info, with no post", async () => {
    const { tool, events } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({ "conversations.info": { ok: true, channel: { is_ext_shared: true } } }, calls)),
      { channel: "C1", thread_ts: TS, text: "hi" });
    expect(text(res)).toContain("shared_channel");
    expect(calls.map((c) => c[1])).toEqual(["https://slack.com/api/conversations.info"]);
    expect(events[0]).toMatchObject({ outcome: "refused", rule: "shared_channel" });
  });

  it("reply fails closed when the channel cannot be verified", async () => {
    const { tool } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({ "conversations.info": { ok: false, error: "missing_scope" } }, calls)),
      { channel: "C1", thread_ts: TS, text: "hi" });
    expect(text(res)).toContain("channel_unverified");
    expect(text(res)).toContain("missing_scope");
    expect(posts(calls)).toEqual([]);
  });

  it("reply refuses a thread_ts that names no message, rather than risk a top-level post", async () => {
    const { tool } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({ "chat.getPermalink": { ok: false, error: "message_not_found" } }, calls)),
      { channel: "C1", thread_ts: TS, text: "hi" });
    expect(text(res)).toContain("thread_not_found");
    expect(posts(calls)).toEqual([]);
  });

  it("reply refuses a thread_ts that is itself a reply, not a parent", async () => {
    const { tool } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle(ctx(http({ "chat.getPermalink":
      { ok: true, permalink: `${PERMALINK}?thread_ts=1730700000.000001&cid=C1` } }, calls)),
      { channel: "C1", thread_ts: TS, text: "hi" });
    expect(text(res)).toContain("thread_not_found");
    expect(posts(calls)).toEqual([]);
  });

  it("reply enforces the per-user hourly budget, and only counts real posts", async () => {
    let now = 0;
    const { tool } = setup({ maxPostsPerHour: 2 }, () => now);
    const calls: any[] = [];
    const c = http({}, calls);
    // A refused attempt does not spend budget.
    await tool("reply").handle(ctx(c), { channel: "C1", text: "top-level" });
    await tool("reply").handle(ctx(c), { channel: "D1", text: "one" });
    await tool("reply").handle(ctx(c), { channel: "D1", text: "two" });
    const before = calls.length;
    const res = await tool("reply").handle(ctx(c), { channel: "D1", text: "three" });
    expect(text(res)).toContain("rate_limited");
    expect(calls.length).toBe(before);
    // Another user has their own budget.
    expect((await tool("reply").handle({ http: c, userId: "u2" }, { channel: "D1", text: "hi" })).isError).toBeFalsy();
    now = 3_600_001;
    expect((await tool("reply").handle(ctx(c), { channel: "D1", text: "later" })).isError).toBeFalsy();
  });

  it("reply refuses a call with no portico user rather than share one budget", async () => {
    const { tool } = setup();
    const calls: any[] = [];
    const res = await tool("reply").handle({ http: http({}, calls) }, { channel: "D1", text: "hi" });
    expect(text(res)).toContain("no_user");
    expect(calls).toEqual([]);
  });

  it("reply surfaces Slack's ok:false on an HTTP 200 as an error", async () => {
    const { tool, events } = setup();
    const res = await tool("reply").handle(ctx(http({ "chat.postMessage": { ok: false, error: "not_in_channel" } })),
      { channel: "D1", text: "hi" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("not_in_channel");
    expect(events[0]).toMatchObject({ outcome: "failed", rule: "slack_error" });
  });

  it("audit events never carry the message text", async () => {
    const { tool, events } = setup();
    await tool("reply").handle(ctx(http()), { channel: "D1", text: "a private note" });
    await tool("reply").handle(ctx(http()), { channel: "C1", text: "another private note" });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("private note");
  });

  it("react adds an allowed reaction, colons stripped", async () => {
    const { tool, events } = setup();
    const calls: any[] = [];
    const res = await tool("react").handle(ctx(http({}, calls)), { channel: "C1", timestamp: TS, name: ":eyes:" });
    expect(res.isError).toBeFalsy();
    const post = posts(calls)[0];
    expect(post[1]).toBe("https://slack.com/api/reactions.add");
    expect(post[2]).toEqual({ channel: "C1", timestamp: TS, name: "eyes" });
    expect(events[0]).toMatchObject({ tool: "react", outcome: "posted" });
  });

  it("react refuses a reaction outside the allowlist without calling Slack", async () => {
    const { tool, events } = setup();
    const calls: any[] = [];
    const res = await tool("react").handle(ctx(http({}, calls)), { channel: "C1", timestamp: TS, name: "thumbsdown" });
    expect(text(res)).toContain("reaction_not_allowed");
    expect(calls).toEqual([]);
    expect(events[0]).toMatchObject({ outcome: "refused", rule: "reaction_not_allowed" });
  });

  it("react refuses a shared channel with no reactions.add call", async () => {
    const { tool } = setup();
    const calls: any[] = [];
    const res = await tool("react").handle(ctx(http({ "conversations.info": { ok: true, channel: { is_shared: true } } }, calls)),
      { channel: "C1", timestamp: TS, name: "eyes" });
    expect(text(res)).toContain("shared_channel");
    expect(posts(calls)).toEqual([]);
  });

  it("descriptions state the guardrails so the agent can plan around them", () => {
    const { tool } = setup();
    expect(tool("reply").def.description).toContain("thread_ts is required");
    expect(tool("react").def.description).toContain("eyes, white_check_mark, pray");
  });
});
