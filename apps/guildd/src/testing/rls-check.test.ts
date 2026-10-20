import { afterAll, expect, test } from 'bun:test'
import { createHarness } from './harness'
import { findTenancyViolations } from './rls-check'
import { withScratchSchema } from './test-db'

const harness = await createHarness()
afterAll(() => harness.close())

test('the migrated schema has no tenancy violations', async () => {
  expect(await findTenancyViolations(harness.owner, { schemas: ['public'] })).toEqual([])
})

test('flags a permissive policy, a nullable guild_id, and a table owned by the app role', async () => {
  await withScratchSchema(async (o, f) => {
    await o.unsafe(`
      create table ${f}.leaky (id int, guild_id uuid);
      alter table ${f}.leaky enable row level security;
      alter table ${f}.leaky force row level security;
      create policy p on ${f}.leaky using (true);
      create table ${f}.owned (guild_id uuid not null);
      alter table ${f}.owned owner to guildhall_app;`)
    const found = (await findTenancyViolations(o, { schemas: [f] })).join('\n')
    expect(found).toContain(`${f}.leaky: guild_id is missing or nullable`)
    expect(found).toContain(`${f}.leaky: policy p does not reference app.guild_id`)
    expect(found).toContain(`${f}.owned: owned by the app role`)
    expect(found).toContain(`${f}.owned: row level security is not enabled and forced`)
  })
})
