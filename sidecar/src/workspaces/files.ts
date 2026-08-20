/**
 * Reading and writing a single file inside a workspace repo's worktree, for the
 * editor tab. Git is not involved: the editor shows the file as it is on disk,
 * which is what the agent working in the worktree is also seeing.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/** A failure the caller can turn straight into an HTTP status. */
export class WorktreeFileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "WorktreeFileError";
  }
}

/**
 * Where a file stops being something to open in an editor. Past this it is a
 * build artifact or a data blob: sending it to the frontend costs more than the
 * editing it enables, and CodeMirror holds the whole document in memory.
 */
export const MAX_FILE_BYTES = 2_000_000;

/** How far in we look for a NUL byte before calling a file text. Matches what
 *  git itself samples when deciding whether a blob is binary. */
const BINARY_SNIFF_BYTES = 8_000;

/** Why a file came back without its contents. Null when it is editable text. */
export type FileUnreadable = "binary" | "too-large" | "encoding";

export interface WorktreeFile {
  path: string;
  /** UTF-8 text, or null when `unreadable` says why there is none. */
  content: string | null;
  unreadable: FileUnreadable | null;
  /** sha256 of the bytes on disk, handed back on save so a write that would
   *  clobber someone else's edit can be refused. Null for a file too large to
   *  have been read, which is therefore one nothing can be saved over. */
  hash: string | null;
  size: number;
}

export interface WriteResult {
  hash: string;
  size: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The absolute path a worktree-relative path names, refusing anything that
 * leaves the worktree.
 *
 * The lexical checks are not defence in depth on their own — the path is chosen
 * by whoever is driving the UI, and a `..` segment or an absolute path would
 * otherwise let the editor read and *write* any file the user's account can
 * reach. A symlink inside the worktree can point out of it just as effectively,
 * so the resolved target is what the containment check is applied to.
 */
export function resolveInWorktree(worktreePath: string, path: string): string {
  if (!path) throw new WorktreeFileError("path is required", 400);
  if (isAbsolute(path)) {
    throw new WorktreeFileError("path must be relative to the worktree", 400);
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new WorktreeFileError("path must not escape the worktree", 400);
  }
  if (CONTROL_CHARACTERS.test(path)) {
    throw new WorktreeFileError("path must not contain control characters", 400);
  }
  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    throw new WorktreeFileError("worktree not found", 404);
  }
  const full = resolve(root, path);
  // A path that doesn't exist yet is checked lexically, which is only sound
  // because nothing here creates files: `writeWorktreeFile` refuses a missing
  // one. Adding create-file support means resolving the parent instead, or a
  // symlinked parent directory becomes an escape.
  const target = existsSync(full) ? realpathSync(full) : full;
  if (target !== root && !target.startsWith(root + sep)) {
    throw new WorktreeFileError("path must not escape the worktree", 400);
  }
  /*
   * A worktree's `.git` is a regular file holding `gitdir: …`, and rewriting it
   * hands git an attacker-chosen common dir whose hooks and config run on the
   * next git command — in a worktree an agent session runs git in constantly.
   * A nested one (a submodule's) does the same for that submodule.
   *
   * Tested on the *resolved* path, not on what the caller asked for: a symlink
   * `evil -> .git` inside the worktree is a genuine path to it, and the check
   * has to see where it lands. Every segment, because only the first would miss
   * `vendor/lib/.git`; case-insensitively, because the app runs on macOS, where
   * `.GIT` opens the same file.
   */
  const inside = target === root ? "" : target.slice(root.length + 1);
  if (inside.split(sep).some((segment) => segment.toLowerCase() === ".git")) {
    throw new WorktreeFileError("path must not be inside .git", 400);
  }
  return target;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0x00);

/** Reads one file for the editor. Oversized, binary, and non-UTF-8 files come
 *  back described rather than as an error, so the tab can say what it is
 *  holding. */
export function readWorktreeFile(worktreePath: string, path: string): WorktreeFile {
  const full = resolveInWorktree(worktreePath, path);
  let stat: Stats;
  try {
    stat = statSync(full);
  } catch {
    throw new WorktreeFileError("file not found", 404);
  }
  if (stat.isDirectory()) throw new WorktreeFileError("path is a directory", 400);
  if (!stat.isFile()) throw new WorktreeFileError("path is not a regular file", 400);

  if (stat.size > MAX_FILE_BYTES) {
    // Hashing an oversized file would mean reading all of it — the cost the cap
    // exists to avoid. Nothing can be saved back over it, so no hash is owed.
    return { path, content: null, unreadable: "too-large", hash: null, size: stat.size };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(full);
  } catch {
    // Deliberately not the underlying message: it carries the absolute path.
    throw new WorktreeFileError("file could not be read", 400);
  }
  const hash = sha256(bytes);
  const described = (unreadable: FileUnreadable): WorktreeFile => ({
    path,
    content: null,
    unreadable,
    hash,
    size: bytes.length,
  });
  if (isBinary(bytes)) return described("binary");

  // Decoding is lossy for anything that isn't UTF-8 — a Latin-1 byte becomes
  // U+FFFD, and saving would write that replacement back over every such byte in
  // the file. Re-encoding is how we tell an exact round-trip from a lossy one.
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) return described("encoding");

  return { path, content, unreadable: null, hash, size: bytes.length };
}

/**
 * Writes an edited file back, refusing the write when the file on disk is no
 * longer what was read. The worktree is shared with an agent session that
 * rewrites files as it works, so a save whose base is stale would silently drop
 * whatever it did — the caller re-reads and merges instead.
 *
 * Everything after the path is resolved goes through a single file descriptor:
 * re-opening by path between the hash check and the write would let the leaf be
 * swapped for a symlink pointing anywhere. Written in place rather than through
 * a temp file and a rename, which would replace the inode and so lose the file's
 * mode.
 *
 * That in-place write is also why a hard-linked file is refused. Containment is
 * established for the *path*, and a second link to the same inode from outside
 * the worktree means the bytes are not where the path says they are. Git cannot
 * store hard links, so nothing checked out is one.
 */
export function writeWorktreeFile(
  worktreePath: string,
  path: string,
  content: string,
  expectedHash: string,
): WriteResult {
  const full = resolveInWorktree(worktreePath, path);
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new WorktreeFileError("file is too large to save", 400);
  }

  let fd: number;
  try {
    fd = openSync(full, "r+");
  } catch {
    // "r+" never creates: a missing file is a missing file, not a new one.
    throw new WorktreeFileError("file not found", 404);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new WorktreeFileError("path is not a regular file", 400);
    if (stat.nlink !== 1) throw new WorktreeFileError("file has more than one link", 400);
    if (stat.size > MAX_FILE_BYTES) throw new WorktreeFileError("file is too large to edit", 400);

    const current = Buffer.alloc(stat.size);
    const read = readSync(fd, current, 0, stat.size, 0);
    if (read !== stat.size) throw new WorktreeFileError("file could not be read in full", 400);
    if (sha256(current) !== expectedHash) {
      throw new WorktreeFileError("file changed on disk since it was opened", 409);
    }

    ftruncateSync(fd, 0);
    // A short write would leave the file truncated to whatever landed, so it is
    // reported rather than answered with a hash for bytes that aren't there.
    const written = writeSync(fd, bytes, 0, bytes.length, 0);
    if (written !== bytes.length) {
      throw new WorktreeFileError("file could not be written in full", 400);
    }
  } finally {
    closeSync(fd);
  }
  return { hash: sha256(bytes), size: bytes.length };
}
