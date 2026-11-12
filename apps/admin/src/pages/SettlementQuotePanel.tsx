import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Input,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { useState } from 'react'
import type { SettlementQuoteResponse } from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { formatCents } from '../services/ledger'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import { quoteSettlementOrder } from '../services/settlement'
import './ledger.css'

/**
 * 分成结算单 · 服务端试算（LL-SET-010B / Issue #222）。
 *
 * 这一段只展示服务端按**已核准规则**算出的试算结果，绝不本地试算：
 *
 * - 输入只有一个订单 UUID；页面不读取 #188 候选行、不接收候选 DTO，也不改候选
 *   语义。UUID 合法性由服务端判定（400/404 原样展示）。
 * - `pending_rule` 与 `blocked` 只展示服务端返回的阻塞原因，**不显示任何金额**，
 *   更不会用 ¥0 把「待核定」伪装成零应付。
 * - 只有 `quoteOnly === true` 且 `allocation` 非空时才显示服务端返回的整数分；
 *   金额一律经 `formatCents` 原样格式化，前端不做任何加减乘除或费率计算。
 * - `payableAmountCents` 在契约里恒为 null：试算 ≠ 实际应付 ≠ 结算单锁定 ≠ 付款。
 * - 401/403/404/400/网络错误都按真实状态展示，不渲染空的成功卡片。
 */

const STATUS_META = {
  pending_rule: { label: '待核定', color: 'orange' },
  blocked: { label: '已阻塞', color: 'red' },
  calculated: { label: '仅试算', color: 'blue' },
} as const

