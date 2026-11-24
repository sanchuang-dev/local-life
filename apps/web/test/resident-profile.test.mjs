import assert from 'node:assert/strict'
import test from 'node:test'
import { residentProfileViewState } from '../src/components/profile/profileViewModel.ts'

const base = { loading: false, saving: false, error: null, hasProfile: true }

test('resident profile exposes honest loading/error/save states independently of SMS', () => {
  assert.deepEqual(residentProfileViewState({ ...base, loading: true, hasProfile: false }), { status: 'loading', saveDisabled: true })
  assert.deepEqual(residentProfileViewState({ ...base, error: '读取失败', hasProfile: false }), { status: 'error', saveDisabled: true })
  assert.equal(residentProfileViewState({ ...base, saving: true }).saveDisabled, true)
  assert.equal(residentProfileViewState(base).saveDisabled, false)
})
