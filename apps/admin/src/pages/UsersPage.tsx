import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Avatar, Button, Descriptions, Drawer, Space, Spin, Tag, Typography } from 'antd'
import {
  apiErrorSchema,
  type StaffRole,
  type UserDirectoryDetail,
  type UserDirectoryEntry,
  type UserDirectoryRoleFilter,
} from '@sanchuang-dev/local-life-contracts'
import { PageHeader } from '../components/PageHeader'
import {
  DataPanel,
  type PanelColumn,
  type PanelFilter,
  type PanelQuery,
} from '../shared/components/DataPanel'
import type { AuthenticatedSession } from '../services/auth'
import {
  communityCellEntries,
  confirmedCommunityAbsenceText,
  describeBindingSource,
  describeCommunityRelation,
  formatBackOfficeDate,
  residentStateBadge,
  residentStateUnavailableReason,
} from '../shared/lib/resident-community-view'
import {
  getUserDirectoryEntry,
  isUserDirectoryApiError,
  listUserDirectory,
} from '../services/users'
import './users.css'

/**
 * Independent platform user directory (#154 LL-USER-002).
 *
 * Every account in the platform `users` table is a row, including accounts that
 * never joined a community. The page never derives its list from one community's
 * resident roster and never filters or paginates a local copy: the server owns
 * keyword/role/community filtering, paging and the real total. Detail is
 * read-only and a failed read clears the drawer instead of keeping another
 * account's data on screen.
 */

interface UsersPageProps {
  session: AuthenticatedSession
}

interface UserDirectoryFilters {
  keyword: string
  role?: UserDirectoryRoleFilter
  community?: string
}

type UserSortKey = 'createdAt'

interface CommunityOption {
  id: string
  name: string
}

const ROLE_LABELS: Record<StaffRole, string> = {
  admin: '管理员',
  operator: '运营员',
  grid_worker: '网格员',
}

const ROLE_FILTER_OPTIONS: ReadonlyArray<{ label: string; value: UserDirectoryRoleFilter }> = [
  { label: '管理员', value: 'admin' },
  { label: '运营员', value: 'operator' },
  { label: '网格员', value: 'grid_worker' },
  { label: '居民（无后台账户）', value: 'resident' },
]

const IDENTITY_METHOD_LABELS = {
  wechat: '微信',
  phone: '手机号',
  staff: '后台账户',
} as const

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function formatDateTime(iso: string): string {
  return DATE_TIME_FORMATTER.format(new Date(iso))
}

function formatDate(iso: string): string {
  return DATE_FORMATTER.format(new Date(iso))
}

function roleTag(staffRole: StaffRole | null) {
  if (!staffRole) return <Tag>居民</Tag>
  return (
    <Tag
      color={
        staffRole === 'grid_worker' ? 'blue' : staffRole === 'operator' ? 'geekblue' : 'green'
      }
    >
      {ROLE_LABELS[staffRole]}
    </Tag>
  )
}

function identityTags(methods: readonly (keyof typeof IDENTITY_METHOD_LABELS)[]): ReactNode {
  // The final #153 contract allows an empty array only for a legacy account that
  // has no persistent identity row (for example an AUTH_DEV_ENABLED login). Show
  // that state explicitly instead of rendering a blank identity cell.
  if (methods.length === 0) return <Tag>无持久身份</Tag>
  return methods.map((method) => <Tag key={method}>{IDENTITY_METHOD_LABELS[method]}</Tag>)
}

/**
 * The community cell for one directory row (#171 LL-IDENTITY-001).
 *
 * A confirmed permanent community and a historical relation are shown with
 * different words on purpose: the back office may never present a legacy relation
 * (including the rows the retired #123 login wrote automatically) as a confirmed
 * permanent community, and it may never present an out-of-scope confirmation as
 * 「未关联」. There is no rebind/unbind affordance — no admin route exists.
 */
function residentCommunityCell(row: UserDirectoryEntry): ReactNode {
  const relation = describeCommunityRelation(row)
  const entries = communityCellEntries(row)
  // The state badge only adds information beyond the relation tag for the two
  // cases that need a human: a legacy conflict awaiting review, and a real
  // conflict. `unbound`/`confirmed` would merely repeat the relation tag, and a
  // missing state (community-scoped operator) must not be guessed.
  const badge = residentStateBadge(row.residentCommunityState)
  const extraBadge =
    badge && (badge.label === '历史待核查' || badge.label === '常驻社区冲突') ? badge : null
  return (
    <Space size={4} wrap>
      <Tag color={relation.tone === 'neutral' ? undefined : relation.tone} title={relation.detail}>
        {relation.label}
      </Tag>
      {entries.slice(0, 2).map((community) =>
        community.kind === 'confirmed' ? (
          <Tag key={community.id} color="green">
            常驻：{community.name}
          </Tag>
        ) : (
          <Tag key={community.id}>历史归属：{community.name}</Tag>
        ),
      )}
      {entries.length > 2 ? <Tag>+{entries.length - 2}</Tag> : null}
      {extraBadge ? (
        <Tag color={extraBadge.tone === 'neutral' ? undefined : extraBadge.tone}>
          {extraBadge.label}
        </Tag>
      ) : null}
    </Space>
  )
}

