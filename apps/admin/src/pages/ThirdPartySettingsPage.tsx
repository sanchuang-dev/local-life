import { useEffect, useState } from 'react'
import {
  Alert, Button, Card, Drawer, Result, Spin, Tag, Typography,
  theme,
} from 'antd'
import { EnvironmentOutlined, SettingOutlined, WechatOutlined } from '@ant-design/icons'
import type { WechatAdminConfigResponse, TencentMapConfigStatus } from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { fetchWechatAdminConfig } from '../services/wechat'
import { readTencentMapSettings } from '../services/tencent-map'
import { WechatSettingsPage } from './WechatSettingsPage'
import { TencentMapSettingsPage } from './TencentMapSettingsPage'
import './third-party-settings.css'

type Service = 'wechat' | 'map'

const WECHAT_STATES: Record<WechatAdminConfigResponse['state'], { text: string; color: string }> = {
  unconfigured: { text: '未配置', color: 'default' },
  draft: { text: '待验证', color: 'blue' },
  verified: { text: '已验证 · 待启用', color: 'cyan' },
  failed: { text: '验证失败', color: 'error' },
  active: { text: '已启用', color: 'success' },
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '读取配置失败'
}

/**
 * One admin-only entry for third-party integrations. Status cards are backed
 * by the existing read-only endpoints; the original security-sensitive editors
 * mount only on demand and retain their existing confirmation/CSRF contracts.
 */
export function ThirdPartySettingsPage() {
  const { session } = useAdminAuth()
  const { token } = theme.useToken()
  const [wechat, setWechat] = useState<WechatAdminConfigResponse | null>(null)
  const [map, setMap] = useState<TencentMapConfigStatus | null>(null)
  const [wechatError, setWechatError] = useState<string | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [activeService, setActiveService] = useState<Service | null>(null)

  useEffect(() => {
    if (session.staff.role !== 'admin') return
    const controller = new AbortController()
    let mounted = true
    // Each integration can fail independently; a provider outage must not
    // hide the status or management entry for the other integration.
    void Promise.allSettled([
      fetchWechatAdminConfig(controller.signal),
      readTencentMapSettings(controller.signal),
    ]).then(([wechatResult, mapResult]) => {
      if (!mounted) return
      if (wechatResult.status === 'fulfilled') {
        setWechat(wechatResult.value)
        setWechatError(null)
      } else {
        // A failed refresh must not leave a formerly healthy status on screen.
        setWechat(null)
        setWechatError(messageOf(wechatResult.reason))
      }
      if (mapResult.status === 'fulfilled') {
        setMap(mapResult.value)
        setMapError(null)
      } else {
        setMap(null)
        setMapError(messageOf(mapResult.reason))
      }
      setLoading(false)
    })
    return () => { mounted = false; controller.abort() }
  }, [session.staff.role, refreshKey])

  if (session.staff.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="第三方配置" description="外部服务连接与凭证管理仅平台管理员可访问。" />
        <Result status="403" title="没有第三方配置权限" />
      </div>
    )
  }

  const wechatState = wechat
    ? !wechat.masterKeyAvailable || (wechat.active && wechat.active.lastErrorCode)
      ? { text: '配置异常', color: 'error' }
      : WECHAT_STATES[wechat.state]
    : null
  const mapState = map
    ? !map.configured
      ? { text: '未配置', color: 'default' }
      : map.enabled
        ? { text: '已启用', color: 'success' }
        : { text: '已停用', color: 'default' }
    : null

  const refreshStatus = () => {
    setLoading(true)
    setRefreshKey((value) => value + 1)
  }

  const closeEditor = () => {
    setActiveService(null)
    // Mutations occur in the existing editors. Re-read the server on close
    // instead of trusting a local optimistic status projection.
    refreshStatus()
  }

  return (
    <div className="page third-party-settings-page">
      <PageHeader
        title="第三方配置"
        description="统一管理外部服务的连接状态和配置。"
        extra={<Button aria-label="刷新状态" onClick={refreshStatus} loading={loading}>刷新状态</Button>}
      />

      <div className="third-party-settings-grid">
        <Card className="third-party-service-card" size="small" data-testid="third-party-wechat">
          <div className="third-party-service-heading">
            <span className="third-party-service-icon" style={{
              color: token.colorPrimary, background: token.colorPrimaryBg,
            }}><WechatOutlined aria-hidden="true" /></span>
            <div className="third-party-service-title">
              <Typography.Title level={4}>微信公众号</Typography.Title>
              <Typography.Text type="secondary">居民微信登录与网页授权</Typography.Text>
            </div>
            {wechatState && <Tag color={wechatState.color}>{wechatState.text}</Tag>}
          </div>

          <div className="third-party-service-content" aria-label="微信公众号状态">
            {loading && !wechat && !wechatError ? <Spin size="small" /> : null}
            {wechatError && <Alert type="error" showIcon title="状态读取失败" description={wechatError} />}
            {wechat && <dl className="third-party-service-facts">
              <div><dt>当前公众号</dt><dd>{wechat.active?.appId || '尚未启用'}</dd></div>
              <div><dt>待处理配置</dt><dd>{wechat.candidate ? '有候选配置' : '无'}</dd></div>
              <div><dt>加密主密钥</dt><dd>{wechat.masterKeyAvailable ? '可用' : '不可用'}</dd></div>
            </dl>}
          </div>
          <div className="third-party-service-actions">
            <Button type="primary" icon={<SettingOutlined />} onClick={() => setActiveService('wechat')}>
              管理配置
            </Button>
          </div>
        </Card>

        <Card className="third-party-service-card" size="small" data-testid="third-party-map">
          <div className="third-party-service-heading">
            <span className="third-party-service-icon" style={{
              color: token.colorPrimary, background: token.colorPrimaryBg,
            }}><EnvironmentOutlined aria-hidden="true" /></span>
            <div className="third-party-service-title">
              <Typography.Title level={4}>腾讯地图</Typography.Title>
              <Typography.Text type="secondary">社区服务点选址与定位</Typography.Text>
            </div>
            {mapState && <Tag color={mapState.color}>{mapState.text}</Tag>}
          </div>

          <div className="third-party-service-content" aria-label="腾讯地图状态">
            {loading && !map && !mapError ? <Spin size="small" /> : null}
            {mapError && <Alert type="error" showIcon title="状态读取失败" description={mapError} />}
            {map && <dl className="third-party-service-facts">
              <div><dt>应用名称</dt><dd>{map.appName || '尚未配置'}</dd></div>
              <div><dt>Key</dt><dd>{map.keyHint || '未设置'}</dd></div>
              <div><dt>最后更新</dt><dd>{map.updatedAt ? new Date(map.updatedAt).toLocaleString('zh-CN') : '—'}</dd></div>
            </dl>}
          </div>
          <div className="third-party-service-actions">
            <Button type="primary" icon={<SettingOutlined />} onClick={() => setActiveService('map')}>
              管理配置
            </Button>
          </div>
        </Card>
      </div>

      <Drawer
        open={activeService !== null}
        title={null}
        size="large"
        width="min(1100px, 100vw)"
        rootClassName="third-party-configuration-drawer"
        onClose={closeEditor}
        destroyOnHidden
      >
        {activeService === 'wechat' ? <WechatSettingsPage /> : null}
        {activeService === 'map' ? <TencentMapSettingsPage /> : null}
      </Drawer>
    </div>
  )
}
