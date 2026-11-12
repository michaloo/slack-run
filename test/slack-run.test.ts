import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitWords, toArgv } from "../src/argv.ts";
import { parseConfig } from "../src/config.ts";
import { capture, handle, matchRule, type Message } from "../src/engine.ts";
import { chunks, toMessage } from "../src/slack.ts";
import { ThreadState } from "../src/state.ts";

const msg = (over: Partial<Message> = {}): Message => ({ kind: "mention", text: "hi", user: "U1", channel: "C1", ts: "1.1", thread: "1.1", ...over });

test("splitWords handles quotes and escapes", () => {
  assert.deepEqual(splitWords(`casm send a1 "{text}" --wait`), ["casm", "send", "a1", "{text}", "--wait"]);
  assert.deepEqual(splitWords(`echo 'a b' "c \\"d\\"" e\\ f`), ["echo", "a b", 'c "d"', "e f"]);
  assert.throws(() => splitWords(`echo "oops`), /unterminated/);
});

test("Slack text can't change the command (no shell, substitution after splitting)", () => {
  const argv = toArgv(`echo "{text}"`, { text: `x"; rm -rf ~ #` });
  assert.deepEqual(argv, ["echo", `x"; rm -rf ~ #`]);
});

test("config validation requires an explicit user allowlist", () => {
  const base = `slack: {appToken: xapp-1, botToken: xoxb-1}\nrules:\n  - name: r\n    on: {event: mention}\n    steps: [{run: echo hi}]\n`;
  assert.throws(() => parseConfig(base), /on.users, or set on.anyone/);
  assert.ok(parseConfig(base.replace("{event: mention}", "{event: mention, anyone: true}")));
  assert.throws(() => parseConfig(base.replace("xapp-1", "nope").replace("{event: mention}", "{anyone: true}")), /appToken/);
});

test("env references are expanded", () => {
  process.env.SR_TEST_TOKEN = "xapp-from-env";
  const c = parseConfig(`slack: {appToken: "\${SR_TEST_TOKEN}", botToken: xoxb-1}\nrules: [{name: r, on: {anyone: true}, steps: [{run: echo}]}]`);
  assert.equal(c.slack.appToken, "xapp-from-env");
});

const config = parseConfig(
  `
slack: {appToken: xapp-1, botToken: xoxb-1}
rules:
  - name: deploy
    on: {users: [U1], match: '^deploy (?<env>\\w+)$'}
    steps: [{run: 'echo deploying {env}'}]
  - name: new thread
    on: {users: [U1], thread: new}
    steps:
      - run: 'echo agent-42'
        capture: {agent: '^(agent-\\d+)$'}
      - run: 'echo started {agent} with: {text}'
    reactions: {start: eyes, done: white_check_mark, error: x, exit3: hourglass}
  - name: follow-up
    on: {users: [U1], thread: existing}
    steps: [{run: 'echo to {agent}: {text}'}]
  - name: failing
    on: {users: [U2]}
    steps: [{run: 'sh -c "echo oops >&2; exit 3"'}]
    reactions: {error: x, exit3: hourglass}
`,
);

test("rules match on user, regex groups and thread state", async () => {
  const state = new ThreadState(join(mkdtempSync(join(tmpdir(), "sr-")), "state.json"));
  assert.equal(matchRule(config, msg({ user: "U9" }), state), null);
  const posts: string[] = [];
  const reacts: string[] = [];
  const fx = { react: async (e: string) => void reacts.push(e), post: async (t: string) => void posts.push(t) };

  const d = await handle(config, msg({ text: "deploy prod" }), state, fx);
  assert.equal(d?.rule, "deploy");
  assert.equal(posts.at(-1), "deploying prod");

  const first = await handle(config, msg({ text: "fix the bug", thread: "9.9", ts: "9.9" }), state, fx);
  assert.equal(first?.rule, "new thread");
  assert.equal(posts.at(-1), "started agent-42 with: fix the bug");
  assert.deepEqual(reacts.slice(-2), ["eyes", "white_check_mark"]);
  assert.deepEqual(state.get("C1:9.9"), { agent: "agent-42" });

  const next = await handle(config, msg({ text: "and the tests", thread: "9.9", ts: "9.95" }), state, fx);
  assert.equal(next?.rule, "follow-up");
  assert.equal(posts.at(-1), "to agent-42: and the tests");
});

test("failures post the error and react by exit code", async () => {
  const posts: string[] = [];
  const reacts: string[] = [];
  const o = await handle(config, msg({ user: "U2" }), new ThreadState(null), { react: async (e) => void reacts.push(e), post: async (t) => void posts.push(t) });
  assert.equal(o?.code, 3);
  assert.match(posts.at(-1)!, /exited 3:\n```oops```/);
  assert.deepEqual(reacts, ["hourglass"]);
});

test("capture uses named groups or group 1", () => {
  assert.deepEqual(capture({ id: "id: (\\w+)" }, "x\nid: abc\n"), { id: "abc" });
  assert.deepEqual(capture({ x: "(?<a>\\d+)-(?<b>\\d+)" }, "12-34"), { a: "12", b: "34" });
});

test("Slack events become messages; bots, edits and duplicate mentions are ignored", () => {
  const base = { channel: "C1", ts: "1.0", user: "U1" };
  assert.deepEqual(toMessage({ ...base, type: "app_mention", text: "<@UBOT> do it" }, "UBOT"), msg({ text: "do it", ts: "1.0", thread: "1.0" }));
  assert.equal(toMessage({ ...base, type: "message", text: "<@UBOT> do it" }, "UBOT"), null);
  assert.equal(toMessage({ ...base, type: "message", bot_id: "B1", text: "x" }, "UBOT"), null);
  assert.equal(toMessage({ ...base, type: "message", subtype: "message_changed", text: "x" }, "UBOT"), null);
  assert.equal(toMessage({ ...base, type: "message", channel_type: "im", text: "hello", thread_ts: "0.5" }, "UBOT")?.kind, "dm");
});

test("allowed bots get through, marked as bots; other bots don't", () => {
  const ev = { channel: "C1", ts: "1.0", type: "app_mention", bot_id: "B1", text: "<@UBOT> hi" };
  assert.deepEqual(toMessage({ ...ev, user: "UJANUSZ" }, "UBOT", new Set(["UJANUSZ"])), { ...msg({ text: "hi", ts: "1.0", thread: "1.0", user: "UJANUSZ" }), bot: true });
  assert.equal(toMessage({ ...ev, user: "UOTHER" }, "UBOT", new Set(["UJANUSZ"])), null);
  assert.equal(toMessage({ ...ev, user: "UJANUSZ", subtype: "bot_message" }, "UBOT", new Set(["UJANUSZ"])), null);
});

test("bots config is validated", () => {
  const base = `slack: {appToken: xapp-1, botToken: xoxb-1}\nrules: [{name: r, on: {anyone: true}, steps: [{run: echo}]}]\n`;
  assert.ok(parseConfig(base + "bots: {users: [U1], perThread: 2}"));
  assert.throws(() => parseConfig(base + "bots: {users: []}"), /bots.users/);
  assert.throws(() => parseConfig(base + "bots: {users: [U1], perThread: 0}"), /perThread/);
});

test("long replies are split, preferring newlines", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = chunks(text, 1000);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join("\n"), text);
});
