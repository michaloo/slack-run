// Commands are split into arguments first, then each argument is filled in,
// so text from Slack can never change the command's structure.

// Shell-like word splitting: whitespace separates words; single quotes are
// literal; double quotes allow \" and \; a backslash escapes the next char.
export function splitWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated ' in: ${cmd}`);
      cur += cmd.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && (cmd[j + 1] === '"' || cmd[j + 1] === "\\")) j++;
        cur += cmd[j];
      }
      if (j >= cmd.length) throw new Error(`unterminated " in: ${cmd}`);
      i = j;
      inWord = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur), (cur = ""), (inWord = false);
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

// Replaces {name} with vars[name]; unknown names become "" and are reported.
export function fill(template: string, vars: Record<string, string>, missing?: Set<string>): string {
  return template.replace(/\{([A-Za-z_][\w.]*)\}/g, (_, name: string) => {
    if (name in vars) return vars[name];
    missing?.add(name);
    return "";
  });
}

export function toArgv(run: string | string[], vars: Record<string, string>, missing?: Set<string>): string[] {
  const words = Array.isArray(run) ? run : splitWords(run);
  return words.map((w) => fill(w, vars, missing));
}
