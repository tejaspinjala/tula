import { expect, test } from 'bun:test'
import { staleTestDbs } from './drop-test-dbs'

test('only per-worktree test databases other than the kept one are stale', () => {
  const names = [
    'guildhall',
    'guildhall_test',
    'guildhall_test_aaaaaaaa',
    'guildhall_test_bbbbbbbb',
    'postgres',
  ]
  expect(staleTestDbs(names, 'guildhall_test_aaaaaaaa')).toEqual(['guildhall_test_bbbbbbbb'])
})
