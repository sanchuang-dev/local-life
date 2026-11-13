import { PageInfoAlert } from '../components/PageInfoHelp'
import {
  Alert,
  App as AntdApp,
  Button,
  Drawer,
  Empty,
  Form,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnsType } from 'antd/es/table'
import type {
  ActivityDrawPool,
  ActivityDrawPrize,
  ActivityStatus,
} from '@sanchuang-dev/local-life-contracts'
import type { AuthenticatedSession } from '../services/auth'
import {
  createActivityDrawPrize,
  getActivityDrawPool,
  saveActivityDrawPool,
  updateActivityDrawPrize,
} from '../services/drawPool'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import { listAdminProducts } from '../services/localCatalog'
import './draw-pool.css'

/**
 * "今日抽奖" configuration drawer (LL-LOT-001, #173).
 *
 * Every value is real: products come from the local catalogue, stock lives in
 * `activity_draw_prizes`, and an empty/unconfigured pool is stated honestly.
 * This card never draws, never shows a fake winner and never restores the old
 * prototype lottery UI.
 */

const STATUS_LABEL: Record<ActivityStatus, string> = {
  draft: '草稿',
  published: '已发布',
  paused: '已暂停',
  ended: '已结束',
}

const PRODUCT_STATUS_LABEL: Record<'on_shelf' | 'off_shelf', string> = {
  on_shelf: '商品已上架',
  off_shelf: '商品已下架',
}

export interface DrawPoolActivity {
  id: string
  title: string
  community: { id: string; name: string }
  status: ActivityStatus
}

interface DrawPoolDrawerProps {
  open: boolean
  activity: DrawPoolActivity | null
  session: AuthenticatedSession
  onClose: () => void
}

interface PrizeFormValues {
  productId?: string
  costYuan?: number
  totalQuantity: number
  weight: number
  enabled: boolean
}

function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

function percentOf(weight: number, total: number): string {
  if (total <= 0) return '0%'
  return `${(weight * 100 / total).toFixed(2)}%`
}

