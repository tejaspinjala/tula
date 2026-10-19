// Path safety: every path under $FLEET_HOME (or any other root) is built with resolveInside().
// It joins only safe relative segments and refuses anything that could land outside the root:
// `..`, absolute paths, NUL bytes, backslashes, empty segments, and symlinks whose target is outside.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/** `$FLEET_HOME`, default `~/.tula-fleet`. Must be absolute. Does not create it. */
export function fleetHome(): string {
  const env = process.env.FLEET_HOME;
  const home = env && env.length > 0 ? env : path.join(os.homedir(), '.tula-fleet');
  if (home.includes('\0')) throw new PathError('FLEET_HOME contains a NUL byte');
  if (!path.isAbsolute(home)) throw new PathError(`FLEET_HOME must be an absolute path, got ${JSON.stringify(home)}`);
  return path.resolve(home);
}

function components(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (typeof seg !== 'string') throw new PathError('path segment must be a string');
    if (seg.includes('\0')) throw new PathError('path segment contains a NUL byte');
    if (seg.includes('\\')) throw new PathError(`path segment contains a backslash: ${JSON.stringify(seg)}`);
    if (seg.startsWith('/') || path.isAbsolute(seg) || /^[A-Za-z]:/.test(seg)) {
      throw new PathError(`absolute path segment not allowed: ${JSON.stringify(seg)}`);
    }
    for (const part of seg.split('/')) {
      if (part === '' || part === '.' || part === '..') {
        throw new PathError(`unsafe path component ${JSON.stringify(part)} in ${JSON.stringify(seg)}`);
      }
      out.push(part);
    }
  }
  if (out.length === 0) throw new PathError('at least one path segment is required');
  return out;
}

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Joins `segments` under `root` and returns the absolute path (rooted at realpath(root)).
 * Each segment may contain `/` for nesting. Every existing component along the way is lstat'ed;
 * a symlink is followed with realpath and must stay inside the root (dangling symlinks are refused).
 * Components that do not exist yet are fine: they can only be created inside the checked parent.
 * Not a guard against a concurrent attacker swapping a directory for a symlink after the check (TOCTOU).
 */
export function resolveInside(root: string, ...segments: string[]): string {
  if (typeof root !== 'string' || root.includes('\0')) throw new PathError('invalid root');
  if (!path.isAbsolute(root)) throw new PathError(`root must be absolute, got ${JSON.stringify(root)}`);
  const parts = components(segments);
  const realRoot = realOrResolved(root);
  let cur = realRoot;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      // Missing from here on: nothing below can be a symlink yet.
      return path.join(realRoot, ...parts);
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(cur);
      } catch {
        throw new PathError(`dangling symlink at ${cur}`);
      }
      if (!inside(realRoot, target)) throw new PathError(`symlink escapes root: ${cur} -> ${target}`);
      cur = target;
    }
  }
  return path.join(realRoot, ...parts);
}

/** resolveInside(fleetHome(), ...segments). */
export const fleetPath = (...segments: string[]): string => resolveInside(fleetHome(), ...segments);
