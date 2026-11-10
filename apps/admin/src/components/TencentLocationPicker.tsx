import { useEffect, useMemo, useRef } from 'react'
import { Alert, Modal, Typography } from 'antd'
import type { CommunityLocation } from '@sanchuang-dev/local-life-contracts'

const PICKER_ORIGIN = 'https://apis.map.qq.com'

interface TencentLocationPickerProps {
  open: boolean
  apiKey: string
  initialLocation?: CommunityLocation
  onCancel: () => void
  onSelect: (location: CommunityLocation) => void
}

/**
 * Tencent's hosted location picker owns POI search and map rendering.
 * The parent only accepts a confirmed location from this iframe, after
 * checking both the origin and the specific iframe window.
 */
export function TencentLocationPicker({
  open,
  apiKey,
  initialLocation,
  onCancel,
  onSelect,
}: TencentLocationPickerProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const source = useMemo(() => {
    if (!open || !apiKey) return null
    const params = new URLSearchParams({
      search: '1',
      type: '1',
      policy: '1',
      key: apiKey,
      referer: 'local-life-admin',
    })
    if (initialLocation) {
      params.set('coord', `${initialLocation.latitude},${initialLocation.longitude}`)
      params.set('coordtype', '5') // Tencent/GCJ-02 coordinates
    }
    return `${PICKER_ORIGIN}/tools/locpicker?${params.toString()}`
  }, [open, apiKey, initialLocation])

  useEffect(() => {
    if (!open) return
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== PICKER_ORIGIN || event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) return
      const payload = data as Record<string, unknown>
      if (payload.module !== 'locationPicker') return
      if (!payload.latlng || typeof payload.latlng !== 'object') return
      const coords = payload.latlng as Record<string, unknown>
      const lat = coords.lat
      const lng = coords.lng
      if (typeof lat !== 'number' || typeof lng !== 'number'
        || !Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) return
      const address = [payload.poiaddress, payload.poiname]
        .filter((value): value is string => typeof value === 'string' && !!value.trim())
        .join(' ').trim()
      if (!address || address.length > 200) return
      onSelect({ address, latitude: lat, longitude: lng })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [open, onSelect])

  return (
    <Modal
      title="在腾讯地图上选择社区服务点"
      open={open}
      onCancel={onCancel}
      footer={null}
      destroyOnHidden
      width={760}
    >
      <Alert
        type="info"
        showIcon
        message="搜索社区或服务中心，再在地图上确认位置"
        style={{ marginBottom: 12 }}
      />
      {source && (
        <iframe
          ref={iframeRef}
          title="腾讯地图选点"
          src={source}
          style={{ width: '100%', height: 'min(68vh, 580px)', border: 0 }}
        />
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        这里保存的是社区服务点的腾讯地图坐标（GCJ-02），不是居民住址或行政边界。
      </Typography.Text>
    </Modal>
  )
}
