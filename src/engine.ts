// Matches a Slack message against the rules and runs the first matching rule's
// steps. Independent of Slack itself, so `simulate` and tests use it directly.
import { spawn } from "node:child_process";
import { toArgv, fill } from "./argv.ts";
import { duration, type Config, type Rule, type Step } from "./config.ts";
import type { ThreadState } from "./state.ts";

export type Message = {
  kind: "mention" | "message" | "dm";
  text: string;
  user: string;
  channel: string;
  ts: string;
  // The thread this belongs to: thread_ts, or ts for a new top-level message.
  thread: string;
};

export type StepResult = { argv: string[]; code: number; stdout: string; stderr: string; timedOut: boolean };

export type Outcome = {
  rule: string;
  steps: StepResult[];
  // Exit code of the step that ended the run (0 when all succeeded).
  code: number;
  reply: string | null;
  error: string | null;
};

export type Effects = {
  react: (emoji: string) => Promise<void>;
  post: (text: string) => Promise<void>;
};

export function matchRule(config: Config, m: Message, state: ThreadState): { rule: Rule; vars: Record<string, string> } | null {
  for (const rule of config.rules) {
    const on = rule.on;
    const event = on.event ?? "mention";
    if (event !== "any" && event !== m.kind) continue;
    if (on.channels?.length && !on.channels.includes(m.channel)) continue;
    if (!on.anyone && !on.users?.includes(m.user)) continue;
    const saved = state.get(`${m.channel}:${m.thread}`);
    if (on.thread === "new" && saved) continue;
    if (on.thread === "existing" && !saved) continue;
    let groups: Record<string, string> = {};
    if (on.match) {
      const r = new RegExp(on.match, "s").exec(m.text);
      if (!r) continue;
      groups = Object.fromEntries(Object.entries(r.groups ?? {}).map(([k, v]) => [k, v ?? ""]));
    }
    const vars = { ...saved, text: m.text, user: m.user, channel: m.channel, ts: m.ts, thread: m.thread, event: m.kind, ...groups };
    return { rule, vars };
  }
  return null;
}

export function runStep(step: Step, vars: Record<string, string>, defaultTimeoutMs = 10 * 60_000): Promise<StepResult> {
  const missing = new Set<string>();
  const argv = toArgv(step.run, vars, missing);
  if (missing.size) console.error(`slack-run: unknown variable(s) ${[...missing].join(", ")} in: ${argv.join(" ")}`);
  const env = {
    ...process.env,
    ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [`SLACK_${k.toUpperCase().replace(/\W/g, "_")}`, v])),
    ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, fill(v, vars)])),
  };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(argv[0], argv.slice(1), { cwd: step.cwd, env, stdio: [step.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => ((timedOut = true), child.kill("SIGTERM")), duration(step.timeout, defaultTimeoutMs));
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    if (step.stdin) child.stdin!.end(fill(step.stdin, vars));
    child.on("error", (e) => ((stderr += e.message), void 0));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ argv, code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut });
    });
  });
}

// Named groups (or group 1, stored under the key) of each capture regex.
export function capture(spec: Record<string, string> | undefined, stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, re] of Object.entries(spec ?? {})) {
    const m = new RegExp(re, "m").exec(stdout);
    if (!m) continue;
    if (m.groups) Object.assign(out, m.groups);
    else out[key] = m[1] ?? m[0];
  }
  return out;
}

const tail = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s);

export async function handle(config: Config, m: Message, state: ThreadState, fx: Effects): Promise<Outcome | null> {
  const found = matchRule(config, m, state);
  if (!found) return null;
  const { rule } = found;
  const vars = { ...found.vars };
  const reactions = rule.reactions ?? {};
  const react = async (key: string) => reactions[key] && (await fx.react(reactions[key]).catch(() => {}));
  await react("start");
  const steps: StepResult[] = [];
  let code = 0;
  for (const step of rule.steps) {
    const r = await runStep(step, vars);
    steps.push(r);
    const got = capture(step.capture, r.stdout);
    Object.assign(vars, got);
    state.merge(`${m.channel}:${m.thread}`, got);
    if (r.code !== 0) {
      code = r.code;
      break;
    }
  }
  const last = steps.at(-1)!;
  const reply =
    rule.reply === "none" ? null : (rule.reply === "all" ? steps.map((s) => s.stdout.trim()).join("\n\n") : last.stdout.trim()) || null;
  const error = code === 0 ? null : `\`${last.argv[0]}\` ${last.timedOut ? "timed out" : `exited ${code}`}${last.stderr.trim() ? `:\n\`\`\`${tail(last.stderr.trim(), 1500)}\`\`\`` : ""}`;
  if (reply) await fx.post(reply);
  if (error && (rule.errors ?? "post") === "post") await fx.post(error);
  await react(code === 0 ? "done" : reactions[`exit${code}`] ? `exit${code}` : "error");
  return { rule: rule.name, steps, code, reply, error };
}
