import { useEffect, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Radio,
  Result,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type {
  WechatAccountType,
  WechatAdminConfigResponse,
  WechatAdminConfigState,
  WechatConfigFailureCode,
  WechatConfigStatus,
  WechatConfigSummary,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import type { AuthenticatedSession } from '../services/auth'
import {
  activateWechatCandidate,
  fetchWechatAdminConfig,
  saveWechatCandidate,
  verifyWechatCandidate,
} from '../services/wechat'
import './wechat.css'

/**
 * 系统管理 → 微信公众号 (#113 T4).
 *
 * The page consumes the frozen admin contract only:
 *
 * - `GET  /admin/wechat/config` for the real state (`state`, `active`, `candidate`,
 *   `recent`, `masterKeyAvailable`, `keyId`, `redirectUri`).
 * - `POST /admin/wechat/config/candidates` to store an encrypted candidate.
 * - `POST .../:configId/verify` for a real WeChat token call.
 * - `POST .../:configId/activate` with `{ expectedUpdatedAt, confirm: true }`.
 *
 * Rules the UI must never break:
 *
 * 1. A non-admin never issues a management request. Hiding the menu is not the
 *    gate; this page itself refuses to mount the console.
 * 2. The AppSecret is accepted exactly as typed, sent once in the save body and
 *    then cleared. It is never pre-filled, echoed, put in a URL or stored in
 *    localStorage/sessionStorage.
 * 3. A banner is a server fact, not a local invention: every success/error shown
 *    here comes from the real API response.
 * 4. Activation only happens after an explicit dialog that names the target
 *    AppID/account type and explains the runtime switch.
 */

const ACCOUNT_TYPE_LABELS: Record<WechatAccountType, string> = {
  test: '测试号',
  official: '正式号',
}

const STATE_META: Record<
  WechatAdminConfigState,
  { label: string; color: string; hint: string }
> = {
  unconfigured: {
    label: '未配置',
    color: 'default',
    hint: '尚未保存任何公众号凭证，居民微信登录会明确返回不可用。',
  },
  draft: {
    label: '待验证',
    color: 'blue',
    hint: '已保存候选凭证，尚未通过真实微信接口验证。',
  },
  verified: {
    label: '已验证',
    color: 'cyan',
    hint: '候选凭证已通过真实微信接口验证，尚未启用。',
  },
  failed: {
    label: '验证失败',
    color: 'red',
    hint: '最近一次真实微信接口验证失败，启用前必须重新验证。',
  },
  active: {
    label: '已启用',
    color: 'green',
    hint: '已有公众号凭证作为当前 OAuth 运行时配置。',
  },
}

const STATUS_META: Record<WechatConfigStatus, { label: string; color: string }> = {
  draft: { label: '待验证', color: 'blue' },
  verified: { label: '已验证', color: 'cyan' },
  failed: { label: '验证失败', color: 'red' },
  active: { label: '已启用', color: 'green' },
  retired: { label: '已停用', color: 'default' },
}

/**
 * Human wording for the closed, redacted failure-code set from the shared
 * contract. There is no branch that prints an upstream payload or secret.
 */
const FAILURE_LABELS: Record<WechatConfigFailureCode, string> = {
  invalid_app_id: '微信拒绝该 AppID（AppID 无效）',
  invalid_app_secret: '微信拒绝该 AppSecret（AppSecret 无效）',
  invalid_credential: '微信判定凭证无效（errcode 40001）',
  api_forbidden: '调用来源 IP 未加入微信白名单（errcode 40164）',
  rate_limited: '微信接口调用频率超限（errcode 45009）',
  wechat_api_error: '微信接口返回异常',
  network_error: '无法连接微信服务器',
  timeout: '连接微信服务器超时',
  decrypt_failed: '服务端无法用当前主密钥解密已保存的 AppSecret',
  master_key_unavailable: '服务端未配置凭证加密主密钥',
  unknown: '未知错误（已脱敏）',
}

interface SaveFormValues {
  appId: string
  accountType: WechatAccountType
  appSecret: string
}

interface ActionNotice {
  kind: 'success' | 'error'
  title: string
  text: string
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '请求失败，请稍后重试。'
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function StatusTag({ status }: { status: WechatConfigStatus }) {
  const meta = STATUS_META[status]
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function SummaryDetails({
  summary,
  scope,
}: {
  summary: WechatConfigSummary
  scope: 'active' | 'candidate'
}) {
  return (
    <Descriptions
      size="small"
      column={{ xs: 1, sm: 2 }}
      items={[
        {
          key: 'appId',
          label: 'AppID',
          children: <Typography.Text code>{summary.appId}</Typography.Text>,
        },
        {
          key: 'accountType',
          label: '账号类型',
          children: ACCOUNT_TYPE_LABELS[summary.accountType],
        },
        {
          key: 'status',
          label: '状态',
          children: <StatusTag status={summary.status} />,
        },
        {
          key: 'verifiedAt',
          label: '验证时间',
          children: (
            <span data-testid={`wechat-${scope}-verified-at`}>{formatTime(summary.verifiedAt)}</span>
          ),
        },
        {
          key: 'updatedAt',
          label: '更新时间',
          children: formatTime(summary.updatedAt),
        },
        {
          key: 'lastErrorCode',
          label: '最近错误',
          children: summary.lastErrorCode ? (
            <Space size={6} wrap>
              <span>{FAILURE_LABELS[summary.lastErrorCode]}</span>
              <Typography.Text code>{summary.lastErrorCode}</Typography.Text>
            </Space>
          ) : (
            <span>无</span>
          ),
        },
      ]}
    />
  )
}

function activateConfirmContent(
  candidate: WechatConfigSummary,
  active: WechatConfigSummary | null,
) {
  return (
    <div className="wechat-confirm">
      <div className="wechat-confirm-target" data-testid="wechat-activate-target">
        <div>
          目标 AppID：<Typography.Text code>{candidate.appId}</Typography.Text>
        </div>
        <div>账号类型：{ACCOUNT_TYPE_LABELS[candidate.accountType]}</div>
      </div>
      {active ? (
        <ul className="wechat-confirm-list">
          <li>确认后，新发起的微信登录使用新公众号（{candidate.appId}）。</li>
          <li>在途授权仍使用原配置（{active.appId}），其回调完成后不受影响。</li>
          <li>不同 AppID 的微信身份不会合并；居民可能需要在新的公众号下重新授权。</li>
          <li>原启用配置会转为「已停用」，可在最近配置历史中查看。</li>
        </ul>
      ) : (
        <ul className="wechat-confirm-list">
          <li>启用后，居民微信登录立即使用该公众号（{candidate.appId}）。</li>
          <li>服务端会在启用前再校验一次密文可解密，失败则拒绝启用。</li>
          <li>确认之前不会切换任何运行时配置。</li>
        </ul>
      )}
    </div>
  )
}

/**
 * Permission gate. The server still answers 403 for these roles; this branch
 * simply avoids sending a management request the API would reject anyway.
 */
export function WechatSettingsPage() {
  const { session } = useAdminAuth()

  if (session.staff.role !== 'admin') {
    return (
      <div className="page wechat-page">
        <PageHeader
          title="微信公众号"
          description="公众号凭证、真实连接验证与 OAuth 运行时切换仅对管理员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="非管理员没有微信公众号配置权限"
            subTitle="该入口仅对管理员开放；即使直接访问 /system/wechat，服务端同样会以 403 拒绝非管理员的公众号配置请求，本页面也不会发起管理 API 请求。"
          />
        </div>
      </div>
    )
  }

  return <WechatSettingsConsole session={session} />
}

function WechatSettingsConsole({ session }: { session: AuthenticatedSession }) {
  const { message, modal } = AntdApp.useApp()
  const [form] = Form.useForm<SaveFormValues>()
  const [data, setData] = useState<WechatAdminConfigResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [activating, setActivating] = useState(false)
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null)

  const refresh = () => {
    setLoading(true)
    setReloadKey((value) => value + 1)
  }

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    fetchWechatAdminConfig(controller.signal)
      .then((next) => {
        if (!active) return
        setData(next)
        setLoadError(null)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setLoadError(messageOf(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [reloadKey])

  async function handleSave(values: SaveFormValues) {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await saveWechatCandidate(session.csrfToken, {
        appId: values.appId.trim(),
        // The secret is forwarded exactly as typed; the API encrypts it before
        // it reaches SQLite and never returns it in any response.
        appSecret: values.appSecret,
        accountType: values.accountType,
      })
      form.setFieldValue('appSecret', '')
      message.success(`已保存候选配置 ${result.config.appId}；尚未启用，请先测试连接。`)
      refresh()
    } catch (cause) {
      // Keep the typed values so the admin can correct and retry; show the real
      // server message instead of a success-looking state.
      setSaveError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  async function handleVerify(candidate: WechatConfigSummary) {
    if (verifying) return
    setVerifying(true)
    setActionNotice(null)
    try {
      await verifyWechatCandidate(session.csrfToken, candidate.id, candidate.updatedAt)
      setActionNotice({
        kind: 'success',
        title: '测试连接成功',
        text: `微信服务器已接受 AppID ${candidate.appId} 的凭证。凭证验证只证明能换取 access_token，不等于微信内真机 OAuth 授权验收，请勿据此宣称居民登录已验收。`,
      })
      message.success('测试连接成功。')
    } catch (cause) {
      setActionNotice({
        kind: 'error',
        title: '测试连接失败',
        text: messageOf(cause),
      })
    } finally {
      setVerifying(false)
      // A failure marks the candidate failed on the server, so always re-read.
      refresh()
    }
  }

  function requestActivate(
    candidate: WechatConfigSummary,
    active: WechatConfigSummary | null,
  ) {
    modal.confirm({
      title: active ? '确认更换微信公众号配置？' : '确认启用该微信公众号配置？',
      content: activateConfirmContent(candidate, active),
      okText: active ? '确认更换' : '确认启用',
      cancelText: '取消',
      onOk: async () => {
        setActivating(true)
        setActionNotice(null)
        try {
          const result = await activateWechatCandidate(
            session.csrfToken,
            candidate.id,
            candidate.updatedAt,
          )
          setActionNotice({
            kind: 'success',
            title: '公众号配置已启用',
            text: result.previous
              ? `当前 OAuth 运行时使用 AppID ${result.active.appId}；原配置 ${result.previous.appId} 已停用，在途授权使用原配置完成。`
              : `当前 OAuth 运行时使用 AppID ${result.active.appId}。`,
          })
          message.success('公众号配置已启用。')
        } catch (cause) {
          setActionNotice({
            kind: 'error',
            title: '启用失败',
            text: messageOf(cause),
          })
        } finally {
          setActivating(false)
          refresh()
        }
      },
    })
  }

  async function copyCallbackUrl() {
    if (!data) return
    if (!navigator.clipboard?.writeText) {
      message.warning('当前浏览器不支持自动复制，请手动选择回调地址复制。')
      return
    }
    try {
      await navigator.clipboard.writeText(data.redirectUri)
      message.success('已复制回调地址。')
    } catch {
      message.warning('复制失败，请手动选择回调地址复制。')
    }
  }

  const recentColumns: ColumnsType<WechatConfigSummary> = [
    {
      title: 'AppID',
      dataIndex: 'appId',
      key: 'appId',
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: '账号类型',
      dataIndex: 'accountType',
      key: 'accountType',
      render: (value: WechatAccountType) => ACCOUNT_TYPE_LABELS[value],
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (value: WechatConfigStatus) => <StatusTag status={value} />,
    },
    {
      title: '验证时间',
      dataIndex: 'verifiedAt',
      key: 'verifiedAt',
      render: (value: string | null) => formatTime(value),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (value: string) => formatTime(value),
    },
  ]

  const stateMeta = data ? STATE_META[data.state] : null
  const masterKeyAvailable = data?.masterKeyAvailable ?? false
  const active = data?.active ?? null
  const candidate = data?.candidate ?? null
  const activeUnusable =
    active !== null && (!masterKeyAvailable || active.lastErrorCode !== null)
  const actionBusy = verifying || activating
  const activeUnusableReason = !masterKeyAvailable
    ? '服务端主密钥不可用，已保存的 AppSecret 无法解密'
    : active?.lastErrorCode
      ? FAILURE_LABELS[active.lastErrorCode]
      : '运行时无法解析该配置'

  return (
    <div className="page wechat-page">
      <PageHeader
        title="微信公众号"
        description="加密保存公众号 AppID/AppSecret，真实测试连接后启用或切换 OAuth 运行时配置；AppSecret 永不回显。"
        status={
          stateMeta ? (
            <span data-testid="wechat-state-tag">
              <Tag color={stateMeta.color}>{stateMeta.label}</Tag>
            </span>
          ) : undefined
        }
        extra={
          <Button onClick={refresh} loading={loading && data !== null}>
            刷新状态
          </Button>
        }
      />
      <div className="page-stack">
        {!data && loading ? (
          <Card size="small">
            <Space>
              <Spin size="small" />
              正在读取公众号配置状态…
            </Space>
          </Card>
        ) : null}

        {!data && !loading && loadError ? (
          <Alert
            type="error"
            showIcon
            title="无法读取公众号配置"
            description={loadError}
            action={
              <Button size="small" onClick={refresh}>
                重试
              </Button>
            }
          />
        ) : null}

        {data ? (
          <>
            {loadError ? (
              <Alert
                type="warning"
                showIcon
                title="刷新状态失败，当前展示的是上一次成功读取的结果"
                description={loadError}
                action={
                  <Button size="small" onClick={refresh}>
                    重试
                  </Button>
                }
              />
            ) : null}

            <Alert type="info" showIcon title={stateMeta?.label ?? data.state} description={stateMeta?.hint ?? ''} />

            {!data.masterKeyAvailable ? (
              <Alert
                type="error"
                showIcon
                title="凭证加密主密钥不可用"
                description="服务端未加载 WECHAT_CONFIG_MASTER_KEY 或 WECHAT_CONFIG_MASTER_KEY_FILE，无法加密保存或解密验证公众号凭证。保存、测试连接与启用已禁用，已保存的配置也无法用于居民微信登录。请联系运维配置主密钥后刷新本页。"
              />
            ) : null}

            {activeUnusable ? (
              <Alert
                type="error"
                showIcon
                title="已启用配置当前不可用"
                description={`${active?.appId ?? ''} 虽标记为已启用，但${activeUnusableReason}。居民微信登录会按不可用处理；请先修复主密钥或重新保存并验证凭证，再切换配置。`}
              />
            ) : null}

            {actionNotice ? (
              <Alert
                type={actionNotice.kind}
                showIcon
                title={actionNotice.title}
                description={actionNotice.text}
              />
            ) : null}

            <div className="wechat-grid">
              <Card size="small" title="凭证加密">
                <Space wrap>
                  <Tag color={data.masterKeyAvailable ? 'green' : 'red'}>
                    {data.masterKeyAvailable ? '加密已就绪' : '主密钥不可用'}
                  </Tag>
                  <Typography.Text type="secondary">
                    主密钥版本（keyId）：
                    <Typography.Text code>
                      <span data-testid="wechat-key-id">{data.keyId}</span>
                    </Typography.Text>
                  </Typography.Text>
                </Space>
                <Typography.Paragraph type="secondary" className="wechat-hint">
                  AppSecret 在服务端使用 AES-256-GCM 加密后写入数据库；接口响应、页面与浏览器存储都不会包含明文
                  AppSecret。
                </Typography.Paragraph>
              </Card>

              <Card size="small" title="微信授权回调地址">
                <div className="wechat-callback-row">
                  <Typography.Text code className="wechat-callback-url">
                    <span data-testid="wechat-callback-url">{data.redirectUri}</span>
                  </Typography.Text>
                  <Button size="small" aria-label="复制回调地址" onClick={() => void copyCallbackUrl()}>
                    复制
                  </Button>
                </div>
                <Typography.Paragraph type="secondary" className="wechat-hint">
                  由服务端根据居民 H5 站点地址与固定回调路径推导，管理台只读展示，不能改成其他域名或外站地址。
                </Typography.Paragraph>
              </Card>
            </div>

            <Card
              size="small"
              title="当前启用的配置"
              extra={active ? <StatusTag status={active.status} /> : <Tag>未启用</Tag>}
            >
              <div data-testid="wechat-active-card">
                {active ? (
                  <SummaryDetails summary={active} scope="active" />
                ) : (
                  <Typography.Text type="secondary">
                    当前没有已启用的公众号配置；居民微信登录会明确返回不可用，不会模拟成功。
                  </Typography.Text>
                )}
              </div>
            </Card>

            <Card
              size="small"
              title="待启用 / 最近候选配置"
              extra={candidate ? <StatusTag status={candidate.status} /> : <Tag>无候选</Tag>}
            >
              <div data-testid="wechat-candidate-card">
                {candidate ? (
                  <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                    <SummaryDetails summary={candidate} scope="candidate" />
                    <Typography.Paragraph type="secondary" className="wechat-hint">
                      「测试连接」会由服务端真实调用微信 token 接口，只验证 AppID/AppSecret 能换取
                      access_token；不等于微信内真机 OAuth 授权验收。
                    </Typography.Paragraph>
                    {candidate.status !== 'verified' ? (
                      <Alert
                        type="info"
                        showIcon
                        title="启用前需先通过测试连接"
                        description="只有「已验证」的候选配置可以启用；验证失败不会影响当前已启用的配置。"
                      />
                    ) : null}
                    <Space wrap>
                      <Button
                        onClick={() => void handleVerify(candidate)}
                        loading={verifying}
                        disabled={!masterKeyAvailable || activating}
                      >
                        测试连接
                      </Button>
                      <Button
                        type="primary"
                        onClick={() => requestActivate(candidate, active)}
                        loading={activating}
                        disabled={!masterKeyAvailable || actionBusy || candidate.status !== 'verified'}
                      >
                        {active ? '更换配置' : '启用配置'}
                      </Button>
                      {candidate.status !== 'verified' ? (
                        <Typography.Text type="secondary">
                          仅「已验证」的配置可以启用。
                        </Typography.Text>
                      ) : null}
                    </Space>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    没有待验证或已验证的候选配置；保存一份新凭证后会出现在这里。
                  </Typography.Text>
                )}
              </div>
            </Card>

            <Card
              size="small"
              title="保存新的公众号凭证"
              extra={
                <Typography.Text type="secondary">
                  保存只生成候选版本，不会替换当前启用配置
                </Typography.Text>
              }
            >
              <Typography.Paragraph type="secondary">
                填写公众号后台的 AppID 与 AppSecret。保存后状态为「待验证」，必须通过测试连接才能启用。
                AppSecret 不会预填，保存成功后立即清空。
              </Typography.Paragraph>
              {saveError ? (
                <Alert
                  type="error"
                  showIcon
                  title="保存公众号凭证失败"
                  description={saveError}
                  className="wechat-form-error"
                />
              ) : null}
              <Form<SaveFormValues>
                form={form}
                layout="vertical"
                initialValues={{ accountType: 'official' }}
                onFinish={handleSave}
                disabled={!data.masterKeyAvailable}
              >
                <div className="wechat-form-grid">
                  <Form.Item
                    name="appId"
                    label="AppID"
                    rules={[
                      { required: true, whitespace: true, message: '请填写公众号 AppID' },
                      {
                        pattern: /^wx[A-Za-z0-9]{16}$/u,
                        message: 'AppID 应为 wx 开头的 18 位字母数字',
                      },
                    ]}
                  >
                    <Input placeholder="wx1234567890abcdef" autoComplete="off" maxLength={64} />
                  </Form.Item>
                  <Form.Item
                    name="accountType"
                    label="账号类型"
                    rules={[{ required: true, message: '请选择账号类型' }]}
                  >
                    <Radio.Group
                      options={[
                        { label: '测试号', value: 'test' },
                        { label: '正式号', value: 'official' },
                      ]}
                    />
                  </Form.Item>
                </div>
                <Form.Item
                  name="appSecret"
                  label="AppSecret"
                  rules={[
                    { required: true, message: '请填写 AppSecret' },
                    { min: 8, max: 128, message: 'AppSecret 长度需为 8-128 位' },
                  ]}
                  extra="仅在保存时提交给服务端加密存储；不会写入 URL、localStorage/sessionStorage 或页面文本。"
                >
                  <Input.Password
                    visibilityToggle={false}
                    autoComplete="new-password"
                    placeholder="输入公众号后台的 AppSecret（保存后不会回显）"
                  />
                </Form.Item>
                <Space wrap>
                  <Button
                    type="primary"
                    htmlType="submit"
                    loading={saving}
                    disabled={!data.masterKeyAvailable}
                  >
                    保存为待验证配置
                  </Button>
                  <Typography.Text type="secondary">
                    AppID 格式：wx 开头的 18 位字母数字；账号类型仅用于展示，不改变 OAuth 协议。
                  </Typography.Text>
                </Space>
              </Form>
            </Card>

            {data.recent.length > 0 ? (
              <Card size="small" title="最近配置历史（含已停用）">
                <Table<WechatConfigSummary>
                  rowKey="id"
                  size="small"
                  columns={recentColumns}
                  dataSource={data.recent}
                  pagination={false}
                  scroll={{ x: 720 }}
                />
              </Card>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
