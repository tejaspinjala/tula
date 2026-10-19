#!/usr/bin/env bun
// Human approval CLI.  bun engine/bin/approve.ts list | approve <id> | deny <id>
import { list, approve, deny } from '../lib/approvals.ts';

if (import.meta.main) {
  const [cmd, id] = process.argv.slice(2);
  if (cmd === 'list' || !cmd) {
    const items = list();
    if (!items.length) console.log('no pending approvals');
    for (const i of items) console.log(`${i.id}  [${i.by}]  ${i.tool}  ${i.summary}`);
  } else if (cmd === 'approve' && id) {
    console.log(approve(id) ? `approved ${id} (valid for exactly one execution)` : `no pending ${id}`);
  } else if (cmd === 'deny' && id) {
    console.log(deny(id) ? `denied ${id}` : `no pending ${id}`);
  } else {
    console.error('usage: approve.ts list | approve <id> | deny <id>');
    process.exit(2);
  }
}
