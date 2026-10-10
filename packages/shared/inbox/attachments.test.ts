/**
 * recordInboxAttachments on real files in a temp folder: code files are taken
 * as kind `code`, and the refusals (binary bytes, `.env` by name or target,
 * outside the project) refuse the whole send before any blob is written.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxBlobPath, inboxBlobsDir, recordInboxAttachments } from "./attachments";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-attach-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(join(project, "scripts"), { recursive: true });
  const inbox = join(root, "data", "inbox");
  return { root, project, inbox, at: "2026-10-10T00:00:00.000Z" };
}

function record(w: ReturnType<typeof world>, paths: unknown[]) {
  return recordInboxAttachments(w.inbox, paths, { base: w.project, projectRoot: w.project, at: w.at });
}

test("code and script files are recorded as kind code, with the sent bytes in a blob", () => {
  const w = world();
  const files: Record<string, string> = {
    "scripts/run.sh": "#!/bin/sh\n# retry the webhook\necho ok\n",
    "src.ts": "export const x = 1;\n",
    "App.swift": "import SwiftUI\n",
    "build.mjs": "export default {};\n",
    "Makefile": "all:\n\techo hi\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(w.project, name), text);
  const recorded = record(w, Object.keys(files));
  expect(recorded.map((a) => a.kind)).toEqual(["code", "code", "code", "code", "code"]);
  for (const attachment of recorded) {
    expect(readFileSync(inboxBlobPath(w.inbox, attachment.sent_sha256), "utf8")).toBe(files[attachment.path.slice(w.project.length + 1)]!);
  }
});

test("a code file whose bytes are not text is refused, and nothing of the send is written", () => {
  const w = world();
  writeFileSync(join(w.project, "notes.md"), "# Notes\n");
  writeFileSync(join(w.project, "tool.sh"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0x00]));
  writeFileSync(join(w.project, "latin.py"), new Uint8Array([0x23, 0x20, 0xe9, 0x0a]));
  expect(() => record(w, ["notes.md", "tool.sh"])).toThrow(/attachments\[1\]: tool\.sh: not UTF-8 text/);
  expect(() => record(w, ["latin.py"])).toThrow(/latin\.py: not UTF-8 text/);
  expect(existsSync(inboxBlobsDir(w.inbox)) ? readdirSync(inboxBlobsDir(w.inbox)) : []).toEqual([]);
});

test(".env is refused by name and through a symlink with a code name; outside the project is refused", () => {
  const w = world();
  writeFileSync(join(w.project, ".env"), "SECRET=1\n");
  symlinkSync(join(w.project, ".env"), join(w.project, "load.sh"));
  writeFileSync(join(w.root, "outside.ts"), "export {};\n");
  expect(() => record(w, [".env"])).toThrow(/\.env files are never attached/);
  expect(() => record(w, ["load.sh"])).toThrow(/load\.sh resolves to \.env/);
  writeFileSync(join(w.project, ".env.ts"), "export const KEY = 'secret';\n");
  writeFileSync(join(w.project, ".env.example"), "KEY=\n");
  expect(() => record(w, [".env.ts"])).toThrow(/\.env\.ts: \.env files are never attached/);
  expect(record(w, [".env.example"])[0]?.kind).toBe("text");
  expect(() => record(w, [join(w.root, "outside.ts")])).toThrow(/outside the project/);
});
