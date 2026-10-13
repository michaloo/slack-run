// YAML config: Slack tokens and rules. ${ENV} references are expanded.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Step = {
  run: string | string[];
  capture?: Record<string, string>;
  timeout?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
};

export type Rule = {
  name: string;
  on: {
    event?: "mention" | "message" | "dm" | "any";
    channels?: string[];
    users?: string[];
    anyone?: boolean;
    match?: string;
    thread?: "new" | "existing" | "any";
  };
  steps: Step[];
  reply?: "last-step" | "all" | "none";
  errors?: "post" | "react";
  reactions?: Record<string, string>;
};

export type Config = {
  slack: { appToken: string; botToken: string };
  state?: string;
  rules: Rule[];
};

const expand = (v: unknown): unknown => {
  if (typeof v === "string") return v.replace(/\$\{(\w+)\}/g, (_, n: string) => process.env[n] ?? "");
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
};

export function parseConfig(text: string, { requireTokens = true } = {}): Config {
  const c = expand(parse(text)) as Config;
  const errors: string[] = [];
  if (requireTokens) {
    if (!c?.slack?.appToken?.startsWith("xapp-")) errors.push("slack.appToken must be an app-level token (xapp-…) with connections:write");
    if (!c?.slack?.botToken?.startsWith("xoxb-")) errors.push("slack.botToken must be a bot token (xoxb-…)");
  }
  if (!Array.isArray(c?.rules) || !c.rules.length) errors.push("rules: at least one rule is needed");
  for (const [i, r] of (c?.rules ?? []).entries()) {
    const at = `rules[${i}]${r?.name ? ` (${r.name})` : ""}`;
    if (!r?.name) errors.push(`${at}: name is required`);
    if (!r?.on) errors.push(`${at}: on is required`);
    else {
      // Commands run on this machine: say explicitly who may trigger them.
      if (!r.on.users?.length && !r.on.anyone) errors.push(`${at}: list on.users, or set on.anyone: true`);
      if (r.on.match) {
        try {
          new RegExp(r.on.match);
        } catch (e) {
          errors.push(`${at}: on.match: ${(e as Error).message}`);
        }
      }
    }
    if (!Array.isArray(r?.steps) || !r.steps.length) errors.push(`${at}: steps needs at least one step`);
    for (const [j, s] of (r?.steps ?? []).entries()) {
      if (!s?.run) errors.push(`${at}.steps[${j}]: run is required`);
      for (const [k, re] of Object.entries(s?.capture ?? {})) {
        try {
          new RegExp(re, "m");
        } catch (e) {
          errors.push(`${at}.steps[${j}].capture.${k}: ${(e as Error).message}`);
        }
      }
    }
  }
  if (errors.length) throw new Error(`invalid config:\n  ${errors.join("\n  ")}`);
  return c;
}

export const loadConfig = (path: string, opts?: { requireTokens?: boolean }) => parseConfig(readFileSync(path, "utf8"), opts);

export function duration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
  if (!m) throw new Error(`invalid duration "${s}" (e.g. 30s, 10m, 2h)`);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[m[2] as "ms" | "s" | "m" | "h"];
}
