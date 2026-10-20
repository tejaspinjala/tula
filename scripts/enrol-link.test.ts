import { expect, test } from 'bun:test'
import { enrolEnvironment } from './enrol-link'

const source = {
  DATABASE_URL: 'postgres://guildhall:guildhall@localhost:5432/guildhall',
  APP_DB_PASSWORD: 'app-secret',
  OBJECT_STORE_ACCESS_KEY: 'key',
  OBJECT_STORE_SECRET_KEY: 'secret',
}

test('the link takes its origin from PUBLIC_ORIGIN and needs no built web app', () => {
  const env = enrolEnvironment({ ...source, PUBLIC_ORIGIN: 'https://hall.example' }, '/repo')
  expect(env.WEBAUTHN_ORIGIN).toBe('https://hall.example')
  expect(env.WEBAUTHN_RP_ID).toBe('hall.example')
  expect('WEB_DIST' in env).toBe(false)
})

test('without PUBLIC_ORIGIN it is the local address', () => {
  const env = enrolEnvironment({ ...source, PORT: '8795' }, '/repo')
  expect(env.WEBAUTHN_ORIGIN).toBe('http://localhost:8795')
})
