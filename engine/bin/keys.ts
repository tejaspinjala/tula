#!/usr/bin/env bun
// fleet keys.  bun engine/bin/keys.ts init
import { resolveHome } from '../home/home.ts';
import { keysInit } from '../home/keys.ts';

if (import.meta.main) {
  if (process.argv[2] !== 'init') {
    console.error('usage: keys.ts init');
    process.exit(2);
  }
  const r = keysInit({ home: resolveHome() });
  if (r.status === 'not_installed') {
    console.error(r.message);
    process.exit(1);
  }
  console.log(`${r.status === 'created' ? 'created' : 'already exists'}: ${r.identityPath}\nrecipient: ${r.recipient}`);
}
