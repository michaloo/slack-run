// Values captured per Slack thread (e.g. an agent id), so follow-ups in the
// thread can reuse them. A small JSON file, written atomically.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export class ThreadState {
  private data: Record<string, Record<string, string>>;
  private path: string | null;

  constructor(path: string | null) {
    this.path = path;
    this.data = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  get(thread: string): Record<string, string> | undefined {
    return this.data[thread];
  }

  merge(thread: string, values: Record<string, string>) {
    if (!Object.keys(values).length) return;
    this.data[thread] = { ...this.data[thread], ...values };
    if (!this.path) return;
    writeFileSync(this.path + ".tmp", JSON.stringify(this.data, null, 2));
    renameSync(this.path + ".tmp", this.path);
  }
}
