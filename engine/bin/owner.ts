#!/usr/bin/env bun
// Owner CLI (stub). Not reachable by agents: it writes the owner-confirmation chain.
//   bun engine/bin/owner.ts init
//   bun engine/bin/owner.ts confirm-private-provider <id> --typed <id>
import { initHome, resolveHome } from '../home/home.ts';
import { confirmPrivateProvider } from '../home/private-eligible.ts';

if (import.meta.main) {
  const [cmd, id, flag, typed] = process.argv.slice(2);
  if (cmd === 'init') {
    const r = initHome();
    console.log(`home ready: ${r.home}${r.gitInitialized ? ' (git initialised)' : ''}`);
  } else if (cmd === 'confirm-private-provider' && id) {
    if (flag !== '--typed' || typed !== id) {
      console.error(`This lets provider '${id}' receive PRIVATE data, which breaks C13 (Claude Max + loopback only).\nType the provider id to confirm: owner.ts confirm-private-provider ${id} --typed ${id}`);
      process.exit(2);
    }
    const e = await confirmPrivateProvider(id, { home: resolveHome() });
    console.log(`confirmed '${id}' (chain seq ${e.seq})`);
  } else {
    console.error('usage: owner.ts init | confirm-private-provider <id> --typed <id>');
    process.exit(2);
  }
}
