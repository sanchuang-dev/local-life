import { useEffect, useState } from 'react'
import type { AdminCrmFilterOptionsResponse } from '@sanchuang-dev/local-life-contracts'
import { getAdminCrmFilterOptions } from '../services/crm'
import { describeLocalError } from '../services/localApi'

/** Structural shape of `authCommunitySchema`; only the fields rendered are used. */
export interface AdminCommunityRef {
  id: string
  name: string
}

export interface AdminStaffRef {
  id: string
  displayName: string | null
  role: string
}

export interface StaffOption {
  label: string
  value: string
}

/**
 * Communities and staff the server is willing to show the current actor.
 *
 * `/admin/crm/filter-options` is the one existing read that returns both lists
 * already scoped by role, so the ledger, overview and order screens share it
 * instead of each building a permission list from the session.
 */
export function useAdminFilterOptions() {
  const [communities, setCommunities] = useState<readonly AdminCommunityRef[]>([])
  const [staff, setStaff] = useState<readonly AdminStaffRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setError(null)
    getAdminCrmFilterOptions(controller.signal)
      .then((options: AdminCrmFilterOptionsResponse) => {
        if (!active) return
        setCommunities(options.communities)
        setStaff(options.staff)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setCommunities([])
        setStaff([])
        setError(describeLocalError(cause, '无法读取社区与网格员列表'))
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [token])

  return {
    communities,
    staff,
    error,
    retry: () => setToken((value) => value + 1),
  }
}

export function communityOptionsOf(
  communities: readonly AdminCommunityRef[],
): { label: string; value: string }[] {
  return communities.map((item) => ({ label: item.name, value: item.id }))
}

export function staffOptionsOf(staff: readonly AdminStaffRef[]): StaffOption[] {
  return staff.map((item) => ({
    label: `${item.displayName?.trim() || item.id.slice(0, 8)}（${
      item.role === 'grid_worker' ? '网格员' : item.role === 'operator' ? '运营员' : '管理员'
    }）`,
    value: item.id,
  }))
}

/** Grid workers are the only valid target of a 业绩归属 confirmation. */
export function gridStaffOptionsOf(staff: readonly AdminStaffRef[]): StaffOption[] {
  return staffOptionsOf(staff.filter((person) => person.role === 'grid_worker'))
}
