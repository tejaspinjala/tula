import { afterAll, expect, test } from 'bun:test'
import { createHarness } from './harness'
import { findTenancyViolations } from './rls-check'

const harness = await createHarness()
afterAll(() => harness.close())

test('the migrated schema has no tenancy violations', async () => {
  expect(await findTenancyViolations(harness.owner)).toEqual([])
})

test('flags a permissive policy, a nullable guild_id, and a table owned by the app role', async () => {
  const o = harness.owner
  await o.unsafe(`
    create schema fixture;
    create table fixture.leaky (id int, guild_id uuid);
    alter table fixture.leaky enable row level security;
    alter table fixture.leaky force row level security;
    create policy p on fixture.leaky using (true);
    create table fixture.owned (guild_id uuid not null);
    alter table fixture.owned owner to guildhall_app;`)
  try {
    const found = (await findTenancyViolations(o)).join('\n')
    expect(found).toContain('fixture.leaky: guild_id is missing or nullable')
    expect(found).toContain('fixture.leaky: policy p does not reference app.guild_id')
    expect(found).toContain('fixture.owned: owned by the app role')
    expect(found).toContain('fixture.owned: row level security is not enabled and forced')
  } finally {
    await o.unsafe('drop schema fixture cascade')
  }
})
