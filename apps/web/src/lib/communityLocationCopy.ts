export type CommunityLocationStatus = 'idle' | 'locating' | 'success' | 'error'

export interface CommunityLocationSheetCopy {
  title: string
  detail: string
  action: string
}

/**
 * The community sheet is always the authoritative place to inspect the current
 * location state, including after a community has already been selected.
 * Failure detail must be the same readable reason raised by the geolocation
 * layer; never replace it with an unqualified "未获取位置".
 */
export function communityLocationSheetCopy(
  status: CommunityLocationStatus,
  error: string,
): CommunityLocationSheetCopy {
  if (status === 'locating') {
    return {
      title: '正在获取位置',
      detail: '请在微信或浏览器提示中选择允许，位置仅用于推荐附近社区。',
      action: '定位中…',
    }
  }
  if (status === 'success') {
    return {
      title: '已获取位置',
      detail: '位置仅用于推荐附近社区，不会自动修改你的社区归属。',
      action: '重新定位',
    }
  }
  if (status === 'error') {
    return {
      title: '定位未成功',
      detail: error || '暂时无法获取位置，请重试或手动选择社区。',
      action: '重新定位',
    }
  }
  return {
    title: '尚未使用定位',
    detail: '点右侧按钮获取当前位置，仅用于推荐附近社区；也可以直接手动选择。',
    action: '定位附近',
  }
}
