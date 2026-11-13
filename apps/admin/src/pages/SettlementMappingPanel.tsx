import { PageInfoAlert } from '../components/PageInfoHelp'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd'
import type { Rule } from 'antd/es/form'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  LocalProductSummary,
  SettlementMapping,
  SettlementOrderPartySnapshot,
  SettlementParty,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { formatDateTime } from '../services/ledger'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import { listAdminProducts } from '../services/localCatalog'
import {
  SETTLEMENT_PARTY_ROLE_LABELS,
  confirmSettlementOrderParty,
  createSettlementMapping,
  listSettlementMappings,
  listSettlementParties,
  readSettlementOrderParty,
  type SettlementOrderPartyResponse,
} from '../services/settlement'
import './ledger.css'

/**
 * 分成结算单 · 商户映射与订单主体确认（LL-SET-009B / Issue #220）。
 *
 * 业务边界（由服务端与共享契约固定，页面不得重新设计）：
 *
 * - 映射是「商品 → 三方主体」的**版本化记录**：新增就是新版本，本页没有编辑或
 *   删除入口，也不推断「当前生效 / 已过期」——契约里没有这个字段。
 * - 保存映射**绝不**自动确认任何历史订单。每张订单必须在「订单主体确认」区块里
 *   显式读取并确认，确认生成追加式快照，不可回写，也不影响其他订单。
 * - 「确认主体」不是付款、不是结算：本视图不登记付款、不计算金额，也不显示任何
 *   应付数字。确认后的付款与结算属于后续任务卡。
 * - 只有管理员能新增映射与确认主体；运营员只读且请求始终带自己的授权社区；
 *   网格员由页面级 403 拦截，服务端同样拒绝。
 */

interface MappingFormValues {
  communityId?: string
  productId?: string
  sellerPartyId?: string
  sanchuangPartyId?: string | null
  guangdianPartyId?: string | null
  agreementRef?: string
  effectiveFrom?: string
  effectiveTo?: string
}

interface ConfirmFormValues {
  mappingId?: string
  confirmationRef?: string
}

/** Contract-trimmed length check; an empty value is left to `required`. */
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

