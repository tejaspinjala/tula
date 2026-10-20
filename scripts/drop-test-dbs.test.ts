import { expect, test } from 'bun:test'
import { staleTestDbs } from './drop-test-dbs'

test('another project, the shared database and unsafe names are never stale', () => {
  const own = 'guildhall_test_dddddddd'
  const names = [
    'guildhall_test_aaaaaaaa',
    'shop_test_bbbbbbbb',
    'guildhall_test',
    'a"_test_cccccccc',
  ]
  expect(staleTestDbs(names, own)).toEqual(['guildhall_test_aaaaaaaa'])
})

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