export function DrawPoolDrawer({ open, activity, session, onClose }: DrawPoolDrawerProps) {
  const { message } = AntdApp.useApp()
  const [pool, setPool] = useState<ActivityDrawPool | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadToken, setLoadToken] = useState(0)

  const [enabled, setEnabled] = useState(false)
  const [dailyLimit, setDailyLimit] = useState<number>(1)
  const [noPrizeWeight, setNoPrizeWeight] = useState<number>(0)
  const [savingConfig, setSavingConfig] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  const [prizeModalOpen, setPrizeModalOpen] = useState(false)
  const [editingPrize, setEditingPrize] = useState<ActivityDrawPrize | null>(null)
  const [prizeSaving, setPrizeSaving] = useState(false)
  const [prizeError, setPrizeError] = useState<string | null>(null)
  const [form] = Form.useForm<PrizeFormValues>()

  const [products, setProducts] = useState<
    Array<{ id: string; name: string; priceCents: number; status: 'on_shelf' | 'off_shelf' }>
  >([])
  const [productsLoading, setProductsLoading] = useState(false)
  const [productsError, setProductsError] = useState<string | null>(null)
  const productRequestToken = useRef(0)
  const productSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    productRequestToken.current += 1
    if (productSearchTimer.current !== null) clearTimeout(productSearchTimer.current)
  }, [])

  const activityId = activity?.id ?? null
  const readOnly = (pool?.activityStatus ?? activity?.status) === 'ended'

  function handleClose() {
    productRequestToken.current += 1
    if (productSearchTimer.current !== null) clearTimeout(productSearchTimer.current)
    setPrizeModalOpen(false)
    setEditingPrize(null)
    setPrizeError(null)
    setConfigError(null)
    onClose()
  }

  useEffect(() => {
    if (!open || !activityId) return
    let active = true
    const controller = new AbortController()

    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const result = await getActivityDrawPool(activityId as string, controller.signal)
        if (!active) return
        setPool(result)
        setEnabled(result.enabled)
        setDailyLimit(result.dailyDrawLimitPerResident > 0 ? result.dailyDrawLimitPerResident : 1)
        setNoPrizeWeight(result.noPrizeWeight)
      } catch (cause: unknown) {
        if (!active || controller.signal.aborted) return
        setPool(null)
        setLoadError(describeLocalError(cause, '抽奖奖品池加载失败'))
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [open, activityId, loadToken])

  const configuredProductIds = useMemo(
    () => new Set(pool?.prizes.map((prize) => prize.productId) ?? []),
    [pool],
  )

  // Weights are relative, not percentages. Recalculate as the operator edits the
  // no-win weight; sold-out or disabled prizes must not inflate displayed odds.
  const probability = useMemo(() => {
    const availablePrizes = (pool?.prizes ?? []).filter(
      (prize) => prize.enabled && prize.remainingQuantity > 0 && prize.weight > 0,
    )
    const prizeWeight = availablePrizes.reduce((sum, prize) => sum + prize.weight, 0)
    return {
      availablePrizes,
      total: prizeWeight + noPrizeWeight,
      prizeWeight,
    }
  }, [pool, noPrizeWeight])

  const productOptions = useMemo(
    () =>
      products
        .filter((product) => !configuredProductIds.has(product.id))
        .map((product) => ({
          value: product.id,
          label: `${product.name} · ${formatCents(product.priceCents)} · ${
            PRODUCT_STATUS_LABEL[product.status]
          }`,
        })),
    [products, configuredProductIds],
  )

  async function reload() {
    setLoadToken((value) => value + 1)
  }

  async function submitConfig() {
    if (!activityId) return
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
      setConfigError('每日抽奖次数必须是大于 0 的整数')
      return
    }
    setSavingConfig(true)
    setConfigError(null)
    try {
      const saved = await saveActivityDrawPool(session.csrfToken, activityId, {
        expectedUpdatedAt: pool?.updatedAt ?? null,
        enabled,
        dailyDrawLimitPerResident: dailyLimit,
        noPrizeWeight,
      })
      setPool(saved)
      setEnabled(saved.enabled)
      setDailyLimit(saved.dailyDrawLimitPerResident)
      setNoPrizeWeight(saved.noPrizeWeight)
      message.success(saved.enabled ? '抽奖奖品池已启用' : '抽奖配置已保存，当前未启用')
    } catch (cause: unknown) {
      setConfigError(describeLocalError(cause, '抽奖配置保存失败'))
      if (isLocalApiError(cause) && cause.status === 409) void reload()
    } finally {
      setSavingConfig(false)
    }
  }

  async function disableNow() {
    if (!activityId) return
    setSavingConfig(true)
    setConfigError(null)
    try {
      const saved = await saveActivityDrawPool(session.csrfToken, activityId, {
        expectedUpdatedAt: pool?.updatedAt ?? null,
        enabled: false,
        dailyDrawLimitPerResident: Math.max(1, dailyLimit),
        noPrizeWeight,
      })
      setPool(saved)
      setEnabled(false)
      setDailyLimit(saved.dailyDrawLimitPerResident)
      setNoPrizeWeight(saved.noPrizeWeight)
      message.success('抽奖已关闭，居民端立即返回不可用')
    } catch (cause: unknown) {
      setConfigError(describeLocalError(cause, '关闭抽奖失败'))
    } finally {
      setSavingConfig(false)
    }
  }

  function searchProducts(keyword: string, immediate = false) {
    if (!activity?.community.id) return
    if (productSearchTimer.current !== null) clearTimeout(productSearchTimer.current)
    const requestToken = ++productRequestToken.current
    const communityId = activity.community.id
    setProductsLoading(true)
    setProductsError(null)
    productSearchTimer.current = setTimeout(() => {
      // Server-side keyword filtering works beyond the first 100 items in the
      // community catalogue. Only the most recent response may update options.
      void listAdminProducts({
        page: 1,
        pageSize: 100,
        communityId,
        keyword: keyword.trim() || undefined,
      })
        .then((result) => {
          if (productRequestToken.current === requestToken) setProducts(result.items)
        })
        .catch((cause: unknown) => {
          if (productRequestToken.current === requestToken) {
            setProductsError(describeLocalError(cause, '本地商品列表加载失败'))
          }
        })
        .finally(() => {
          if (productRequestToken.current === requestToken) setProductsLoading(false)
        })
    }, immediate ? 0 : 250)
  }

  function openAddPrize() {
    setEditingPrize(null)
    setPrizeError(null)
    form.resetFields()
    form.setFieldsValue({ totalQuantity: 1, weight: 10, enabled: true })
    setPrizeModalOpen(true)
    searchProducts('', true)
  }

  function openEditPrize(prize: ActivityDrawPrize) {
    setEditingPrize(prize)
    setPrizeError(null)
    form.resetFields()
    form.setFieldsValue({
      totalQuantity: prize.totalQuantity,
      weight: prize.weight,
      enabled: prize.enabled,
    })
    setPrizeModalOpen(true)
  }

  async function submitPrize(values: PrizeFormValues) {
    if (!activityId) return
    const productId = values.productId
    const explicitCostCents = values.costYuan === undefined
      ? null
      : Math.round(values.costYuan * 100)
    if (!editingPrize && (
      explicitCostCents === null ||
      !Number.isSafeInteger(explicitCostCents) ||
      explicitCostCents < 0 ||
      explicitCostCents > 1_000_000_000
    )) {
      setPrizeError('请填写实际每份履约成本（元），免费赠品请明确填写 0')
      return
    }
    if (!editingPrize && !productId) {
      setPrizeError('请选择真实商品')
      return
    }
    setPrizeSaving(true)
    setPrizeError(null)
    try {
      if (editingPrize) {
        await updateActivityDrawPrize(session.csrfToken, activityId, editingPrize.id, {
          expectedUpdatedAt: editingPrize.updatedAt,
          totalQuantity: values.totalQuantity,
          weight: values.weight,
          enabled: values.enabled,
        })
        message.success('奖品已更新')
      } else if (productId) {
        await createActivityDrawPrize(session.csrfToken, activityId, {
          productId,
          costCents: explicitCostCents!,
          totalQuantity: values.totalQuantity,
          weight: values.weight,
          enabled: values.enabled,
        })
        message.success('奖品已加入抽奖奖品池')
      }
      setPrizeModalOpen(false)
      setEditingPrize(null)
      await reload()
    } catch (cause: unknown) {
      setPrizeError(describeLocalError(cause, '奖品保存失败'))
      if (isLocalApiError(cause) && cause.status === 409) await reload()
    } finally {
      setPrizeSaving(false)
    }
  }

  const columns: ColumnsType<ActivityDrawPrize> = [
    {
      key: 'prize',
      title: '奖品（配置时快照）',
      render: (_value: unknown, prize: ActivityDrawPrize) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{prize.productName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已确认履约成本 {formatCents(prize.costCents)}
          </Typography.Text>
          <Tag color={prize.productStatus === 'on_shelf' ? 'green' : 'default'}>
            {PRODUCT_STATUS_LABEL[prize.productStatus]}
          </Tag>
        </Space>
      ),
    },
    {
      key: 'stock',
      title: '总量 / 已抽 / 剩余',
      render: (_value: unknown, prize: ActivityDrawPrize) => (
        <Typography.Text>
          {prize.totalQuantity} / {prize.drawnQuantity} / {prize.remainingQuantity}
        </Typography.Text>
      ),
    },
    {
      key: 'weight',
      title: '权重',
      dataIndex: 'weight',
    },
    {
      key: 'enabled',
      title: '投放',
      render: (_value: unknown, prize: ActivityDrawPrize) => (
        <Tag color={prize.enabled ? 'green' : 'default'}>
          {prize.enabled ? '启用' : '停用'}
        </Tag>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (_value: unknown, prize: ActivityDrawPrize) => (
        <Button size="small" disabled={readOnly} onClick={() => openEditPrize(prize)}>
          编辑
        </Button>
      ),
    },
  ]

  return (
    <Drawer
      title={activity ? `今日抽奖 · ${activity.title}` : '今日抽奖'}
      size={720}
      open={open}
      onClose={handleClose}
      rootClassName="draw-pool-drawer"
    >
      {loading ? (
        <div className="draw-pool-loading">
          <Spin description="正在读取抽奖奖品池…" />
        </div>
      ) : null}
      <div className="draw-pool-body">
        {activity ? (
          <Space wrap size={8}>
            <Tag>{STATUS_LABEL[activity.status]}</Tag>
            <Typography.Text type="secondary">{activity.community.name}</Typography.Text>
          </Space>
        ) : null}

        <PageInfoAlert inline
          type="info"
          showIcon
          title="这里只配置真实奖品池"
          description="抽奖执行、中奖结果与兑现将在后续任务卡接入。当前不会生成任何中奖结果，也不会在居民端开放抽奖按钮；未启用时居民查询只会得到「不可用」。"
        />

        {loadError ? (
          <Alert
            type="error"
            showIcon
            title="抽奖奖品池加载失败"
            description={loadError}
            action={
              <Button size="small" onClick={() => void reload()}>
                重试
              </Button>
            }
          />
        ) : null}

        {readOnly ? (
          <Alert
            type="warning"
            showIcon
            title="活动已结束"
            description="已结束活动的抽奖配置为只读；已配置奖品与库存仍可查看。"
          />
        ) : null}

        {pool ? (
          <>
            <div className="draw-pool-config">
              <Space size={16} wrap>
                <Space size={8}>
                  <Typography.Text strong>启用今日抽奖</Typography.Text>
                  <Switch
                    checked={enabled}
                    disabled={readOnly || savingConfig}
                    onChange={setEnabled}
                  />
                </Space>
                <Space size={8}>
                  <Typography.Text>每人每日次数</Typography.Text>
                  <InputNumber
                    min={1}
                    max={100}
                    precision={0}
                    value={dailyLimit}
                    disabled={readOnly || savingConfig}
                    onChange={(value) => setDailyLimit(typeof value === 'number' ? value : 1)}
                  />
                </Space>
                <Space size={8}>
                  <Typography.Text>无中奖权重</Typography.Text>
                  <InputNumber
                    min={0}
                    max={1_000_000}
                    precision={0}
                    value={noPrizeWeight}
                    disabled={readOnly || savingConfig}
                    onChange={(value) =>
                      setNoPrizeWeight(typeof value === 'number' ? value : 0)
                    }
                  />
                </Space>
              </Space>
              <Alert
                type={probability.total > 0 && noPrizeWeight === 0 ? 'warning' : 'info'}
                showIcon
                title={probability.total > 0
                  ? `当前理论中奖率 ${percentOf(probability.prizeWeight, probability.total)} · 未中奖率 ${percentOf(noPrizeWeight, probability.total)}`
                  : '尚无可抽取的奖品，请先设置库存和权重'}
                description={
                  probability.total > 0
                    ? `各奖品当前概率：${probability.availablePrizes.map((prize) =>
                        `${prize.productName} ${percentOf(prize.weight, probability.total)}`,
                      ).join(' · ') || '无'}。以当前启用奖品及剩余库存计算，库存变动会改变概率；无中奖权重 0 意味着有库存时必中奖。`
                    : '概率权重不是百分比；系统不会自动设置或保证中奖率。'
                }
              />
              <Space wrap>
                <Button
                  type="primary"
                  loading={savingConfig}
                  disabled={readOnly}
                  onClick={() => void submitConfig()}
                >
                  保存配置
                </Button>
                {pool.enabled ? (
                  <Button danger loading={savingConfig} disabled={readOnly} onClick={() => void disableNow()}>
                    一键关闭抽奖
                  </Button>
                ) : null}
                <Typography.Text type="secondary">
                  {pool.configured
                    ? `服务端状态：${pool.enabled ? '已启用' : '未启用'}`
                    : '尚未创建抽奖配置，默认关闭'}
                </Typography.Text>
              </Space>
              {configError ? (
                <Alert type="error" showIcon title="保存失败" description={configError} />
              ) : null}
            </div>

            <div className="draw-pool-meta">
              <Typography.Text>
                奖品 {pool.prizes.length} 个 · 总量 {pool.totals.totalQuantity} · 已抽{' '}
                {pool.totals.drawnQuantity} · 剩余 {pool.totals.remainingQuantity}
              </Typography.Text>
            </div>

            <div className="draw-pool-toolbar">
              <Button
                type="primary"
                disabled={readOnly || !pool.configured}
                onClick={openAddPrize}
              >
                添加真实商品奖品
              </Button>
              {!pool.configured ? (
                <Typography.Text type="secondary">请先保存基础配置，再添加奖品。</Typography.Text>
              ) : null}
            </div>

            {pool.prizes.length === 0 ? (
              <Empty description="奖品池为空。没有真实商品和库存时不会对居民展示可抽奖状态。" />
            ) : (
              <Table<ActivityDrawPrize>
                rowKey={(prize) => prize.id}
                size="small"
                pagination={false}
                dataSource={pool.prizes}
                columns={columns}
                scroll={{ x: 'max-content' }}
              />
            )}
          </>
        ) : null}
      </div>

      <Modal
        title={editingPrize ? `编辑奖品 · ${editingPrize.productName}` : '添加真实商品奖品'}
        open={prizeModalOpen}
        okText={editingPrize ? '保存' : '添加'}
        cancelText="取消"
        confirmLoading={prizeSaving}
        onCancel={() => {
          if (prizeSaving) return
          setPrizeModalOpen(false)
          setEditingPrize(null)
        }}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<PrizeFormValues> form={form} layout="vertical" onFinish={submitPrize}>
          {prizeError ? (
            <Alert
              type="error"
              showIcon
              title="保存失败"
              description={prizeError}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          {editingPrize ? null : (
            <Form.Item
              name="productId"
              label="真实商品"
              rules={[{ required: true, message: '请选择商品' }]}
              tooltip="只能选择活动所属社区内的本地商品；名称、图片与成本会以配置时的快照保存。"
            >
              <Select
                showSearch
                filterOption={false}
                onSearch={(value) => searchProducts(value)}
                loading={productsLoading}
                placeholder={productsError ?? '输入商品名称搜索全部社区商品'}
                options={productOptions}
                notFoundContent={productsError ? '商品加载失败' : '无匹配商品，请换个关键词'}
              />
            </Form.Item>
          )}
          {editingPrize ? null : (
            <Form.Item
              name="costYuan"
              label="每份奖品实际履约成本（元）"
              rules={[{ required: true, message: '请输入实际成本；免费赠品请填写 0' }]}
              tooltip="运营确认的采购或实际履约成本。不会自动使用商品售价；零成本赠品请明确填 0。"
            >
              <InputNumber min={0} max={10_000_000} precision={2} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item
            name="totalQuantity"
            label="奖品总量"
            rules={[{ required: true, message: '请填写总量' }]}
            tooltip={
              editingPrize?.drawnQuantity
                ? `已抽取 ${editingPrize.drawnQuantity} 个，总量不能低于该值；调整总量只会按差值增减剩余库存。`
                : '每个奖品有独立库存，与三人团奖品库存无关。'
            }
          >
            <InputNumber
              min={editingPrize ? Math.max(1, editingPrize.drawnQuantity) : 1}
              max={100_000}
              precision={0}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            name="weight"
            label="概率权重"
            rules={[{ required: true, message: '请填写权重' }]}
            tooltip="非负整数，权重越大被抽中的相对概率越高；0 表示不计入抽取。"
          >
            <InputNumber min={0} max={1_000_000} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label="投放启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  )
}
