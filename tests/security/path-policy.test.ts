import { mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMP, isPathAllowed, PathPolicy } from '../../src/security/index.ts';
import { cleanupDir, makeHomeTempDir, makeTempDir, writePng } from '../test-utils.ts';

describe('isPathAllowed', () => {
  it('allows paths strictly inside a root', () => {
    const root = makeTempDir('omnivision-root-');
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      expect(isPathAllowed(join(root, 'a.png'), [root])).toBe(true);
      expect(isPathAllowed(join(root, 'sub', 'a.png'), [root])).toBe(true);
    } finally {
      cleanupDir(root);
    }
  });

  it('denies the root itself (only contents count)', () => {
    const root = makeTempDir('omnivision-root-');
    try {
      expect(isPathAllowed(root, [root])).toBe(false);
    } finally {
      cleanupDir(root);
    }
  });

  it("denies '..' escapes outside the root", () => {
    const root = makeTempDir('omnivision-root-');
    try {
      const escapee = join(dirname(root), 'escape.png');
      expect(isPathAllowed(escapee, [root])).toBe(false);
    } finally {
      cleanupDir(root);
    }
  });

  it('denies prefix-collision siblings (regression: /tmp-evil vs /tmp)', () => {
    const root = resolve('/tmp');
    expect(isPathAllowed(join(root, 'nested', 'img.png'), [root])).toBe(true);
    expect(isPathAllowed(resolve('/tmp-evil'), [root])).toBe(false);
    expect(isPathAllowed(join(resolve('/tmp-evil'), 'img.png'), [root])).toBe(false);
    expect(isPathAllowed(resolve('/private/tmp-evil'), [root])).toBe(false);
  });

  it('allows a path when any of several roots matches', () => {
    const rootA = makeTempDir('omnivision-multi-a-');
    const rootB = makeTempDir('omnivision-multi-b-');
    try {
      expect(isPathAllowed(join(rootA, 'x.png'), [rootA, rootB])).toBe(true);
      expect(isPathAllowed(join(rootB, 'x.png'), [rootA, rootB])).toBe(true);
      expect(isPathAllowed(join(dirname(rootA), 'x.png'), [rootA, rootB])).toBe(false);
    } finally {
      cleanupDir(rootA);
      cleanupDir(rootB);
    }
  });
});

describe('PathPolicy', () => {
  it('allowInput honors workspace, tempDir and allowedDirs; allowOutput excludes allowedDirs', () => {
    const ws = makeHomeTempDir('omnivision-ws-'); // outside os.tmpdir()
    const extra = makeHomeTempDir('omnivision-extra-'); // outside os.tmpdir()
    try {
      const policy = new PathPolicy(ws, { allowedDirs: [extra] });
      expect(policy.allowInput(join(ws, 'shot.png'))).toBe(true);
      expect(policy.allowInput(join(extra, 'shot.png'))).toBe(true);
      expect(policy.allowInput(join(DEFAULT_TEMP, 'shot.png'))).toBe(true);
      expect(policy.allowOutput(join(ws, 'out.png'))).toBe(true);
      expect(policy.allowOutput(join(DEFAULT_TEMP, 'out.png'))).toBe(true);
      expect(policy.allowOutput(join(extra, 'out.png'))).toBe(false);
    } finally {
      cleanupDir(ws);
      cleanupDir(extra);
    }
  });

  it('defaults tempDir to os.tmpdir()', () => {
    const ws = makeHomeTempDir('omnivision-ws-');
    try {
      const policy = new PathPolicy(ws);
      expect(policy.allowInput(join(tmpdir(), 'x.png'))).toBe(true);
      // parent of the temp dir is outside every root
      expect(policy.allowInput(join(dirname(tmpdir()), 'x.png'))).toBe(false);
    } finally {
      cleanupDir(ws);
    }
  });

  it('rejectSymlink throws for real symlinks and tolerates missing/regular files', () => {
    const dir = makeTempDir('omnivision-link-');
    try {
      const target = writePng(dir, 'target.png');
      const link = join(dir, 'link.png');
      let created = true;
      try {
        symlinkSync(target, link);
      } catch {
        created = false; // platform lacks symlink permission — soft skip that part
      }
      const policy = new PathPolicy(dir);
      if (created) {
        expect(() => policy.rejectSymlink(link)).toThrow('PATH_SYMLINK_DENIED');
      }
      expect(() => policy.rejectSymlink(join(dir, 'missing.png'))).not.toThrow();
      expect(() => policy.rejectSymlink(target)).not.toThrow();
    } finally {
      cleanupDir(dir);
    }
  });

  it('normalize resolves to an absolute path', () => {
    const ws = makeTempDir('omnivision-ws-');
    try {
      const policy = new PathPolicy(ws);
      expect(policy.normalize(join(ws, 'a', '..', 'b.png'))).toBe(resolve(ws, 'b.png'));
    } finally {
      cleanupDir(ws);
    }
  });
});
