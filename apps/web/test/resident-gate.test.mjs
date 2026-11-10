import assert from 'node:assert/strict'
import test from 'node:test'
import { decideResidentGate } from '../src/components/auth/residentGate.ts'

test('private route is hidden while session loads and on network failure', () => {
  assert.equal(decideResidentGate('loading', false), 'loading')
  assert.equal(decideResidentGate('loading', true), 'loading')
  assert.equal(decideResidentGate('error', false), 'error')
  assert.equal(decideResidentGate('error', true), 'error')
})

test('only a confirmed authenticated session can render private content', () => {
  assert.equal(decideResidentGate('authenticated', true), 'allow')
  assert.equal(decideResidentGate('authenticated', false), 'login')
  assert.equal(decideResidentGate('unauthenticated', false), 'login')
  assert.equal(decideResidentGate('unauthenticated', true), 'login')
})
