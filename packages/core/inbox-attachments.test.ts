import { describe, expect, test } from 'bun:test';
import { inboxAttachmentKind, inboxAttachmentKindLabel, inboxAttachmentNameRefusal, isInboxTextBytes } from './inbox-attachments';

describe('Inbox attachment names and kinds', () => {
  test('source code and scripts are accepted as kind code', () => {
    for (const name of ['app.ts', 'run.sh', 'View.swift', 'build.mjs', 'main.py', 'lib.rs', 'Makefile', 'Dockerfile']) {
      expect(inboxAttachmentNameRefusal(`/repo/${name}`), name).toBeNull();
      expect(inboxAttachmentKind(`/repo/${name}`), name).toBe('code');
    }
  });

  test('a name both sets know keeps its existing kind', () => {
    expect(inboxAttachmentKind('/repo/package.json')).toBe('text');
    expect(inboxAttachmentKind('/repo/ci.yaml')).toBe('text');
    expect(inboxAttachmentKind('/repo/notes.md')).toBe('markdown');
    expect(inboxAttachmentKind('/repo/page.html')).toBe('html');
    expect(inboxAttachmentKind('/repo/flow.mmd')).toBe('mermaid');
  });

  test('.env and unknown types stay refused', () => {
    expect(inboxAttachmentNameRefusal('/repo/.env')).toContain('.env');
    // The dotenv family under a code name is refused too; the .env.example doc is not.
    expect(inboxAttachmentNameRefusal('/repo/.env.ts')).toContain('never attached');
    expect(inboxAttachmentNameRefusal('/repo/.env.local.sh')).toContain('never attached');
    expect(inboxAttachmentNameRefusal('/repo/.ENV.Production.py')).toContain('never attached');
    expect(inboxAttachmentNameRefusal('/repo/.env.example')).toBeNull();
    expect(inboxAttachmentNameRefusal('/repo/logo.png')).not.toBeNull();
    expect(inboxAttachmentNameRefusal('/repo/app.exe')).not.toBeNull();
  });

  test('the tile names a code file by its extension, or its name when it has none', () => {
    expect(inboxAttachmentKindLabel('code', 'app.TS')).toContain('.ts');
    expect(inboxAttachmentKindLabel('code', 'Makefile')).toContain('Makefile');
  });

  test('text bytes: UTF-8 without NUL passes; NUL or invalid UTF-8 does not', () => {
    expect(isInboxTextBytes(new TextEncoder().encode('echo "héllo"\n'))).toBe(true);
    expect(isInboxTextBytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))).toBe(false);
    expect(isInboxTextBytes(new Uint8Array([0x66, 0xff, 0xfe, 0x67]))).toBe(false);
    expect(isInboxTextBytes(new Uint8Array())).toBe(true);
  });
});