/** Read-only resident state for the detail drawer, never guessed when absent. */
function residentStateNode(state: UserDirectoryEntry['residentCommunityState']): ReactNode {
  const badge = residentStateBadge(state)
  if (badge) {
    return (
      <Space direction="vertical" size={2}>
        <Tag color={badge.tone === 'neutral' ? undefined : badge.tone}>{badge.label}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {badge.hint}
        </Typography.Text>
      </Space>
    )
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {residentStateUnavailableReason(state)}
    </Typography.Text>
  )
}

function describeError(cause: unknown, fallback: string): string {
  if (isUserDirectoryApiError(cause)) {
    if (cause.status === 403) return `无权查看该用户（HTTP 403）：${cause.message}`
    if (cause.status === 404) return `用户不存在或已被移除（HTTP 404）：${cause.message}`
    return cause.message
  }
  return cause instanceof Error ? cause.message : fallback
}

function isCommunityListPayload(value: unknown): value is { items: CommunityOption[] } {
  if (typeof value !== 'object' || value === null || !('items' in value)) return false
  const items = value.items
  return (
    Array.isArray(items) &&
    items.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'id' in item &&
        typeof item.id === 'string' &&
        'name' in item &&
        typeof item.name === 'string',
    )
  )
}

/**
 * Community filter options come from the same server-scoped community list the
 * rest of the console uses. They only populate a filter; the directory API still
 * authorizes each query, so a stale or crafted option cannot widen access.
 */
async function readCommunityOptions(signal?: AbortSignal): Promise<CommunityOption[]> {
  const response = await fetch('/api/admin/communities', {
    credentials: 'include',
    signal,
    headers: { accept: 'application/json' },
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload)
    throw new Error(
      parsed.success
        ? parsed.data.error.message
        : `无法读取社区筛选选项（HTTP ${response.status}）`,
    )
  }
  if (!isCommunityListPayload(payload)) throw new Error('社区筛选选项与预期结构不一致')
  return payload.items
}

