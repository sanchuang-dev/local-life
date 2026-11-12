import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd'
import type { Rule } from 'antd/es/form'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useState } from 'react'
import type {
  LocalProductSummary,
  SettlementMapping,
  SettlementParty,
  SettlementRuleVersion,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { formatDateTime } from '../services/ledger'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import { listAdminProducts } from '../services/localCatalog'
import {
  SETTLEMENT_PARTY_ROLE_LABELS,
  SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS,
  SETTLEMENT_RULE_FIXED_POLICY_LABELS,
  SETTLEMENT_RULE_PARTY_KEY_LABELS,
  createSettlementRuleVersion,
  listSettlementMappings,
  listSettlementParties,
  listSettlementRuleVersions,
} from '../services/settlement'
import './ledger.css'

/**
 * 分成结算单 · 已核准合同规则版本（LL-SET-010A / Issue #221）。
 *
 * 业务边界（由共享契约与服务端固定，页面不得重新设计）：
 *
 * - 规则版本是**不可变历史**：本页只有「登记新版本」与只读列表，没有任何编辑、
 *   删除或覆盖入口；调整规则必须登记新版本，服务端以递增 `version` 保留旧记录。
 * - 本页**不做任何试算**：没有已核准规则时不出金额，页面也不显示 ¥0、应收 / 应
 *   付金额或任何客户端计算出的分成金额。
 * - 比例一律以基点表示（10,000 bp = 100%，1 bp = 0.01%）；页面只做换算说明与
 *   「合计必须精确等于 10000」的契约校验，不预填任何费率默认值。
 * - 固定策略（计费基数、舍入、冲正、部分退款）是契约字面量，只读展示，页面不提供
 *   切换入口。
 * - 只有管理员能登记版本；运营员只读且请求始终带自己的授权社区；网格员由页面级
 *   403 与服务端 403 拒绝。
 */

interface RuleFormValues {
  mappingId?: string
  agreementRef?: string
  approvalEvidenceRef?: string
  approvalOn?: string
  effectiveFrom?: string
  effectiveTo?: string
  processorFeeBps?: number
  processorFeeOwner?: string
  ratesBps?: {
    seller?: number
    sanchuang?: number
    guangdian?: number
  }
  roundingRecipient?: string
}

const RATE_SUM_MESSAGE = '三方合约分配比例必须精确合计 10000 基点'
const RATE_RANGE_MESSAGE = '比例必须是 0-10000 的整数基点'
const FEE_OWNER_MESSAGE = '手续费为 0 时必须选择「无手续费」；大于 0 时必须选择具体承担方'

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

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function ratesSummary(row: SettlementRuleVersion): string {
  return `seller ${row.ratesBps.seller} / sanchuang ${row.ratesBps.sanchuang} / guangdian ${row.ratesBps.guangdian} bp`
}

const FIXED_POLICY_KEYS = [
  'feeBase',
  'roundingPolicy',
  'processorFeeRounding',
  'reversalPolicy',
  'partialRefundPolicy',
] as const

export function SettlementRulesPanel() {
  const { session } = useAdminAuth()
  const { message } = AntdApp.useApp()
  const authorizedCommunities = session.staff.communities
  const isAdmin = session.staff.role === 'admin'
  const hasAuthorizedScope = isAdmin || authorizedCommunities.length > 0

  /* ------------------------------ rule versions ---------------------------- */

  const [communityId, setCommunityId] = useState<string | undefined>(
    isAdmin ? undefined : authorizedCommunities[0]?.id,
  )
  const [rules, setRules] = useState<SettlementRuleVersion[] | null>(null)
  const [mappings, setMappings] = useState<SettlementMapping[] | null>(null)
  const [parties, setParties] = useState<SettlementParty[] | null>(null)
  const [products, setProducts] = useState<LocalProductSummary[]>([])
  const [productError, setProductError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!hasAuthorizedScope) {
      setRules(null)
      setLoading(false)
      return
    }
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setRules(null)
    setMappings(null)
    setParties(null)
    setProducts([])
    setProductError(null)
    void Promise.all([
      listSettlementRuleVersions({ communityId }, controller.signal),
      listSettlementMappings({ communityId }, controller.signal),
      listSettlementParties({ communityId }, controller.signal),
      listAdminProducts({ page: 1, pageSize: 100, communityId }, controller.signal)
        .then((result) => result.items)
        .catch((cause: unknown) => {
          if (!active || controller.signal.aborted) return []
          setProductError(describeLocalError(cause, '商品名称加载失败'))
          return [] as LocalProductSummary[]
        }),
    ])
      .then(([ruleRows, mappingRows, partyRows, productRows]) => {
        if (!active) return
        setRules(ruleRows)
        setMappings(mappingRows)
        setParties(partyRows)
        setProducts(productRows)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setRules(null)
        setError(cause instanceof Error ? cause : new Error('合同规则版本加载失败'))
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
  const mappingById = useMemo(
    () => new Map((mappings ?? []).map((mapping) => [mapping.id, mapping])),
    [mappings],
  )

  /* --------------------------- create a new version ------------------------ */

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [form] = Form.useForm<RuleFormValues>()
  const watchedRates = Form.useWatch('ratesBps', form)
  const rateSum =
    (watchedRates?.seller ?? 0) +
    (watchedRates?.sanchuang ?? 0) +
    (watchedRates?.guangdian ?? 0)

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

  const submitRule = async (values: RuleFormValues) => {
    if (submitting) return
    const agreementRef = (values.agreementRef ?? '').trim()
    const approvalEvidenceRef = (values.approvalEvidenceRef ?? '').trim()
    const approvalOn = (values.approvalOn ?? '').trim()
    const effectiveFrom = (values.effectiveFrom ?? '').trim()
    const effectiveTo = (values.effectiveTo ?? '').trim()
    const seller = values.ratesBps?.seller
    const sanchuang = values.ratesBps?.sanchuang
    const guangdian = values.ratesBps?.guangdian
    const processorFeeBps = values.processorFeeBps
    const processorFeeOwner = values.processorFeeOwner
    if (
      !values.mappingId ||
      !values.roundingRecipient ||
      processorFeeBps === undefined ||
      !processorFeeOwner ||
      seller === undefined ||
      sanchuang === undefined ||
      guangdian === undefined
    ) {
      return
    }
    // Defensive re-checks: a submit must never reach the network when the
    // shared contract's cross-field rules are already violated.
    if (seller + sanchuang + guangdian !== 10_000) {
      setSubmitError(RATE_SUM_MESSAGE)
      return
    }
    if ((processorFeeBps === 0) !== (processorFeeOwner === 'none')) {
      setSubmitError(FEE_OWNER_MESSAGE)
      return
    }
    if (approvalOn > effectiveFrom) {
      setSubmitError('核准日期必须不晚于规则生效起始日')
      return
    }
    if (effectiveTo < effectiveFrom) {
      setSubmitError('规则终止日不能早于起始日')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const created = await createSettlementRuleVersion(session.csrfToken, {
        mappingId: values.mappingId,
        agreementRef,
        approvalEvidenceRef,
        approvalOn,
        effectiveFrom,
        effectiveTo,
        // The contract fixes these literals: the page never lets a human switch
        // them into a different policy.
        feeBase: 'actual_received',
        processorFeeBps,
        processorFeeOwner: processorFeeOwner as 'none' | 'seller' | 'sanchuang' | 'guangdian',
        ratesBps: { seller, sanchuang, guangdian },
        roundingRecipient: values.roundingRecipient as 'seller' | 'sanchuang' | 'guangdian',
        roundingPolicy: 'floor_then_named_remainder',
        processorFeeRounding: 'floor',
        reversalPolicy: 'full_reversal_blocks',
        partialRefundPolicy: 'unsupported_blocks',
      })
      setDrawerOpen(false)
      form.resetFields()
      message.success(
        `已登记合同规则版本（${created.effectiveFrom} ~ ${created.effectiveTo}）。规则版本不可修改，调整必须登记新版本。`,
      )
      // Re-read the history instead of inserting a client-side row.
      setReloadToken((value) => value + 1)
    } catch (cause: unknown) {
      setSubmitError(describeLocalError(cause, '登记合同规则版本失败'))
    } finally {
      setSubmitting(false)
    }
  }

  /* -------------------------------- columns -------------------------------- */

  const unauthorized = isLocalApiError(error) && error.status === 401
  const forbidden = isLocalApiError(error) && error.status === 403
  const errorText = error ? describeLocalError(error, '合同规则版本加载失败') : null

  const columns: ColumnsType<SettlementRuleVersion> = [
    {
      title: '版本号',
      key: 'version',
      render: (_value, row) => <Typography.Text strong>v{row.version}</Typography.Text>,
    },
    {
      title: '映射 / 商品',
      key: 'mapping',
      render: (_value, row) => {
        const mapping = mappingById.get(row.mappingId)
        const productName = productNameById.get(mapping?.productId ?? row.productId)
        const sellerName = partyNameById.get(mapping?.sellerPartyId ?? row.sellerPartyId)
        return (
          <Space orientation="vertical" size={2}>
            <span>
              {productName ?? (
                <span className="ledger-cell-mono" title={mapping?.productId ?? row.productId}>
                  {shortId(mapping?.productId ?? row.productId)}
                </span>
              )}
            </span>
            <Typography.Text type="secondary" className="ledger-cell-mono" style={{ fontSize: 12 }}>
              映射 {shortId(row.mappingId)}
            </Typography.Text>
            <Typography.Text type="secondary">
              销售商户：{sellerName ?? shortId(mapping?.sellerPartyId ?? row.sellerPartyId)}
            </Typography.Text>
          </Space>
        )
      },
    },
    {
      title: '协议引用',
      key: 'agreementRef',
      render: (_value, row) => (
        <Typography.Text className="ledger-cell-mono">{row.agreementRef}</Typography.Text>
      ),
    },
    {
      title: '核准依据',
      key: 'approvalEvidenceRef',
      render: (_value, row) => (
        <Typography.Text className="ledger-cell-mono">{row.approvalEvidenceRef}</Typography.Text>
      ),
    },
    {
      title: '核准日期',
      key: 'approvalOn',
      render: (_value, row) => row.approvalOn,
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
      title: '三方比例（基点）',
      key: 'rates',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span className="ledger-cell-mono">{ratesSummary(row)}</span>
          <Typography.Text type="secondary">1 bp = 0.01%；10000 bp = 100%</Typography.Text>
        </Space>
      ),
    },
    {
      title: '手续费',
      key: 'processorFee',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>{row.processorFeeBps} bp</span>
          <Typography.Text type="secondary">
            承担方：{SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS[row.processorFeeOwner]}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '舍入接收方',
      key: 'roundingRecipient',
      render: (_value, row) => SETTLEMENT_RULE_PARTY_KEY_LABELS[row.roundingRecipient],
    },
    {
      title: '核准人',
      key: 'approvedBy',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text className="ledger-cell-mono" style={{ fontSize: 12 }}>
            {row.approvedByUserId}
          </Typography.Text>
          <Typography.Text type="secondary">{formatDateTime(row.approvedAt)}</Typography.Text>
        </Space>
      ),
    },
  ]

  /* -------------------------------- options -------------------------------- */

  const mappingOptions = (mappings ?? []).map((mapping) => ({
    value: mapping.id,
    label: `${productNameById.get(mapping.productId) ?? shortId(mapping.productId)} · ${
      mapping.effectiveFrom
    } ~ ${mapping.effectiveTo} · ${shortId(mapping.id)}`,
  }))

  const ownerOptions = (
    Object.keys(SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS) as Array<
      keyof typeof SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS
    >
  ).map((value) => ({ value, label: SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS[value] }))

  const partyKeyOptions = (
    Object.keys(SETTLEMENT_RULE_PARTY_KEY_LABELS) as Array<
      keyof typeof SETTLEMENT_RULE_PARTY_KEY_LABELS
    >
  ).map((value) => ({ value, label: SETTLEMENT_RULE_PARTY_KEY_LABELS[value] }))

  const emptyText = (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无已核准合同规则／待核定">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        没有已核准的合同规则时，系统不会产生确定的应收 / 应付金额；本视图只展示历史版本，不做任何试算，也不展示任何金额。
      </Typography.Paragraph>
    </Empty>
  )

  return (
    <section aria-label="合同规则版本">
      <Alert
        type="info"
        showIcon
        title="规则版本只读 · 登记不等于结算或付款"
        description="规则版本一经登记不可修改，调整必须登记新版本；无已核准规则时不出金额；规则登记 ≠ 结算单锁定 ≠ 付款。历史版本按 version 递增原样列出，本视图没有任何编辑或删除入口。"
      />

      {!hasAuthorizedScope ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="当前账号没有可用的社区范围"
          description="运营员与网格员必须由管理员分配至少一个社区后，才能查看合同规则版本。本视图没有发起任何请求，也不会用空列表冒充「尚无已核准合同规则」。"
        />
      ) : unauthorized ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="登录状态已失效"
          description={`服务端返回 401：请重新登录管理后台后再查看合同规则版本。${errorText ?? ''}`}
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
          title="没有查看合同规则的权限"
          description={`${errorText ?? ''} 网格员没有合同规则权限；服务端直接返回 403。`}
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
          title="已核准合同规则（只读历史）"
          extra={
            <Space wrap size={8}>
              <Button size="small" onClick={refresh} loading={loading}>
                刷新
              </Button>
              {/* Registration is admin-only; there is never an edit/delete path. */}
              {isAdmin ? (
                <Button size="small" type="primary" onClick={openDrawer}>
                  登记规则版本
                </Button>
              ) : null}
            </Space>
          }
        >
          {authorizedCommunities.length > 0 ? (
            <div className="ledger-filter-field" style={{ marginBottom: 12 }}>
              <label htmlFor="settlement-rule-community">社区范围</label>
              <Select<string>
                id="settlement-rule-community"
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
              title="合同规则版本加载失败"
              description={errorText ?? undefined}
              action={
                <Button size="small" onClick={refresh}>
                  重试
                </Button>
              }
            />
          ) : rules === null ? (
            <div className="ledger-candidate-loading" aria-live="polite">
              <Spin />
              <Typography.Text type="secondary">正在读取合同规则版本…</Typography.Text>
            </div>
          ) : (
            <>
              <Table<SettlementRuleVersion>
                rowKey="id"
                columns={columns}
                dataSource={rules}
                loading={loading}
                size="small"
                pagination={false}
                scroll={{ x: 'max-content' }}
                locale={{ emptyText }}
              />
              {productError ? (
                <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                  商品名称加载失败：{productError} 上表因此只显示商品 ID 短号，规则版本本身不受影响。
                </Typography.Paragraph>
              ) : null}
            </>
          )}
        </Card>
      )}

      {/* --------------------------------- drawer -------------------------------- */}
      {isAdmin ? (
        <Drawer
          title="登记合同规则版本"
          size={620}
          open={drawerOpen}
          onClose={closeDrawer}
          rootClassName="local-drawer"
          destroyOnHidden
        >
          <Typography.Paragraph type="secondary">
            登记的是已核准合同的不可变版本：保存后不能修改，调整必须登记新版本。本页不预填任何费率或金额，只做共享契约能表达的校验，也不做任何试算。
          </Typography.Paragraph>
          <Form<RuleFormValues>
            form={form}
            layout="vertical"
            onFinish={(values) => void submitRule(values)}
          >
            {submitError ? (
              <Alert
                type="error"
                showIcon
                title="规则版本未登记"
                description={submitError}
                style={{ marginBottom: 12 }}
              />
            ) : null}

            <Form.Item
              name="mappingId"
              label="商户映射版本"
              rules={[{ required: true, message: '请选择商户映射版本' }]}
              tooltip="只能基于已登记的商品 → 三方主体映射登记规则；映射与规则的生效区间不必相同。"
            >
              <Select
                placeholder={
                  mappingOptions.length > 0 ? '请选择映射版本' : '当前范围尚无映射版本，请先登记商户映射'
                }
                options={mappingOptions}
              />
            </Form.Item>

            <Form.Item
              name="agreementRef"
              label="协议引用"
              rules={[
                { required: true, whitespace: true, message: '请填写协议引用' },
                trimmedLengthRule('协议引用', 2, 200),
              ]}
            >
              <Input maxLength={200} placeholder="例如 AG-2026-001" />
            </Form.Item>

            <Form.Item
              name="approvalEvidenceRef"
              label="核准依据"
              rules={[
                { required: true, whitespace: true, message: '请填写核准依据' },
                trimmedLengthRule('核准依据', 2, 200),
              ]}
              tooltip="可核对的人工核准材料引用，2-200 个字符。"
            >
              <Input maxLength={200} placeholder="例如董事会决议编号或审批单号" />
            </Form.Item>

            <Form.Item
              name="approvalOn"
              label="核准日期"
              dependencies={['effectiveFrom']}
              rules={[
                { required: true, whitespace: true, message: '请填写核准日期' },
                {
                  validator: (): Promise<void> => {
                    const approvalOn = (form.getFieldValue('approvalOn') as string | undefined)?.trim()
                    const effectiveFrom = (
                      form.getFieldValue('effectiveFrom') as string | undefined
                    )?.trim()
                    if (!approvalOn || !effectiveFrom) return Promise.resolve()
                    if (approvalOn > effectiveFrom) {
                      return Promise.reject(new Error('核准日期必须不晚于规则生效起始日'))
                    }
                    return Promise.resolve()
                  },
                },
              ]}
            >
              <Input maxLength={10} placeholder="YYYY-MM-DD" />
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
                      return Promise.reject(new Error('规则终止日不能早于起始日'))
                    }
                    return Promise.resolve()
                  },
                },
              ]}
            >
              <Input maxLength={10} placeholder="YYYY-MM-DD" />
            </Form.Item>

            <Form.Item
              name="processorFeeBps"
              label="手续费（基点）"
              rules={[{ required: true, message: '请填写手续费基点；无手续费请填 0' }]}
              tooltip="0 表示无手续费。页面不提供任何默认费率。"
            >
              <InputNumber
                min={0}
                max={10_000}
                precision={0}
                style={{ width: '100%' }}
                placeholder="基点，10000=100%"
              />
            </Form.Item>

            <Form.Item
              name="processorFeeOwner"
              label="手续费承担方"
              dependencies={['processorFeeBps']}
              rules={[
                { required: true, message: '请选择手续费承担方' },
                {
                  validator: (): Promise<void> => {
                    const fee = form.getFieldValue('processorFeeBps') as number | undefined
                    const owner = form.getFieldValue('processorFeeOwner') as string | undefined
                    if (fee === undefined || !owner) return Promise.resolve()
                    if ((fee === 0) !== (owner === 'none')) {
                      return Promise.reject(new Error(FEE_OWNER_MESSAGE))
                    }
                    return Promise.resolve()
                  },
                },
              ]}
              tooltip="手续费为 0 必须选「无手续费」；大于 0 必须选具体承担方。"
            >
              <Select placeholder="请选择手续费承担方" options={ownerOptions} />
            </Form.Item>

            <Typography.Text strong>三方合同分配比例（基点）</Typography.Text>
            <div style={{ marginBottom: 8 }}>
              <Typography.Text
                type={rateSum === 10_000 ? 'success' : 'danger'}
                aria-live="polite"
              >
                三方合计：{rateSum} / 10000 bp（1 bp = 0.01%）；必须精确等于 10000
              </Typography.Text>
            </div>
            {(
              [
                ['seller', `${SETTLEMENT_PARTY_ROLE_LABELS.seller}比例`],
                ['sanchuang', `${SETTLEMENT_PARTY_ROLE_LABELS.sanchuang}比例`],
                ['guangdian', `${SETTLEMENT_PARTY_ROLE_LABELS.guangdian}比例`],
              ] as const
            ).map(([key, label]) => (
              <Form.Item
                key={key}
                name={['ratesBps', key]}
                label={label}
                rules={[
                  { required: true, message: `请填写${label}` },
                  {
                    validator: (): Promise<void> => {
                      const rates = form.getFieldValue('ratesBps') as
                        | { seller?: number; sanchuang?: number; guangdian?: number }
                        | undefined
                      if (!rates) return Promise.resolve()
                      const { seller, sanchuang, guangdian } = rates
                      if (seller === undefined || sanchuang === undefined || guangdian === undefined) {
                        return Promise.resolve()
                      }
                      for (const value of [seller, sanchuang, guangdian]) {
                        if (!Number.isInteger(value) || value < 0 || value > 10_000) {
                          return Promise.reject(new Error(RATE_RANGE_MESSAGE))
                        }
                      }
                      if (seller + sanchuang + guangdian !== 10_000) {
                        return Promise.reject(new Error(RATE_SUM_MESSAGE))
                      }
                      return Promise.resolve()
                    },
                  },
                ]}
                dependencies={[['ratesBps', 'seller'], ['ratesBps', 'sanchuang'], ['ratesBps', 'guangdian']]}
              >
                <InputNumber
                  min={0}
                  max={10_000}
                  precision={0}
                  style={{ width: '100%' }}
                  placeholder="基点，10000=100%"
                />
              </Form.Item>
            ))}

            <Form.Item
              name="roundingRecipient"
              label="舍入余额接收方"
              rules={[{ required: true, message: '请选择舍入余额接收方' }]}
              tooltip="按契约向下取整后，整数分余额全部归该主体。"
            >
              <Select placeholder="请选择舍入余额接收方" options={partyKeyOptions} />
            </Form.Item>

            <section className="local-section" aria-label="固定策略">
              <Typography.Text strong>固定策略（契约固定，不可切换）</Typography.Text>
              <ul>
                {FIXED_POLICY_KEYS.map((key) => (
                  <li key={key}>{SETTLEMENT_RULE_FIXED_POLICY_LABELS[key]}</li>
                ))}
              </ul>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                计费基数为凭据实际到账金额；规则登记 ≠ 结算单锁定 ≠ 付款。
              </Typography.Paragraph>
            </section>

            <Space wrap style={{ marginTop: 16 }}>
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
