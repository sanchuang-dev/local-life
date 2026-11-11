// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  communityCellEntries,
  confirmedCommunityAbsenceText,
  describeBindingSource,
  describeCommunityRelation,
  formatBackOfficeDate,
  residentStateBadge,
  residentStateUnavailableReason,
} from './resident-community-view'

/**
 * #171 LL-IDENTITY-001: the back office must never read a historical relation as
 * a confirmed permanent community, must never read a withheld (out-of-scope)
 * confirmation as 「未关联」, and must not invent a state the server abstained
 * from. These are copy/behaviour assertions on the single presentation module the
 * users page uses — not "it renders without crashing".
 */

const CONFIRMED = {
  id: '3b16253c-cd91-437f-86b1-8bf553129d12',
  name: '梧桐里社区',
  confirmedAt: '2026-11-11T02:00:00.000Z',
}

const HISTORY = [{ id: '7c1f0f2a-5b3d-4e6f-8a90-0b1c2d3e4f50', name: '柳岸花城社区' }]

describe('describeCommunityRelation', () => {
  it('labels confirmed_binding as confirmed and names the community and time', () => {
    const relation = describeCommunityRelation({
      communityRelationSource: 'confirmed_binding',
      confirmedCommunity: CONFIRMED,
      residentCommunities: [],
    })
    expect(relation.label).toBe('已确认常驻')
    expect(relation.tone).toBe('success')
    expect(relation.detail).toContain('梧桐里社区')
    expect(relation.detail).toContain('本人确认')
  })

  it('labels historical_assignment as unconfirmed and never claims a confirmation', () => {
    const relation = describeCommunityRelation({
      communityRelationSource: 'historical_assignment',
      confirmedCommunity: null,
      residentCommunities: HISTORY,
    })
    expect(relation.label).toBe('历史归属（未确认）')
    expect(relation.tone).toBe('warning')
    // Hard rule: no wording that could be read as a confirmed permanent community.
    expect(relation.label).not.toContain('已确认常驻')
    expect(relation.detail).not.toContain('已确认常驻')
    expect(relation.detail).toContain('尚未确认常驻社区')
    expect(relation.detail).toContain('不能作为常驻社区')
    // The two sources must not share one label.
    expect(relation.label).not.toBe(
      describeCommunityRelation({
        communityRelationSource: 'confirmed_binding',
        confirmedCommunity: CONFIRMED,
      }).label,
    )
  })

  it('reports out_of_scope as withheld instead of 未关联社区', () => {
    const relation = describeCommunityRelation({
      communityRelationSource: 'out_of_scope',
      confirmedCommunity: null,
      residentCommunities: [],
    })
    expect(relation.label).toBe('授权范围外已确认')
    expect(relation.label).not.toContain('未关联')
    expect(relation.detail).toContain('不代表「未关联社区」')
  })

  it('reports none as 未关联社区 and keeps it distinct from out_of_scope', () => {
    const relation = describeCommunityRelation({
      communityRelationSource: 'none',
      confirmedCommunity: null,
      residentCommunities: [],
    })
    expect(relation.label).toBe('未关联社区')
    expect(relation.label).not.toBe(
      describeCommunityRelation({ communityRelationSource: 'out_of_scope' }).label,
    )
  })

  it('does not guess when the payload omits communityRelationSource', () => {
    const relation = describeCommunityRelation({})
    expect(relation.label).toBe('归属状态未知')
    expect(relation.label).not.toContain('未关联')
    expect(relation.detail).toContain('不据此推断')
  })
})

describe('confirmedCommunityAbsenceText', () => {
  it('keeps the four absence reasons apart', () => {
    const labels = [
      confirmedCommunityAbsenceText({ communityRelationSource: 'confirmed_binding' }),
      confirmedCommunityAbsenceText({ communityRelationSource: 'historical_assignment' }),
      confirmedCommunityAbsenceText({ communityRelationSource: 'out_of_scope' }),
      confirmedCommunityAbsenceText({ communityRelationSource: 'none' }),
    ]
    expect(new Set(labels).size).toBe(labels.length)
    // Only the historical absence may mention history, and it must deny it.
    expect(labels[1]).toContain('历史归属')
    expect(labels[1]).not.toContain('已确认常驻社区')
    // The historical absence must never be phrased as a confirmed community.
    expect(labels[1]).toContain('尚未确认')
  })
})

describe('communityCellEntries', () => {
  it('puts the confirmed community first and marks history separately', () => {
    const entries = communityCellEntries({
      confirmedCommunity: CONFIRMED,
      communityRelationSource: 'confirmed_binding',
      residentCommunities: HISTORY,
    } as never)
    expect(entries.map((community) => community.kind)).toEqual(['confirmed', 'historical'])
    expect(entries[0]!.id).toBe(CONFIRMED.id)
  })

  it('never promotes a historical relation even when nothing is confirmed', () => {
    const entries = communityCellEntries({
      confirmedCommunity: null,
      communityRelationSource: 'historical_assignment',
      residentCommunities: HISTORY,
    } as never)
    expect(entries.every((community) => community.kind === 'historical')).toBe(true)
  })

  it('does not duplicate a community that appears in both facts', () => {
    const entries = communityCellEntries({
      confirmedCommunity: CONFIRMED,
      communityRelationSource: 'confirmed_binding',
      residentCommunities: [{ id: CONFIRMED.id, name: CONFIRMED.name }],
    } as never)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('confirmed')
  })
})

describe('residentStateBadge', () => {
  it('maps the four resident states to four distinct labels', () => {
    const labels = (['confirmed', 'unbound', 'pending_review', 'conflict'] as const).map(
      (state) => residentStateBadge(state)?.label,
    )
    expect(labels).toEqual(['已确认常驻社区', '待绑定', '历史待核查', '常驻社区冲突'])
    expect(new Set(labels).size).toBe(4)
  })

  it('marks pending_review as history awaiting review without offering a choice', () => {
    const badge = residentStateBadge('pending_review')!
    expect(badge.label).toBe('历史待核查')
    expect(badge.hint).toContain('不视为已确认常驻社区')
    expect(badge.hint).toContain('后台不能代选')
  })

  it('returns null for an abstained state and never labels it 待绑定', () => {
    expect(residentStateBadge(null)).toBeNull()
    expect(residentStateBadge(undefined)).toBeNull()
    expect(residentStateUnavailableReason(null)).toContain('不会据此推断为未绑定')
    expect(residentStateUnavailableReason(undefined)).toContain('不据此推断')
    expect(residentStateUnavailableReason('confirmed')).toBeNull()
  })
})

describe('formatting helpers', () => {
  it('formats a real timestamp in Beijing time', () => {
    expect(formatBackOfficeDate('2026-11-11T02:03:04.000Z')).toBe('2026年11月11日')
  })

  it('labels an unparsable timestamp instead of printing Invalid Date', () => {
    expect(formatBackOfficeDate('not-a-date')).toBe('日期未知')
  })

  it('does not present the audited correction path as a resident action', () => {
    expect(describeBindingSource('resident_h5_confirmed')).toBe('本人在居民端确认')
    expect(describeBindingSource('admin_compliance_correction')).toContain('合规纠正')
  })
})
