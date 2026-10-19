#!/usr/bin/env bun
// Regenerates company.example/ (the starter templates imported into a fresh home) or, with --check, verifies it.
//   bun scripts/build-example.ts [--check]
import fs from 'node:fs';
import path from 'node:path';
import { buildExampleTree } from '../engine/template/example.ts';
import { readTree, writeTree } from '../engine/template/tree.ts';

const dir = path.resolve(import.meta.dir, '..', 'company.example');
const want = await buildExampleTree();
if (process.argv.includes('--check')) {
  const have = fs.existsSync(dir) ? readTree(dir) : {};
  const keys = new Set([...Object.keys(have), ...Object.keys(want)]);
  const bad = [...keys].filter((k) => have[k] !== want[k]);
  if (bad.length) {
    console.error(`company.example is out of date (${bad.length} file(s), e.g. ${bad[0]}). Run: bun run example:build`);
    process.exit(1);
  }
  console.log('company.example up to date');
} else {
  fs.rmSync(dir, { recursive: true, force: true });
  writeTree(dir, want);
  console.log(`wrote ${Object.keys(want).length} files to company.example`);
}