export function SettlementQuotePanel() {
  const { session } = useAdminAuth()
  const { message } = AntdApp.useApp()

  const [orderId, setOrderId] = useState('')
  const [quoting, setQuoting] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const [result, setResult] = useState<SettlementQuoteResponse | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const runQuote = async () => {
    if (quoting) return
    const trimmed = orderId.trim()
    if (!trimmed) {
      // Empty input never becomes a request; the server is not asked to guess.
      setInputError('请先填写订单 UUID，再发起服务端试算。')
      return
    }
    setInputError(null)
    setQuoting(true)
    setError(null)
    setResult(null)
    try {
      const response = await quoteSettlementOrder(session.csrfToken, trimmed)
      setResult(response)
      // Nothing here is a payable/payment; the message must not imply one.
      message.info('服务端试算已返回。试算不是应付金额，也不是付款或结算单锁定。')
    } catch (cause: unknown) {
      setResult(null)
      setError(cause instanceof Error ? cause : new Error('服务端试算失败'))
    } finally {
      setQuoting(false)
    }
  }

  const unauthorized = isLocalApiError(error) && error.status === 401
  const forbidden = isLocalApiError(error) && error.status === 403
  const notFound = isLocalApiError(error) && error.status === 404
  const badRequest = isLocalApiError(error) && error.status === 400
  const errorText = error ? describeLocalError(error, '服务端试算失败') : null

  return (
    <section aria-label="服务端试算">
      <Alert
        type="info"
        showIcon
        title="试算 ≠ 实际应付 ≠ 结算单锁定 ≠ 付款"
        description={
          <>
            <p style={{ marginBottom: 4 }}>
              试算由服务端按已核准规则计算，前端只展示返回结果，不按费率乘金额。
            </p>
            <p style={{ marginBottom: 4 }}>
              quoteOnly / payableAmountCents 恒为空，说明这不是应付金额：试算结果不能作为付款依据，也不代表结算单已锁定。
            </p>
            <p style={{ marginBottom: 0 }}>
              本视图不读取候选看板的行数据，也不改变候选 DTO；订单 UUID 由本地输入，合法性由服务端校验。
            </p>
          </>
        }
      />

      <Card size="small" style={{ marginTop: 12 }} title="服务端试算（只读）">
        <Space wrap size={12} align="end">
          <div className="ledger-filter-field">
            <label htmlFor="settlement-quote-order-id">订单 ID</label>
            <Input
              id="settlement-quote-order-id"
              style={{ width: 340 }}
              maxLength={64}
              placeholder="订单 UUID"
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              onPressEnter={() => void runQuote()}
            />
            <span className="ledger-filter-hint">
              只发送 orderId；服务端按已核准规则试算，前端不做任何计算。
            </span>
          </div>
          <Button
            type="primary"
            onClick={() => void runQuote()}
            loading={quoting}
            disabled={quoting}
          >
            试算
          </Button>
        </Space>

        {inputError ? (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            title="尚未发起试算"
            description={inputError}
          />
        ) : null}

        {error ? (
          <Alert
            style={{ marginTop: 12 }}
            type={unauthorized || forbidden ? 'warning' : 'error'}
            showIcon
            title={
              unauthorized
                ? '登录状态已失效'
                : forbidden
                  ? '没有试算权限'
                  : notFound
                    ? '订单或试算来源不存在'
                    : badRequest
                      ? '试算请求不合法'
                      : '服务端试算失败'
            }
            description={errorText ?? undefined}
            action={
              <Button size="small" onClick={() => void runQuote()} disabled={quoting}>
                重试
              </Button>
            }
          />
        ) : quoting ? (
          <div className="ledger-candidate-loading" aria-live="polite">
            <Spin />
            <Typography.Text type="secondary">正在请求服务端试算…</Typography.Text>
          </div>
        ) : result ? (
          <QuoteResult result={result} />
        ) : (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            输入订单 UUID 后点「试算」。本页只展示服务端返回的状态、阻塞原因与整数分；没有返回值时不显示任何金额。
          </Typography.Paragraph>
        )}
      </Card>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Quote result: the three server statuses, rendered as returned              */
/* -------------------------------------------------------------------------- */

function QuoteResult({ result }: { result: SettlementQuoteResponse }) {
  const meta = STATUS_META[result.status]
  const calculated =
    result.status === 'calculated' && result.quoteOnly === true && result.allocation !== null

  return (
    <div style={{ marginTop: 12 }}>
      <Space wrap size={8} style={{ marginBottom: 8 }}>
        <Typography.Text strong>试算状态</Typography.Text>
        <Tag color={meta.color}>{meta.label}</Tag>
        <Typography.Text type="secondary">quoteOnly：{String(result.quoteOnly)}</Typography.Text>
        <Typography.Text type="secondary">payableAmountCents：恒为空</Typography.Text>
      </Space>

      {result.status === 'pending_rule' ? (
        <Alert
          type="warning"
          showIcon
          title="尚无适用于该订单的已核准规则／待核定"
          description="服务端返回 pending_rule：没有可用的已核准合同规则版本。本视图不显示任何金额，也不会按费率自行试算；请先在「合同规则」登记并核准规则版本。"
        />
      ) : result.status === 'blocked' ? (
        <Alert
          type="error"
          showIcon
          title="该订单当前不可试算（blocked）"
          description="服务端返回 blocked：下方阻塞原因逐条来自服务端。本视图不显示金额，也不推测修复后的结果。"
        />
      ) : calculated ? (
        <Alert
          type="success"
          showIcon
          title="服务端已完成试算（仅试算，不是应付，也不是付款）"
          description="以下金额全部是服务端返回的整数分，经 formatCents 原样格式化；本页不做任何加减乘除，也不按费率乘金额。quoteOnly=true 且 payableAmountCents 恒为 null。"
        />
      ) : (
        <Alert
          type="warning"
          showIcon
          title="服务端返回 calculated，但缺少 quoteOnly / allocation"
          description="页面不会补造金额或默认分配；请以服务端返回为准并联系维护者核对契约。"
        />
      )}

      {result.status !== 'calculated' ? (
        <section className="local-section" aria-label="阻塞原因" style={{ marginTop: 12 }}>
          <Typography.Text strong>阻塞原因（服务端原文）</Typography.Text>
          {result.blockingReasons.length === 0 ? (
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              服务端未返回阻塞原因。
            </Typography.Paragraph>
          ) : (
            <ol className="ledger-candidate-blocking">
              {result.blockingReasons.map((reason, index) => (
                <li key={`${reason}-${index}`}>
                  <div className="ledger-candidate-blocking-message">{reason}</div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {calculated && result.allocation ? (
        <AllocationDetails allocation={result.allocation} />
      ) : null}

      <SourceDetails result={result} />
    </div>
  )
}

function AllocationDetails({
  allocation,
}: {
  allocation: NonNullable<SettlementQuoteResponse['allocation']>
}) {
  return (
    <section className="local-section" aria-label="试算金额（整数分）" style={{ marginTop: 12 }}>
      <Typography.Text strong>试算金额（服务端返回的整数分，仅试算）</Typography.Text>
      <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
        <Descriptions.Item label="凭据实收毛额">
          {formatCents(allocation.grossReceivedCents)}
        </Descriptions.Item>
        <Descriptions.Item label="手续费">
          {formatCents(allocation.processorFeeCents)}
        </Descriptions.Item>
        <Descriptions.Item label="销售商户净额">
          {formatCents(allocation.sellerNetCents)}
        </Descriptions.Item>
        <Descriptions.Item label="三创净额">
          {formatCents(allocation.sanchuangNetCents)}
        </Descriptions.Item>
        <Descriptions.Item label="广电净额">
          {formatCents(allocation.guangdianNetCents)}
        </Descriptions.Item>
        <Descriptions.Item label="三方合计净额">
          {formatCents(allocation.totalNetCents)}
        </Descriptions.Item>
        <Descriptions.Item label="守恒校验合计（毛额 = 净额 + 手续费）">
          {formatCents(allocation.conservedTotalCents)}
        </Descriptions.Item>
        <Descriptions.Item label="舍入余数">
          {formatCents(allocation.roundingResidualCents)}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        以上数字与服务端返回逐一对应，本页没有求和、求差或再分配。试算 ≠ 实际应付 ≠ 结算单锁定 ≠ 付款。
      </Typography.Paragraph>
    </section>
  )
}

function SourceDetails({ result }: { result: SettlementQuoteResponse }) {
  return (
    <section className="local-section" aria-label="试算来源" style={{ marginTop: 12 }}>
      <Typography.Text strong>来源追踪（服务端返回）</Typography.Text>
      <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
        <Descriptions.Item label="订单 ID">
          <Typography.Text className="ledger-cell-mono">{result.orderId}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="收款流水">
          {result.receiptEntryId ? (
            <Typography.Text className="ledger-cell-mono">
              {result.receiptEntryId}
            </Typography.Text>
          ) : (
            '服务端未返回'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="规则版本">
          {result.rule ? (
            <Space wrap size={8}>
              <Tag color="blue">v{result.rule.version}</Tag>
              <Typography.Text className="ledger-cell-mono">{result.rule.id}</Typography.Text>
            </Space>
          ) : (
            '服务端未返回'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="销售商户主体 ID">
          {result.sellerPartyId ? (
            <Typography.Text className="ledger-cell-mono">{result.sellerPartyId}</Typography.Text>
          ) : (
            '服务端未返回'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="三创主体 ID">
          {result.sanchuangPartyId ? (
            <Typography.Text className="ledger-cell-mono">
              {result.sanchuangPartyId}
            </Typography.Text>
          ) : (
            '服务端未返回'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="广电主体 ID">
          {result.guangdianPartyId ? (
            <Typography.Text className="ledger-cell-mono">
              {result.guangdianPartyId}
            </Typography.Text>
          ) : (
            '服务端未返回'
          )}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        缺失字段显示「服务端未返回」，不补默认值。payableAmountCents 恒为空（不是应付金额）。
      </Typography.Paragraph>
    </section>
  )
}
