import assert from 'node:assert/strict'
import test from 'node:test'
import { residentProfileViewState } from '../src/components/profile/profileViewModel.ts'

const base = {
  loading: false,
  saving: false,
  error: null,
  hasProfile: true,
  phoneStatusKnown: true,
  phoneConfigured: true,
  maskedPhone: null,
  changingPhone: false,
}

test('resident profile view exposes honest loading/error/save states', () => {
  assert.deepEqual(
    residentProfileViewState({ ...base, loading: true, hasProfile: false }),
    { status: 'loading', phoneMode: 'bind', saveDisabled: true },
  )
  assert.deepEqual(
    residentProfileViewState({ ...base, error: '读取失败', hasProfile: false }),
    { status: 'error', phoneMode: 'bind', saveDisabled: true },
  )
  assert.equal(residentProfileViewState({ ...base, saving: true }).saveDisabled, true)
  assert.equal(residentProfileViewState(base).saveDisabled, false)
})

test('resident profile phone mode never pretends an unverified phone is bound', () => {
  assert.equal(residentProfileViewState(base).phoneMode, 'bind')
  assert.equal(
    residentProfileViewState({ ...base, phoneStatusKnown: false }).phoneMode,
    'unknown',
  )
  assert.equal(
    residentProfileViewState({ ...base, phoneConfigured: false }).phoneMode,
    'unavailable',
  )
  assert.equal(
    residentProfileViewState({ ...base, maskedPhone: '138****8000' }).phoneMode,
    'bound',
  )
  assert.equal(
    residentProfileViewState({ ...base, maskedPhone: '138****8000', changingPhone: true }).phoneMode,
    'change',
  )
})
