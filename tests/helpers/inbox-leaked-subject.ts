/**
 * A thread whose STORED subject holds an agent's leaked tool-call text, the
 * way an Inbox older than the one-line subject check kept it: the owner's
 * thread msg_01M5DBNXYNG5TA0DZV6C42PYRQ showed this whole value as its title.
 *
 * The send-side check refuses such a subject now, so the line is written as
 * the old store wrote it: a normal send with a placeholder subject, then the
 * placeholder swapped for the raw value in messages.jsonl. Call it before an
 * Inbox opens the data dir (it reads the store at start).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InboxStore } from "../../packages/shared/inbox/store";
import { refuseRealDataDir } from "./real-data-dir";

export const LEAKED_SUBJECT =
  'Everything of mine waiting on you or ready to look at, in one place</subject>\n<parameter name="idempotency_key">ws-rollup-2026-10-20-a';
/** What every reader shows for it. */
export const LEAKED_SUBJECT_SHOWN = "Everything of mine waiting on you or ready to look at, in one place";

export function seedLeakedSubjects(dataDir: string, projects: { name: string; root: string }[]): string[] {
  refuseRealDataDir(dataDir, "inbox-leaked-subject.ts");
  const store = InboxStore.open(dataDir);
  const placeholders = new Map<string, string>();
  const ids = projects.map(({ name, root }, i) => {
    const project = store.ensureProject({ name, root });
    const placeholder = `leaked-subject-placeholder-${i}`;
    placeholders.set(JSON.stringify(placeholder), JSON.stringify(LEAKED_SUBJECT));
    return store.sendMessage({
      project_id: project.id,
      author: { kind: "agent", host: "claude-code", session: `ses_leak${i}`, name: "Claude Code" },
      subject: placeholder,
      body: "Here is everything of mine that waits on you, in one place.\n\n- The billing migration plan\n- Two questions on the release notes",
    }).message.id;
  });
  const projectsDir = join(store.dir, "projects");
  for (const key of readdirSync(projectsDir)) {
    const file = join(projectsDir, key, "messages.jsonl");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let next = text;
    for (const [from, to] of placeholders) next = next.split(from).join(to);
    if (next !== text) writeFileSync(file, next);
  }
  return ids;
}