/** Machine identifiers are shortened for the table only; the full id stays as a tooltip. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

export function SettlementMappingPanel() {
  const { session } = useAdminAuth()
  const { message, modal } = AntdApp.useApp()
  const authorizedCommunities = session.staff.communities
  const isAdmin = session.staff.role === 'admin'
  const hasAuthorizedScope = isAdmin || authorizedCommunities.length > 0

  /* ------------------------------ mapping list ----------------------------- */

  const [communityId, setCommunityId] = useState<string | undefined>(
    isAdmin ? undefined : authorizedCommunities[0]?.id,
  )
  const [mappings, setMappings] = useState<SettlementMapping[] | null>(null)
  const [parties, setParties] = useState<SettlementParty[] | null>(null)
  const [products, setProducts] = useState<LocalProductSummary[]>([])
  const [productError, setProductError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!hasAuthorizedScope) {
      setMappings(null)
      setLoading(false)
      return
    }
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setMappings(null)
    setParties(null)
    setProducts([])
    setProductError(null)
    void Promise.all([
      listSettlementMappings({ communityId }, controller.signal),
      listSettlementParties({ communityId }, controller.signal),
      listAdminProducts({ page: 1, pageSize: 100, communityId }, controller.signal)
        .then((result) => result.items)
        .catch((cause: unknown) => {
          if (!active || controller.signal.aborted) return []
          // Product names are a display convenience only. A failure must stay
          // visible, but it cannot be allowed to hide real mapping rows.
          setProductError(describeLocalError(cause, '商品名称加载失败'))
          return [] as LocalProductSummary[]
        }),
    ])
      .then(([mappingRows, partyRows, productRows]) => {
        if (!active) return
        setMappings(mappingRows)
        setParties(partyRows)
        setProducts(productRows)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setMappings(null)
        setError(cause instanceof Error ? cause : new Error('商户映射加载失败'))
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

  const partyNameById = useMemo(
    () => new Map((parties ?? []).map((party) => [party.id, party.legalName])),
    [parties],
  )
  const productNameById = useMemo(
    () => new Map(products.map((product) => [product.id, product.name])),
    [products],
  )

  /* ---------------------------- create mapping ----------------------------- */

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [form] = Form.useForm<MappingFormValues>()

  const [formProducts, setFormProducts] = useState<LocalProductSummary[]>([])
  const [formProductsLoading, setFormProductsLoading] = useState(false)
  const [formProductsError, setFormProductsError] = useState<string | null>(null)
  const formProductToken = useRef(0)
  // The product list is scoped to the community chosen in the drawer; before a
  // choice there is nothing the server could filter by.
  const formCommunityId = Form.useWatch('communityId', form)

  const loadFormProducts = (value: string | undefined) => {
    const requestToken = ++formProductToken.current
    setFormProducts([])
    setFormProductsError(null)
    if (!value) return
    setFormProductsLoading(true)
    void listAdminProducts({ page: 1, pageSize: 100, communityId: value })
      .then((result) => {
        if (formProductToken.current === requestToken) setFormProducts(result.items)
      })
      .catch((cause: unknown) => {
        if (formProductToken.current === requestToken) {
          setFormProductsError(describeLocalError(cause, '商品列表加载失败'))
        }
      })
      .finally(() => {
        if (formProductToken.current === requestToken) setFormProductsLoading(false)
      })
  }

  const openDrawer = () => {
    form.resetFields()
    formProductToken.current += 1
    setFormProducts([])
    setFormProductsError(null)
    setSubmitError(null)
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    if (submitting) return
    setDrawerOpen(false)
    setSubmitError(null)
    form.resetFields()
  }

  const submitMapping = async (values: MappingFormValues) => {
    if (submitting) return
    const effectiveFrom = (values.effectiveFrom ?? '').trim()
    const effectiveTo = (values.effectiveTo ?? '').trim()
    if (!values.communityId || !values.productId || !values.sellerPartyId) return
    // The shared contract only lets the server decide overlap/conflict; the page
    // checks the one ordering rule a human can see before leaving the browser.
    if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
      setSubmitError('生效终止日不能早于起始日')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const created = await createSettlementMapping(session.csrfToken, {
        communityId: values.communityId,
        productId: values.productId,
        sellerPartyId: values.sellerPartyId,
        sanchuangPartyId: values.sanchuangPartyId ?? null,
        guangdianPartyId: values.guangdianPartyId ?? null,
        agreementRef: (values.agreementRef ?? '').trim(),
        effectiveFrom,
        effectiveTo,
      })
      setDrawerOpen(false)
      form.resetFields()
      message.success(
        `已新增商户映射版本（${created.effectiveFrom} ~ ${created.effectiveTo}）。保存映射不会自动确认任何历史订单。`,
      )
      // Re-read the list instead of inserting the created version locally.
      setReloadToken((value) => value + 1)
    } catch (cause: unknown) {
      setSubmitError(describeLocalError(cause, '新增商户映射失败'))
    } finally {
      setSubmitting(false)
    }
  }

  /* ------------------------- order party confirmation ---------------------- */

  const [orderIdInput, setOrderIdInput] = useState('')
  const [orderIdLoaded, setOrderIdLoaded] = useState<string | null>(null)
  const [orderParty, setOrderParty] = useState<SettlementOrderPartyResponse | null>(null)
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderError, setOrderError] = useState<string | null>(null)
  const [orderRefreshError, setOrderRefreshError] = useState<string | null>(null)

  const [confirmForm] = Form.useForm<ConfirmFormValues>()
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const readOrder = async () => {
    const orderId = orderIdInput.trim()
    if (!orderId) {
      setOrderError('请先填写订单 ID（服务端使用 UUID），再读取主体状态。')
      return
    }
    setOrderLoading(true)
    setOrderError(null)
    setOrderRefreshError(null)
    setConfirmError(null)
    setOrderParty(null)
    setOrderIdLoaded(null)
    try {
      const result = await readSettlementOrderParty(orderId)
      setOrderParty(result)
      setOrderIdLoaded(orderId)
      confirmForm.resetFields()
    } catch (cause: unknown) {
      setOrderError(describeLocalError(cause, '读取订单主体失败'))
    } finally {
      setOrderLoading(false)
    }
  }

  const performConfirm = async (orderId: string, request: { mappingId: string; confirmationRef: string }) => {
    setConfirming(true)
    setConfirmError(null)
    try {
      await confirmSettlementOrderParty(session.csrfToken, orderId, request)
    } catch (cause: unknown) {
      setConfirmError(describeLocalError(cause, '确认订单主体失败'))
      setConfirming(false)
      return
    }
    message.success('订单主体已确认：追加式快照，仅影响这一张订单，且不代表已付款或可结算。')
    confirmForm.resetFields()
    // The confirm endpoint returns the snapshot only; the authoritative status
    // still comes from the read endpoint, so re-read instead of guessing.
    try {
      const refreshed = await readSettlementOrderParty(orderId)
      setOrderParty(refreshed)
      setOrderIdLoaded(orderId)
    } catch (cause: unknown) {
      setOrderRefreshError(
        `主体已确认，但重新读取该订单状态失败：${describeLocalError(cause, '读取订单主体失败')}`,
      )
    } finally {
      setConfirming(false)
    }
  }

  const requestConfirm = (values: ConfirmFormValues) => {
    const orderId = orderIdLoaded
    if (!orderId) {
      setConfirmError('请先读取一张订单，再确认主体。')
      return
    }
    const mappingId = values.mappingId
    const confirmationRef = (values.confirmationRef ?? '').trim()
    if (!mappingId || confirmationRef === '') return
    modal.confirm({
      title: '确认订单主体快照？',
      content: (
        <div className="local-confirm-body">
          <p>
            订单：<span className="ledger-cell-mono">{orderId}</span>
          </p>
          <p>
            映射版本：<span className="ledger-cell-mono">{mappingId}</span>
          </p>
          <p>确认依据：{confirmationRef}</p>
          <p>
            确认会为该订单追加一条主体快照，不能回写、不能修改；只影响这一张订单，不会确认任何其他历史订单。
          </p>
          <p>确认主体 ≠ 已付款 ≠ 可结算：本操作不登记付款，也不产生任何应付金额。</p>
        </div>
      ),
      okText: '确认主体',
      cancelText: '取消',
      onOk: () => performConfirm(orderId, { mappingId, confirmationRef }),
    })
  }

  /* -------------------------------- columns -------------------------------- */

  const renderPartyRef = (partyId: string | null) => {
    if (partyId === null) {
      return <Typography.Text type="secondary">未指定</Typography.Text>
    }
    const name = partyNameById.get(partyId)
    return name ? (
      <span>{name}</span>
    ) : (
      <span className="ledger-cell-mono" title={partyId}>
        {shortId(partyId)}
      </span>
    )
  }

  const renderProductRef = (productId: string) => {
    const name = productNameById.get(productId)
    return name ? (
      <span>{name}</span>
    ) : (
      <span className="ledger-cell-mono" title={productId}>
        {shortId(productId)}
      </span>
    )
  }

  const columns: ColumnsType<SettlementMapping> = [
    {
      title: '商品',
      key: 'product',
      render: (_value, row) => renderProductRef(row.productId),
    },
    {
      title: '销售商户',
      key: 'seller',
      render: (_value, row) => renderPartyRef(row.sellerPartyId),
    },
    {
      title: '三创主体',
      key: 'sanchuang',
      render: (_value, row) => renderPartyRef(row.sanchuangPartyId),
    },
    {
      title: '广电主体',
      key: 'guangdian',
      render: (_value, row) => renderPartyRef(row.guangdianPartyId),
    },
    {
      title: '协议引用',
      key: 'agreementRef',
      render: (_value, row) => (
        <Typography.Text className="ledger-cell-mono">{row.agreementRef}</Typography.Text>
      ),
    },
    {
      title: '生效区间',
      key: 'effective',
      render: (_value, row) => (
        <span className="ledger-batch-period">
          {row.effectiveFrom} ~ {row.effectiveTo}
        </span>
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

  /* -------------------------------- options -------------------------------- */

  const sellerParties = (parties ?? []).filter(
    (party) => party.role === 'seller' && party.verifiedAt !== null,
  )
  const sanchuangParties = (parties ?? []).filter((party) => party.role === 'sanchuang')
  const guangdianParties = (parties ?? []).filter((party) => party.role === 'guangdian')

  const mappingOptions = (mappings ?? []).map((mapping) => ({
    value: mapping.id,
    label: `${productNameById.get(mapping.productId) ?? shortId(mapping.productId)} · ${
      mapping.effectiveFrom
    } ~ ${mapping.effectiveTo}`,
  }))

  const unauthorized = isLocalApiError(error) && error.status === 401
  const forbidden = isLocalApiError(error) && error.status === 403
  const errorText = error ? describeLocalError(error, '商户映射加载失败') : null

  const mappingEmptyText = (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未建立商户映射">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        映射是「商品 → 三方主体」的版本化记录，新增即新版本。保存映射不会自动确认任何历史订单；每张订单仍须在下方显式确认主体。
      </Typography.Paragraph>
    </Empty>
  )

  return (
    <section aria-label="商户映射与订单主体确认">
      <PageInfoAlert
        type="info"
        showIcon
        title="映射是版本化记录，订单主体必须逐单确认"
        description="保存商户映射不会自动确认任何历史订单；每张订单必须显式确认。确认主体 ≠ 已付款 ≠ 可结算：本视图不登记付款，也不计算任何金额。"
      />

      {!hasAuthorizedScope ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="当前账号没有可用的社区范围"
          description="运营员与网格员必须由管理员分配至少一个社区后，才能查看或新增商户映射。本视图没有发起任何请求，也不会用空列表冒充「尚未建立映射」。"
        />
      ) : unauthorized ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="登录状态已失效"
          description={`服务端返回 401：请重新登录管理后台后再查看商户映射。${errorText ?? ''}`}
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
          title="没有查看商户映射的权限"
          description={`${errorText ?? ''} 网格员没有结算映射权限；服务端直接返回 403。`}
          action={
            <Button size="small" onClick={refresh}>
              重试
            </Button>
          }
        />
      ) : (
        <>
          <Card
            size="small"
            style={{ marginTop: 12 }}
            title="商户映射（版本化记录）"
            extra={
              <Space wrap size={8}>
                <Button size="small" onClick={refresh} loading={loading}>
                  刷新
                </Button>
                {/* Only an admin may map a product to its three real parties. */}
                {isAdmin ? (
                  <Button size="small" type="primary" onClick={openDrawer}>
                    新增映射
                  </Button>
                ) : null}
              </Space>
            }
          >
            {authorizedCommunities.length > 0 ? (
              <div className="ledger-filter-field" style={{ marginBottom: 12 }}>
                <label htmlFor="settlement-mapping-community">社区范围</label>
                <Select<string>
                  id="settlement-mapping-community"
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
                当前管理员账号未被分配具体社区，列表按服务端全部社区范围返回；新增映射需要先由管理员分配社区。
              </Typography.Paragraph>
            )}

            {error ? (
              <Alert
                type="error"
                showIcon
                title="商户映射加载失败"
                description={errorText ?? undefined}
                action={
                  <Button size="small" onClick={refresh}>
                    重试
                  </Button>
                }
              />
            ) : mappings === null ? (
              <div className="ledger-candidate-loading" aria-live="polite">
                <Spin />
                <Typography.Text type="secondary">正在读取商户映射…</Typography.Text>
              </div>
            ) : (
              <>
                <Table<SettlementMapping>
                  rowKey="id"
                  columns={columns}
                  dataSource={mappings}
                  loading={loading}
                  size="small"
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  locale={{ emptyText: mappingEmptyText }}
                />
                {productError ? (
                  <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                    商品名称加载失败：{productError} 上表因此只显示商品 ID 短号，映射记录本身不受影响。
                  </Typography.Paragraph>
                ) : null}
              </>
            )}
          </Card>

          <Card
            size="small"
            style={{ marginTop: 12 }}
            title="订单主体确认"
            extra={
              <Typography.Text type="secondary">
                追加式快照 · 不可回写 · 仅影响这一张订单
              </Typography.Text>
            }
          >
            <Space wrap size={12} align="end">
              <div className="ledger-filter-field">
                <label htmlFor="settlement-order-party-order-id">订单 ID</label>
                <Input
                  id="settlement-order-party-order-id"
                  style={{ width: 320 }}
                  maxLength={64}
                  placeholder="服务端订单 UUID"
                  value={orderIdInput}
                  onChange={(event) => setOrderIdInput(event.target.value)}
                />
                <span className="ledger-filter-hint">只查询服务端真实订单；本页不推断未读取的订单状态。</span>
              </div>
              <Button type="primary" onClick={() => void readOrder()} loading={orderLoading}>
                读取
              </Button>
            </Space>

            {orderError ? (
              <Alert
                style={{ marginTop: 12 }}
                type="error"
                showIcon
                title="订单主体读取失败"
                description={orderError}
                action={
                  <Button size="small" onClick={() => void readOrder()}>
                    重试
                  </Button>
                }
              />
            ) : null}

            {orderRefreshError ? (
              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                showIcon
                title="确认已提交，但状态刷新失败"
                description={orderRefreshError}
              />
            ) : null}

            {orderParty === null ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                输入订单 ID 后点「读取」，此处会如实显示「尚未确认销售商户」「三方主体不完整」或已确认快照。
              </Typography.Paragraph>
            ) : (
              <OrderPartyState
                response={orderParty}
                onReadAgain={() => void readOrder()}
              />
            )}

            {isAdmin ? (
              <div style={{ marginTop: 16 }}>
                <Typography.Text strong>显式确认这张订单的主体</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                  选择一个当前商户映射版本与可核对的确认依据。确认是追加式快照：不可回写，只影响这一张订单，不会确认其他历史订单，也不代表已付款或可结算。
                </Typography.Paragraph>
                {sellerParties.length === 0 ? (
                  <PageInfoAlert inline
                    style={{ marginBottom: 12 }}
                    type="info"
                    showIcon
                    title="当前范围没有已核验的销售商户"
                    description="请先到「主体目录」登记并核验销售商户，再回来建立映射与确认订单主体。"
                  />
                ) : null}
                <Form<ConfirmFormValues>
                  form={confirmForm}
                  layout="inline"
                  onFinish={requestConfirm}
                  style={{ rowGap: 12 }}
                >
                  <Form.Item
                    name="mappingId"
                    label="映射版本"
                    rules={[{ required: true, message: '请选择商户映射版本' }]}
                  >
                    <Select
                      style={{ minWidth: 260 }}
                      placeholder={
                        mappingOptions.length > 0 ? '请选择映射版本' : '当前范围尚无映射版本'
                      }
                      options={mappingOptions}
                    />
                  </Form.Item>
                  <Form.Item
                    name="confirmationRef"
                    label="确认依据"
                    rules={[
                      { required: true, whitespace: true, message: '请填写确认依据' },
                      trimmedLengthRule('确认依据', 2, 200),
                    ]}
                  >
                    <Input style={{ width: 260 }} maxLength={200} placeholder="可核对的确认依据（2-200 字）" />
                  </Form.Item>
                  <Form.Item>
                    <Button
                      type="primary"
                      htmlType="submit"
                      loading={confirming}
                      disabled={confirming || orderIdLoaded === null}
                    >
                      确认主体
                    </Button>
                  </Form.Item>
                </Form>
                {orderIdLoaded === null ? (
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    请先读取一张订单；确认按钮只对已读取的这一张订单生效。
                  </Typography.Paragraph>
                ) : (
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    当前确认对象：<span className="ledger-cell-mono">{orderIdLoaded}</span>
                  </Typography.Paragraph>
                )}
                {confirmError ? (
                  <Alert
                    style={{ marginTop: 12 }}
                    type="error"
                    showIcon
                    title="主体未确认"
                    description={confirmError}
                  />
                ) : null}
              </div>
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                运营员只读：确认订单主体只能由管理员执行；本页不渲染确认入口。
              </Typography.Paragraph>
            )}
          </Card>
        </>
      )}

      {/* --------------------------------- drawer -------------------------------- */}
      {isAdmin ? (
        <Drawer
          title="新增商户映射"
          size={560}
          open={drawerOpen}
          onClose={closeDrawer}
          rootClassName="local-drawer"
          destroyOnHidden
        >
          <Typography.Paragraph type="secondary">
            新增即新版本：同一商品可以有多条映射记录，历史版本不会被覆盖。保存映射不会确认任何订单，也不会自动确认历史订单。本页不填写任何费率或金额。
          </Typography.Paragraph>
          <Form<MappingFormValues>
            form={form}
            layout="vertical"
            onFinish={(values) => void submitMapping(values)}
          >
            {submitError ? (
              <Alert
                type="error"
                showIcon
                title="映射未新增"
                description={submitError}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            <Form.Item
              name="communityId"
              label="社区"
              rules={[{ required: true, message: '请选择社区' }]}
            >
              {authorizedCommunities.length > 0 ? (
                <Select
                  placeholder="请选择社区"
                  onChange={(value) => loadFormProducts(value)}
                  options={authorizedCommunities.map((community) => ({
                    value: community.id,
                    label: community.name,
                  }))}
                />
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  title="当前账号没有可用的社区"
                  description="新增映射必须绑定一个真实社区；请联系管理员为你分配社区，页面不会编造社区选项。"
                />
              )}
            </Form.Item>
            <Form.Item
              name="productId"
              label="商品"
              rules={[{ required: true, message: '请选择商品' }]}
              tooltip="只选择商品本身；本页不展示也不计算任何金额。"
            >
              <Select
                placeholder={
                  formProductsError ??
                  (formCommunityId ? '请选择商品' : '请先选择社区，再选择商品')
                }
                loading={formProductsLoading}
                notFoundContent={formProductsError ? '商品加载失败' : '该社区暂无可选商品'}
                options={formProducts.map((product) => ({
                  value: product.id,
                  label: product.name,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="sellerPartyId"
              label={`销售商户（${SETTLEMENT_PARTY_ROLE_LABELS.seller}）`}
              rules={[{ required: true, message: '请选择已核验的销售商户' }]}
              tooltip="只列出服务端返回 verifiedAt 的主体；未核验主体不能作为映射的销售商户。"
            >
              <Select
                placeholder={
                  sellerParties.length > 0
                    ? `请选择${SETTLEMENT_PARTY_ROLE_LABELS.seller}`
                    : '当前范围没有已核验的销售商户'
                }
                options={sellerParties.map((party) => ({
                  value: party.id,
                  label: party.legalName,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="sanchuangPartyId"
              label={`${SETTLEMENT_PARTY_ROLE_LABELS.sanchuang}（可选）`}
            >
              <Select
                allowClear
                placeholder={`不指定${SETTLEMENT_PARTY_ROLE_LABELS.sanchuang}`}
                options={sanchuangParties.map((party) => ({
                  value: party.id,
                  label: party.legalName,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="guangdianPartyId"
              label={`${SETTLEMENT_PARTY_ROLE_LABELS.guangdian}（可选）`}
            >
              <Select
                allowClear
                placeholder={`不指定${SETTLEMENT_PARTY_ROLE_LABELS.guangdian}`}
                options={guangdianParties.map((party) => ({
                  value: party.id,
                  label: party.legalName,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="agreementRef"
              label="协议引用"
              rules={[
                { required: true, whitespace: true, message: '请填写协议引用' },
                trimmedLengthRule('协议引用', 2, 200),
              ]}
              tooltip="可核对的合同/协议引用，2-200 个字符。"
            >
              <Input maxLength={200} placeholder="例如 AG-2026-001" />
            </Form.Item>
            <Form.Item
              name="effectiveFrom"
              label="生效起日"
              rules={[{ required: true, whitespace: true, message: '请填写生效起日' }]}
            >
              <Input maxLength={10} placeholder="YYYY-MM-DD" />
            </Form.Item>
            <Form.Item
              name="effectiveTo"
              label="生效止日"
              dependencies={['effectiveFrom']}
              rules={[
                { required: true, whitespace: true, message: '请填写生效止日' },
                {
                  validator: (): Promise<void> => {
                    const from = (form.getFieldValue('effectiveFrom') as string | undefined)?.trim()
                    const to = (form.getFieldValue('effectiveTo') as string | undefined)?.trim()
                    if (!from || !to) return Promise.resolve()
                    if (to < from) {
                      return Promise.reject(new Error('生效终止日不能早于起始日'))
                    }
                    return Promise.resolve()
                  },
                },
              ]}
            >
              <Input maxLength={10} placeholder="YYYY-MM-DD" />
            </Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={submitting} disabled={submitting}>
                保存映射
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

/* -------------------------------------------------------------------------- */
/* Order party state: the three server statuses, rendered as they come         */
/* -------------------------------------------------------------------------- */

function OrderPartyState({
  response,
  onReadAgain,
}: {
  response: SettlementOrderPartyResponse
  onReadAgain: () => void
}) {
  return (
    <div style={{ marginTop: 12 }}>
      {response.sellerStatus === 'missing_seller' ? (
        <Alert
          type="warning"
          showIcon
          title="尚未确认销售商户"
          description="该订单还没有主体快照。需要先在商户映射中建立覆盖该订单商品与社区的生效映射，再对这张订单显式确认主体；保存映射本身不会确认它。"
        />
      ) : response.sellerStatus === 'incomplete_parties' ? (
        <Alert
          type="warning"
          showIcon
          title="三方主体不完整"
          description="服务端返回的主体快照缺少三创或广电主体。请补齐对应映射，再对这张订单重新显式确认；历史快照不可回写。"
        />
      ) : (
        <Alert
          type="success"
          showIcon
          title="已确认销售商户"
          description="服务端返回了一张已确认的订单主体快照。确认主体不等于已付款，也不等于可结算。"
          action={
            <Button size="small" onClick={onReadAgain}>
              重新读取
            </Button>
          }
        />
      )}

      {response.snapshot ? (
        <SnapshotDetails snapshot={response.snapshot} />
      ) : (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          服务端未返回主体快照；本页不会补造主体或时间。
        </Typography.Paragraph>
      )}
    </div>
  )
}

function SnapshotDetails({ snapshot }: { snapshot: SettlementOrderPartySnapshot }) {
  return (
    <Descriptions
      size="small"
      column={1}
      bordered
      style={{ marginTop: 12 }}
      title="订单主体快照（只读）"
    >
      <Descriptions.Item label="映射版本">
        <Typography.Text className="ledger-cell-mono" copyable={{ text: snapshot.mappingId }}>
          {snapshot.mappingId}
        </Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="销售商户">
        <Typography.Text className="ledger-cell-mono" copyable={{ text: snapshot.sellerPartyId }}>
          {snapshot.sellerPartyId}
        </Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="协议引用">
        <Typography.Text copyable={{ text: snapshot.agreementRef }}>
          {snapshot.agreementRef}
        </Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="确认依据">
        <Typography.Text copyable={{ text: snapshot.confirmationRef }}>
          {snapshot.confirmationRef}
        </Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="确认时间">
        {formatDateTime(snapshot.confirmedAt)}
      </Descriptions.Item>
      <Descriptions.Item label="确认人">
        <Typography.Text className="ledger-cell-mono" copyable={{ text: snapshot.confirmedByUserId }}>
          {snapshot.confirmedByUserId}
        </Typography.Text>
      </Descriptions.Item>
    </Descriptions>
  )
}
