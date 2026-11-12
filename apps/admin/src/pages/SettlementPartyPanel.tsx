import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { Rule } from 'antd/es/form'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useState } from 'react'
import type { SettlementParty } from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { formatDateTime } from '../services/ledger'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import {
  SETTLEMENT_PARTY_ROLE_LABELS,
  createSettlementParty,
  listSettlementParties,
  type SettlementPartyRole,
} from '../services/settlement'
import './ledger.css'

/**
 * 分成结算单 · 主体目录（LL-SET-009A / Issue #219, API #183）。
 *
 * 这是「真实法人主体」的登记目录，不是结算规则，也不是应付金额：
 *
 * - 列表只渲染 `GET /admin/settlement/parties` 返回的行；`verifiedAt` 是唯一的
 *   核验状态来源，`null` 就显示「未核验」，绝不根据 `verificationRef` 或角色推断。
 * - 本视图不显示、也不计算任何金额（没有 ¥0、应付、分成或费率）；缺少主体时
 *   服务端无法生成应付款，页面只如实说「待补齐」。
 * - 社区范围只来自 `session.staff.communities`：管理员默认「全部社区」也可收窄；
 *   运营员/网格员必须带一个授权社区（服务端对无 `communityId` 的运营员返回 400）。
 *   前端不编造社区，也不能扩大服务端授权。
 * - 只有管理员看到「登记主体」入口；运营员与网格员没有写入口。提交成功后不本地
 *   插行，而是重新 GET 列表；失败时 Drawer 保持打开并展示服务端真实错误，绝不
 *   提示成功。
 */

interface PartyFormValues {
  role?: SettlementPartyRole
  legalName?: string
  registryRef?: string
  verificationRef?: string
}

/** Contract order: seller → sanchuang → guangdian. Labels come from the service. */
const PARTY_ROLE_OPTIONS = Object.entries(SETTLEMENT_PARTY_ROLE_LABELS).map(([value, label]) => ({
  value,
  label,
}))

/**
 * The contract trims before it checks length (`z.string().trim().min(2)`), so a
 * value that is only spaces must not pass here either. An empty value is left to
 * the `required` rule, which owns the 「请填写…」 message.
 */
function trimmedLengthRule(label: string, min: number, max: number): Rule {
  return {
    validator: (_rule: unknown, value: unknown): Promise<void> => {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return Promise.resolve()
      if (text.length < min || text.length > max) {
        return Promise.reject(new Error(`${label}需 ${min}-${max} 个字符`))
      }
      return Promise.resolve()
    },
  }
}

