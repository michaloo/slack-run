#!/usr/bin/env node
// slack-run: run commands from Slack messages, configured in YAML.
//   slack-run [serve] [--config slack-run.yaml] [--state state.json]
//   slack-run check [--config …]
//   slack-run simulate --text "…" [--user U] [--channel C] [--thread T] [--event mention|message|dm]
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { handle } from "./engine.ts";
import { serve } from "./slack.ts";
import { ThreadState } from "./state.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c" },
    state: { type: "string" },
    text: { type: "string" },
    user: { type: "string", default: "USIMULATED" },
    channel: { type: "string", default: "CSIMULATED" },
    thread: { type: "string" },
    event: { type: "string", default: "mention" },
    help: { type: "boolean", short: "h" },
  },
});
const cmd = positionals[0] ?? "serve";
const path = o.config ?? process.env.SLACK_RUN_CONFIG ?? "slack-run.yaml";
const log = (s: string) => console.error(`[${new Date().toISOString()}] ${s}`);

if (o.help) {
  console.log(`usage:
  slack-run [serve] [--config slack-run.yaml] [--state state.json]   connect to Slack and run rules
  slack-run check [--config …]                                       validate the config
  slack-run simulate --text "…" [--user U] [--channel C] [--thread T] [--event mention|message|dm]
                                                                      run the matching rule locally, print what would be posted`);
} else if (cmd === "check") {
  const c = loadConfig(path);
  console.log(`ok: ${c.rules.length} rule(s): ${c.rules.map((r) => r.name).join(", ")}`);
} else if (cmd === "simulate") {
  if (!o.text) throw new Error("simulate needs --text");
  const c = loadConfig(path, { requireTokens: false });
  const state = new ThreadState(o.state ?? c.state ?? null);
  const ts = `${Date.now() / 1000}`;
  const out = await handle(
    c,
    { kind: o.event as "mention", text: o.text, user: o.user!, channel: o.channel!, ts, thread: o.thread ?? ts },
    state,
    { react: async (e) => console.log(`:${e}:`), post: async (t) => console.log(t) },
  );
  if (!out) console.log("(no rule matched)");
  else console.error(`rule "${out.rule}", exit ${out.code}, thread ${o.thread ?? ts}`);
  process.exitCode = out ? (out.code === 0 ? 0 : 1) : 2;
} else if (cmd === "serve") {
  const c = loadConfig(path);
  const state = new ThreadState(o.state ?? c.state ?? "state.json");
  const sm = await serve(c, state, log);
  const stop = async () => (log("disconnecting"), await sm.disconnect(), process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  console.error(`unknown command ${cmd}; see --help`);
  process.exitCode = 2;
}