export function UsersPage({ session }: UsersPageProps) {
  const [query, setQuery] = useState<PanelQuery<UserDirectoryFilters, UserSortKey>>(() => ({
    filters: { keyword: '' },
    page: 1,
    pageSize: 20,
  }))
  const [rows, setRows] = useState<UserDirectoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<Error | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const [communityOptions, setCommunityOptions] = useState<CommunityOption[]>([])
  const [communityOptionsError, setCommunityOptionsError] = useState<string | null>(null)
  const [communityOptionsToken, setCommunityOptionsToken] = useState(0)

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<UserDirectoryDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailUserId, setDetailUserId] = useState<string | null>(null)
  const detailRequestRef = useRef(0)

  const isAdmin = session.staff.role === 'admin'

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setCommunityOptionsError(null)
    readCommunityOptions(controller.signal)
      .then((items) => {
        if (active) setCommunityOptions(items)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setCommunityOptions([])
        setCommunityOptionsError(
          cause instanceof Error ? cause.message : '无法读取社区筛选选项',
        )
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [communityOptionsToken])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setListError(null)
    // Never keep a previous page/filter's rows on screen while another request
    // is in flight, and never keep them after it fails.
    setRows([])
    setTotal(0)

    listUserDirectory(
      {
        page: query.page,
        pageSize: query.pageSize,
        keyword: query.filters.keyword,
        role: query.filters.role,
        community: query.filters.community,
      },
      controller.signal,
    )
      .then((result) => {
        if (!active) return
        setRows(result.items)
        setTotal(result.total)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setRows([])
        setTotal(0)
        setListError(cause instanceof Error ? cause : new Error('无法读取用户目录'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [query, reloadToken])

  const filters = useMemo<readonly PanelFilter<UserDirectoryFilters>[]>(() => {
    const communities = communityOptions.map((community) => ({
      label: community.name,
      value: community.id,
    }))
    // `unassigned` is a real server filter, but only admins can see accounts
    // outside a community; offering it to scoped staff would always be empty.
    const communityFilterOptions = isAdmin
      ? [...communities, { label: '未关联社区', value: 'unassigned' }]
      : communities
    return [
      {
        key: 'keyword',
        kind: 'text',
        label: '关键词',
        placeholder: '微信昵称 / 本地名称 / 平台 UUID',
        width: 260,
      },
      {
        key: 'role',
        kind: 'select',
        label: '角色',
        width: 170,
        options: ROLE_FILTER_OPTIONS,
      },
      {
        key: 'community',
        kind: 'select',
        label: '社区归属',
        width: 190,
        options: communityFilterOptions,
      },
    ]
  }, [communityOptions, isAdmin])

  const columns = useMemo<readonly PanelColumn<UserDirectoryEntry, UserSortKey>[]>(
    () => [
      {
        key: 'user',
        title: '用户',
        hideable: false,
        render: (_value: unknown, row: UserDirectoryEntry) => (
          <Space size={8} align="center">
            <Avatar src={row.wechatAvatarUrl || undefined} alt={row.displayName}>
              {row.displayName.slice(0, 1)}
            </Avatar>
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{row.displayName}</Typography.Text>
              {row.localDisplayName && row.localDisplayName !== row.displayName ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  本地：{row.localDisplayName}
                </Typography.Text>
              ) : null}
            </Space>
          </Space>
        ),
      },
      {
        key: 'id',
        title: '平台 UUID',
        dataIndex: 'id',
        render: (value: string) => (
          <Typography.Text code copyable={{ text: value }} style={{ fontSize: 12 }}>
            {value}
          </Typography.Text>
        ),
      },
      {
        key: 'identity',
        title: '身份 / 角色',
        render: (_value: unknown, row: UserDirectoryEntry) => (
          <Space size={4} wrap>
            {identityTags(row.identityMethods)}
            {roleTag(row.staffRole)}
          </Space>
        ),
      },
      {
        key: 'residentCommunities',
        title: '常驻社区 / 历史归属',
        render: (_value: unknown, row: UserDirectoryEntry) => residentCommunityCell(row),
      },
      {
        key: 'createdAt',
        title: '注册时间',
        dataIndex: 'createdAt',
        render: (value: string) => formatDateTime(value),
      },
    ],
    [],
  )

  function refresh() {
    setReloadToken((value) => value + 1)
  }

  function openDetail(userId: string) {
    setDetailOpen(true)
    setDetail(null)
    setDetailError(null)
    setDetailUserId(userId)
    void loadDetail(userId)
  }

  async function loadDetail(userId: string) {
    const request = detailRequestRef.current + 1
    detailRequestRef.current = request
    setDetailLoading(true)
    setDetailError(null)
    // A retry or a newly opened row must never show the previous account while
    // the next detail request is running.
    setDetail(null)
    try {
      const result = await getUserDirectoryEntry(userId)
      if (detailRequestRef.current !== request) return
      setDetail(result)
    } catch (cause: unknown) {
      if (detailRequestRef.current !== request) return
      setDetail(null)
      setDetailError(describeError(cause, '无法读取用户详情'))
    } finally {
      if (detailRequestRef.current === request) setDetailLoading(false)
    }
  }

  function closeDetail() {
    detailRequestRef.current += 1
    setDetailOpen(false)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
    setDetailUserId(null)
  }

  return (
    <div className="page">
      <PageHeader
        title="用户管理"
        description="平台全部用户目录（含未关联社区的账号）。常驻社区由居民本人确认，管理台只读展示，不可代为变更；历史归属只是观察记录，不代表已确认。后台账户的社区授权与居民社区归属是两种不同关系。"
        status={
          <Tag color="blue">
            {session.staff.role === 'admin' ? '管理员：全部用户' : '仅权限范围内用户'}
          </Tag>
        }
      />

      {communityOptionsError ? (
        <Alert
          type="warning"
          showIcon
          message="社区筛选选项加载失败"
          description={`${communityOptionsError} 仍可查看权限范围内的全部用户。`}
          action={
            <Button
              size="small"
              onClick={() => setCommunityOptionsToken((value) => value + 1)}
            >
              重试
            </Button>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <DataPanel<UserDirectoryEntry, UserDirectoryFilters, UserSortKey>
        id="user-directory"
        label="平台用户目录"
        rowKey={(row) => row.id}
        query={query}
        onQueryChange={(next) => {
          setQuery(next)
          return true
        }}
        initialFilters={{ keyword: '' }}
        data={{ rows, total, loading, error: listError ?? undefined }}
        filters={filters}
        columns={columns}
        onRefresh={refresh}
        errorTitle="用户目录加载失败"
        rowActions={(row) => [
          { key: 'detail', label: '详情', onClick: () => openDetail(row.id) },
        ]}
      />

      <Drawer
        title={detail ? `用户详情 · ${detail.displayName}` : '用户详情'}
        size={640}
        open={detailOpen}
        onClose={closeDetail}
        rootClassName="users-drawer"
      >
        {detailLoading ? (
          <div className="users-drawer-loading">
            <Spin description="正在读取用户详情…" />
          </div>
        ) : detailError ? (
          <Alert
            type="error"
            showIcon
            message="用户详情加载失败"
            description={detailError}
            action={
              <Button
                size="small"
                disabled={!detailUserId}
                onClick={() => {
                  if (detailUserId) void loadDetail(detailUserId)
                }}
              >
                重试
              </Button>
            }
          />
        ) : detail ? (
          <Space direction="vertical" size={18} style={{ width: '100%' }}>
            <Space size={12} align="start">
              <Avatar
                size={48}
                src={detail.wechatAvatarUrl || undefined}
                alt={detail.displayName}
              >
                {detail.displayName.slice(0, 1)}
              </Avatar>
              <Space direction="vertical" size={4}>
                <Typography.Text strong style={{ fontSize: 16 }}>
                  {detail.displayName}
                </Typography.Text>
                <Space size={4} wrap>
                  {identityTags(detail.identityMethods)}
                  {roleTag(detail.staffRole)}
                </Space>
              </Space>
            </Space>

            <Descriptions size="small" column={1} bordered title="身份资料">
              <Descriptions.Item label="平台用户 ID">
                <Typography.Text code copyable={{ text: detail.id }}>
                  {detail.id}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="本地显示名">
                {detail.localDisplayName || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="微信昵称">
                {detail.wechatNickname || '未授权或未设置'}
              </Descriptions.Item>
              <Descriptions.Item label="微信资料授权">
                {detail.wechatProfileAuthorizedAt
                  ? `已授权（${formatDateTime(detail.wechatProfileAuthorizedAt)}）`
                  : '未授权'}
              </Descriptions.Item>
              <Descriptions.Item label="关联微信身份">
                {detail.wechatLinkedIdentityCount} 个（仅计数）
              </Descriptions.Item>
              <Descriptions.Item label="手机号">
                {detail.maskedPhone || '未绑定'}
              </Descriptions.Item>
              <Descriptions.Item label="注册时间">
                {formatDateTime(detail.createdAt)}
              </Descriptions.Item>
            </Descriptions>

            <Descriptions size="small" column={1} bordered title="后台账户">
              {detail.staffAccount ? (
                <>
                  <Descriptions.Item label="登录账号">
                    {detail.staffAccount.username}
                  </Descriptions.Item>
                  <Descriptions.Item label="状态">
                    <Tag
                      color={
                        detail.staffAccount.status === 'active' ? 'success' : 'default'
                      }
                    >
                      {detail.staffAccount.status === 'active' ? '正常' : '已停用'}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="授权社区">
                    {detail.staffAccount.communities.length === 0 ? (
                      '未授权任何社区'
                    ) : (
                      <Space size={4} wrap>
                        {detail.staffAccount.communities.map((community) => (
                          <Tag key={community.id} color="blue">
                            {community.name}
                          </Tag>
                        ))}
                      </Space>
                    )}
                  </Descriptions.Item>
                </>
              ) : (
                <Descriptions.Item label="后台账户">
                  无（该账号只有居民身份，不是后台工作人员）
                </Descriptions.Item>
              )}
            </Descriptions>

            <Descriptions size="small" column={1} bordered title="居民常驻社区（#171 只读）">
              <Descriptions.Item label="常驻社区">
                {detail.confirmedCommunity ? (
                  <Space size={4} wrap>
                    <Tag color="green">{detail.confirmedCommunity.name}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      本人确认时间 {formatBackOfficeDate(detail.confirmedCommunity.confirmedAt)} ·
                      {' '}{describeBindingSource(detail.confirmedCommunity.source)}
                    </Typography.Text>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    {confirmedCommunityAbsenceText(detail)}
                  </Typography.Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="归属判定">
                <Space direction="vertical" size={2}>
                  <Tag
                    color={
                      describeCommunityRelation(detail).tone === 'neutral'
                        ? undefined
                        : describeCommunityRelation(detail).tone
                    }
                  >
                    {describeCommunityRelation(detail).label}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {describeCommunityRelation(detail).detail}
                  </Typography.Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="历史社区归属（只读，不代表已确认）">
                {detail.residentCommunities.length === 0 ? (
                  <Typography.Text type="secondary">无历史社区关系记录</Typography.Text>
                ) : (
                  <Space size={4} wrap>
                    {detail.residentCommunities.map((community) => (
                      <Tag key={community.id}>
                        {community.name} · {formatDate(community.joinedAt)} 记录
                      </Tag>
                    ))}
                  </Space>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="居民端状态">
                {residentStateNode(detail.residentCommunityState)}
              </Descriptions.Item>
            </Descriptions>

            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本页只读，不提供编辑身份、社区归属或后台账户的操作；成员的常驻社区只能由本人在居民端首次确认，
              后台没有改绑、解绑或代确认入口。如需纠正录入错误或处理身份纠纷，请走已审计的合规纠正流程。
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">暂无用户详情。</Typography.Text>
        )}
      </Drawer>
    </div>
  )
}
