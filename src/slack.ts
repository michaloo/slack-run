// Slack side: Socket Mode (an outbound WebSocket, no public URL needed) for
// events, the Web API for reactions and replies.
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { Config } from "./config.ts";
import { handle, type Message } from "./engine.ts";
import type { ThreadState } from "./state.ts";

const MAX_POST = 3500;

export function chunks(text: string, size = MAX_POST): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    // Prefer breaking at a newline.
    const cut = rest.lastIndexOf("\n", size) > size / 2 ? rest.lastIndexOf("\n", size) : size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

type SlackEvent = {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
};

// Turns a Slack event into a Message, or null for ones to ignore (bots, edits,
// and channel messages that are mentions, which arrive as app_mention too).
export function toMessage(e: SlackEvent, botUser: string): Message | null {
  if (e.bot_id || e.subtype || !e.user || e.user === botUser) return null;
  const mention = `<@${botUser}>`;
  const kind: Message["kind"] = e.type === "app_mention" ? "mention" : e.channel_type === "im" ? "dm" : "message";
  if (kind === "message" && e.text?.includes(mention)) return null;
  const text = (e.text ?? "").replaceAll(mention, "").trim();
  return { kind, text, user: e.user, channel: e.channel, ts: e.ts, thread: e.thread_ts ?? e.ts };
}

export async function serve(config: Config, state: ThreadState, log: (s: string) => void) {
  const web = new WebClient(config.slack.botToken);
  const auth = await web.auth.test();
  const botUser = auth.user_id as string;
  log(`connected to ${auth.team} as @${auth.user}`);
  const sm = new SocketModeClient({ appToken: config.slack.appToken });
  const seen = new Set<string>();
  const threads = new Map<string, Promise<unknown>>();

  const onEvent = async ({ event, body, ack }: { event: SlackEvent; body: { event_id?: string }; ack: () => Promise<void> }) => {
    await ack();
    // Slack retries deliveries it thinks failed.
    if (body.event_id) {
      if (seen.has(body.event_id)) return;
      seen.add(body.event_id);
      if (seen.size > 2000) seen.delete(seen.values().next().value!);
    }
    const m = toMessage(event, botUser);
    if (!m) return;
    const key = `${m.channel}:${m.thread}`;
    // One run at a time per thread, in arrival order.
    const run = (threads.get(key) ?? Promise.resolve()).then(() =>
      handle(config, m, state, {
        react: async (name) => void (await web.reactions.add({ channel: m.channel, timestamp: m.ts, name })),
        post: async (text) => {
          for (const part of chunks(text)) await web.chat.postMessage({ channel: m.channel, thread_ts: m.thread, text: part });
        },
      })
        .then((o) => o && log(`${o.rule}: ${m.channel}/${m.thread} -> exit ${o.code}`))
        .catch((e) => log(`error handling ${key}: ${e instanceof Error ? e.stack : e}`)),
    );
    threads.set(key, run);
    void run.finally(() => threads.get(key) === run && threads.delete(key));
  };

  sm.on("app_mention", onEvent);
  sm.on("message", onEvent);
  await sm.start();
  return sm;
}