export function SettlementPartyPanel() {
  const { session } = useAdminAuth()
  const { message } = AntdApp.useApp()
  // The session's assignments are the only community options this view may offer.
  const authorizedCommunities = session.staff.communities
  const isAdmin = session.staff.role === 'admin'
  // An operator/grid_worker without an assigned community cannot form a valid
  // query (the server answers 400), so the panel says so instead of guessing.
  const hasAuthorizedScope = isAdmin || authorizedCommunities.length > 0

  const [communityId, setCommunityId] = useState<string | undefined>(
    isAdmin ? undefined : authorizedCommunities[0]?.id,
  )
  const [parties, setParties] = useState<SettlementParty[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [form] = Form.useForm<PartyFormValues>()

  useEffect(() => {
    if (!hasAuthorizedScope) {
      setParties(null)
      setLoading(false)
      return
    }
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    // A new scope must not keep showing the previous scope's rows under the new
    // community label: clear first, then read again.
    setParties(null)
    listSettlementParties({ communityId }, controller.signal)
      .then((result) => {
        if (active) setParties(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setParties(null)
        setError(cause instanceof Error ? cause : new Error('结算主体加载失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [communityId, reloadToken, hasAuthorizedScope])

  const refresh = () => setReloadToken((value) => value + 1)

  const changeCommunity = (value: string | undefined) => {
    setCommunityId(value ?? undefined)
  }

  const openDrawer = () => {
    form.resetFields()
    setSubmitError(null)
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    if (submitting) return
    setDrawerOpen(false)
    setSubmitError(null)
    form.resetFields()
  }

  const submit = async (values: PartyFormValues) => {
    if (submitting) return
    if (!values.role) return
    const verificationRef = (values.verificationRef ?? '').trim()
    const request = {
      role: values.role,
      legalName: (values.legalName ?? '').trim(),
      registryRef: (values.registryRef ?? '').trim(),
      // A blank evidence reference is submitted as null, never as "".
      verificationRef: verificationRef === '' ? null : verificationRef,
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const created = await createSettlementParty(session.csrfToken, request)
      setDrawerOpen(false)
      form.resetFields()
      message.success(`已登记结算主体：${created.legalName}`)
      // Re-read the list instead of inserting a client-side row: the server is the
      // only authority on `verifiedAt`, `id` and `createdAt`.
      setReloadToken((value) => value + 1)
    } catch (cause: unknown) {
      // The drawer stays open with the real 400/401/403/409/network sentence.
      setSubmitError(describeLocalError(cause, '登记结算主体失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const unauthorized = isLocalApiError(error) && error.status === 401
  const forbidden = isLocalApiError(error) && error.status === 403
  const errorText = error ? describeLocalError(error, '结算主体加载失败') : null

  const columns: ColumnsType<SettlementParty> = [
    {
      title: '角色',
      key: 'role',
      render: (_value, row) => SETTLEMENT_PARTY_ROLE_LABELS[row.role],
    },
    {
      title: '法定名称',
      key: 'legalName',
      render: (_value, row) => <Typography.Text strong>{row.legalName}</Typography.Text>,
    },
    {
      title: '登记号',
      key: 'registryRef',
      render: (_value, row) => <span className="ledger-cell-mono">{row.registryRef}</span>,
    },
    {
      title: '核验依据',
      key: 'verificationRef',
      render: (_value, row) =>
        row.verificationRef === null ? (
          <Typography.Text type="secondary">未提供</Typography.Text>
        ) : (
          <Typography.Text className="ledger-cell-mono">{row.verificationRef}</Typography.Text>
        ),
    },
    {
      title: '核验状态',
      key: 'verifiedAt',
      render: (_value, row) =>
        row.verifiedAt === null ? (
          <Tag color="orange">未核验</Tag>
        ) : (
          <Space orientation="vertical" size={2}>
            <Tag color="green">已核验</Tag>
            <Typography.Text type="secondary">{formatDateTime(row.verifiedAt)}</Typography.Text>
          </Space>
        ),
    },
    {
      title: '创建时间',
      key: 'createdAt',
      render: (_value, row) => formatDateTime(row.createdAt),
    },
    {
      title: '创建人',
      key: 'createdByUserId',
      render: (_value, row) => (
        <Typography.Text type="secondary" className="ledger-cell-mono" style={{ fontSize: 12 }}>
          {row.createdByUserId}
        </Typography.Text>
      ),
    },
  ]

  const emptyText = (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未登记任何结算主体">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        主体是待补齐项：缺少真实、可核验的法律主体时不能生成应付款。请先登记法定名称、登记号与核验依据；本视图不做任何金额计算。
      </Typography.Paragraph>
    </Empty>
  )

  return (
    <section aria-label="结算主体目录">
      <Alert
        type="info"
        showIcon
        title="主体目录 · 只登记真实法人主体"
        description="这里登记商品销售商户、三创主体与广电主体本身，不登记分成规则，也不产生任何金额。核验状态只来自服务端 verifiedAt：未核验就是未核验，不能由角色、登记号或核验依据推断。缺少真实主体时，结算单无法生成应付款。"
      />

      {!hasAuthorizedScope ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="当前账号没有可用的社区范围"
          description="运营员与网格员必须由管理员分配至少一个社区后，才能查看或登记该社区的结算主体。本视图没有发起任何请求，也不会用空列表冒充「尚未登记」。"
        />
      ) : unauthorized ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="登录状态已失效"
          description={`服务端返回 401：请重新登录管理后台后再查看结算主体。${errorText ?? ''}`}
          action={
            <Button size="small" onClick={() => window.location.reload()}>
              刷新并重新登录
            </Button>
          }
        />
      ) : forbidden ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          title="没有查看结算主体的权限"
          description={`${errorText ?? ''} 请使用管理员或运营员账号；网格员只能在自己的工作台查看授权社区的流水。`}
          action={
            <Button size="small" onClick={refresh}>
              重试
            </Button>
          }
        />
      ) : (
        <Card
          size="small"
          style={{ marginTop: 12 }}
          title="结算主体（真实法人主体）"
          extra={
            <Space wrap size={8}>
              <Button size="small" onClick={refresh} loading={loading}>
                刷新
              </Button>
              {/* No write entry for operator/grid_worker: the server also rejects it. */}
              {isAdmin ? (
                <Button size="small" type="primary" onClick={openDrawer}>
                  登记主体
                </Button>
              ) : null}
            </Space>
          }
        >
          {authorizedCommunities.length > 0 ? (
            <div className="ledger-filter-field" style={{ marginBottom: 12 }}>
              <label htmlFor="settlement-party-community">社区范围</label>
              <Select<string>
                id="settlement-party-community"
                allowClear={isAdmin}
                style={{ maxWidth: 260 }}
                placeholder={isAdmin ? '全部社区' : '请选择授权社区'}
                value={communityId}
                onChange={(value) => changeCommunity(value)}
                options={authorizedCommunities.map((community) => ({
                  value: community.id,
                  label: community.name,
                }))}
              />
              <span className="ledger-filter-hint">
                {isAdmin
                  ? '不选具体社区时，服务端返回其全部社区范围'
                  : '运营员必须指定一个自己已被分配的社区（服务端要求 communityId）'}
              </span>
            </div>
          ) : (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              当前管理员账号未被分配具体社区，列表按服务端全部社区范围返回。
            </Typography.Paragraph>
          )}

          {error ? (
            <Alert
              type="error"
              showIcon
              title="结算主体加载失败"
              description={errorText ?? undefined}
              action={
                <Button size="small" onClick={refresh}>
                  重试
                </Button>
              }
            />
          ) : parties === null ? (
            <div className="ledger-candidate-loading" aria-live="polite">
              <Spin />
              <Typography.Text type="secondary">正在读取结算主体…</Typography.Text>
            </div>
          ) : (
            <Table<SettlementParty>
              rowKey="id"
              columns={columns}
              dataSource={parties}
              loading={loading}
              size="small"
              pagination={false}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText }}
            />
          )}
        </Card>
      )}

      {/* The registration drawer exists only for admins; no hidden write path for others. */}
      {isAdmin ? (
        <Drawer
          title="登记结算主体"
          size={520}
          open={drawerOpen}
          onClose={closeDrawer}
          rootClassName="local-drawer"
          destroyOnHidden
        >
          <Typography.Paragraph type="secondary">
            只登记真实、可核验的法人主体。核验依据是材料引用（例如合同或证照编号），提交它不等于服务端已核验；核验状态由服务端决定，本页不预填任何主体名称、费率或金额。
          </Typography.Paragraph>
          <Form<PartyFormValues> form={form} layout="vertical" onFinish={(values) => void submit(values)}>
            {submitError ? (
              <Alert
                type="error"
                showIcon
                title="登记未完成"
                description={submitError}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            <Form.Item
              name="role"
              label="主体角色"
              rules={[{ required: true, message: '请选择主体角色' }]}
            >
              <Select placeholder="请选择主体角色" options={PARTY_ROLE_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="legalName"
              label="法定名称"
              rules={[
                { required: true, whitespace: true, message: '请填写法定名称' },
                trimmedLengthRule('法定名称', 2, 160),
              ]}
              tooltip="营业执照等登记文件上的法定名称，2-160 个字符。"
            >
              <Input maxLength={160} placeholder="按登记文件填写法定名称" />
            </Form.Item>
            <Form.Item
              name="registryRef"
              label="登记号"
              rules={[
                { required: true, whitespace: true, message: '请填写登记号' },
                trimmedLengthRule('登记号', 2, 120),
              ]}
              tooltip="统一社会信用代码或其他可核对的登记号，2-120 个字符。"
            >
              <Input maxLength={120} placeholder="统一社会信用代码或登记号" />
            </Form.Item>
            <Form.Item
              name="verificationRef"
              label="核验依据（可选）"
              rules={[trimmedLengthRule('核验依据', 2, 200)]}
              tooltip="可核对的材料引用，2-200 个字符；留空提交为 null，行内显示「未提供」。"
            >
              <Input maxLength={200} placeholder="例如合同编号或证照核对记录（可留空）" />
            </Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={submitting} disabled={submitting}>
                提交登记
              </Button>
              <Button onClick={closeDrawer} disabled={submitting}>
                取消
              </Button>
            </Space>
          </Form>
        </Drawer>
      ) : null}
    </section>
  )
}
