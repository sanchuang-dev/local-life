import { Descriptions, Space, Tag, Typography } from 'antd'
import type {
  AdminLocalOrderDetail,
  AdminPaymentIntentSummary,
  AdminPaymentReviewExceptionSummary,
  LocalOrderOnlineConflictKind,
  PaymentReviewExceptionKind,
  PaymentStatus,
} from '@sanchuang-dev/local-life-contracts'

/**
 * PAY-08 (#283) read-only payment section of the existing order detail drawer.
 *
 * It is deliberately *display only*: no retry/refresh/“自动处理/一键修复” action,
 * because recovering money or a payment state is a separate, authorized operation.
 *
 * The copy encodes the domain boundary:
 * - 人工核验 (`verified`) is a human fact check, never a payment;
 * - `paid` means the channel confirmed a payment, never a bank settlement;
 * - Mock money is permanently labelled 模拟支付/测试 and is excluded from the
 *   real online receipt total;
 * - `bankSettlement` is a contract literal `unverified`, so this UI can never
 *   claim 已到账/已结算.
 */

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: '待支付',
  confirming: '渠道确认中',
  paid: '渠道支付已确认',
  closed: '已关闭',
  failed: '支付失败',
}

const CHANNEL_LABELS = {
  mock: '模拟渠道',
  wechat_jsapi: '微信 JSAPI',
} as const

const EVENT_LABELS: Record<string, string> = {
  'payment.intent_created': '支付单创建',
  'payment.attempt_created': '渠道尝试创建',
  'payment.status_changed': '支付状态变更',
  'payment.channel_notification': '渠道通知',
  'payment.channel_query': '渠道查单',
}

const CONFLICT_LABELS: Record<LocalOrderOnlineConflictKind, string> = {
  order_not_payable: '订单已不可支付，渠道确认待人工核对',
  order_already_completed: '订单已由另一支付事实完成',
  payment_state_invalid: '支付状态与证据不一致',
  coupon_state_invalid: '消费券状态与支付不一致',
  late_success: '关单/失败后迟到的渠道确认',
  manual_online_double_collection: '人工线下实收与在线渠道收款同时存在',
  consumer_exhausted: '订单完成消费重试耗尽，待人工恢复',
}

const REVIEW_EXCEPTION_LABELS: Record<PaymentReviewExceptionKind, string> = {
  intent_not_found: '渠道证据找不到对应支付单',
  amount_mismatch: '金额与冻结快照不一致',
  merchant_mismatch: '商户上下文不一致',
  channel_mismatch: '渠道不一致',
  ownership_mismatch: '订单/居民/社区归属不一致',
  transaction_conflict: '渠道交易号已被其他支付单占用',
  late_success_after_closed: '支付单关闭后收到渠道确认',
  late_success_after_failed: '支付单失败后收到渠道确认',
  terminal_conflict: '终态支付单收到相反证据',
  unknown_evidence: '无法识别的渠道证据',
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return DATE_TIME_FORMATTER.format(date).replace(/\//g, '-')
}

function formatPrice(cents: number): string {
  return `¥${(Math.round(cents) / 100).toFixed(2)}`
}

function modeTag(simulated: boolean) {
  return simulated ? (
    <Tag color="purple">模拟支付/测试</Tag>
  ) : (
    <Tag color="blue">真实渠道</Tag>
  )
}

/**
 * `kind='zero_amount'` (the fully coupon-discounted path) is the only legal
 * intent with no channel. It must never be rendered as a channel payment: it
 * carries no provider transaction, no channel confirmation and no cash.
 */
function isZeroAmountIntent(intent: Pick<AdminPaymentIntentSummary, 'kind' | 'channel'>): boolean {
  return intent.kind === 'zero_amount' || intent.channel === null
}

function IntentBlock({ intent }: { intent: AdminPaymentIntentSummary }) {
  const zeroAmount = isZeroAmountIntent(intent)
  return (
    <div className="local-payment-intent">
      <Space wrap size={6}>
        <Typography.Text strong>支付单 {intent.id.slice(0, 8)}</Typography.Text>
        {zeroAmount ? (
          <Tag color="cyan">零元券单（无渠道）</Tag>
        ) : (
          <>
            {modeTag(intent.simulated)}
            <Tag>{intent.channel === null ? '未知渠道' : CHANNEL_LABELS[intent.channel]}</Tag>
          </>
        )}
        <Tag color={zeroAmount ? 'cyan' : intent.status === 'paid' ? 'green' : 'default'}>
          {zeroAmount
            ? '零元券单已完成（无现金）'
            : PAYMENT_STATUS_LABELS[intent.status]}
        </Tag>
      </Space>
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="商户订单号">{intent.merchantOrderNo}</Descriptions.Item>
        <Descriptions.Item label="金额分层">
          {formatPrice(intent.grossAmountCents)} − 券抵扣{' '}
          {formatPrice(intent.discountCents)} = 净应付{' '}
          {formatPrice(intent.netPayableCents)}
        </Descriptions.Item>
        <Descriptions.Item label="有效期至">{formatDateTime(intent.expiresAt)}</Descriptions.Item>
        <Descriptions.Item label="创建 / 更新">
          {formatDateTime(intent.createdAt)} / {formatDateTime(intent.updatedAt)}
        </Descriptions.Item>
        {intent.paidAt ? (
          <Descriptions.Item label={zeroAmount ? '完成时间' : '渠道确认时间'}>
            {formatDateTime(intent.paidAt)}
          </Descriptions.Item>
        ) : null}
        {intent.closedAt ? (
          <Descriptions.Item label="关闭时间">{formatDateTime(intent.closedAt)}</Descriptions.Item>
        ) : null}
        {intent.failedAt ? (
          <Descriptions.Item label="失败时间">{formatDateTime(intent.failedAt)}</Descriptions.Item>
        ) : null}
        {intent.failureCode || intent.failureMessage ? (
          <Descriptions.Item label="失败原因">
            {intent.failureCode ?? ''}
            {intent.failureMessage ? ` · ${intent.failureMessage}` : ''}
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      {intent.attempts.length > 0 ? (
        <div className="local-payment-attempts" aria-label={`支付单 ${intent.id.slice(0, 8)} 的渠道尝试`}>
          <Typography.Text type="secondary">渠道尝试</Typography.Text>
          {intent.attempts.map((attempt) => (
            <div key={attempt.id} className="local-payment-attempt">
              <Space wrap size={6}>
                <span>第 {attempt.attemptNo} 次</span>
                <Tag>{PAYMENT_STATUS_LABELS[attempt.status]}</Tag>
                <span>
                  交易号 {attempt.providerTransactionIdMasked ?? '—'}
                </span>
                <Typography.Text type="secondary">
                  {formatDateTime(attempt.confirmedAt ?? attempt.createdAt)}
                </Typography.Text>
              </Space>
            </div>
          ))}
        </div>
      ) : (
        <Typography.Text type="secondary">
          {zeroAmount ? '零元券单不产生渠道尝试。' : '暂无渠道尝试记录。'}
        </Typography.Text>
      )}
      {intent.events.length > 0 ? (
        <div className="local-payment-events" aria-label={`支付单 ${intent.id.slice(0, 8)} 的事件`}>
          <Typography.Text type="secondary">支付事件</Typography.Text>
          {intent.events.map((event) => (
            <div key={event.id} className="local-payment-event">
              <Space wrap size={6}>
                <span>{EVENT_LABELS[event.eventType] ?? event.eventType}</span>
                {event.fromStatus || event.toStatus ? (
                  <Typography.Text type="secondary">
                    {event.fromStatus ? PAYMENT_STATUS_LABELS[event.fromStatus] : '—'} →{' '}
                    {event.toStatus ? PAYMENT_STATUS_LABELS[event.toStatus] : '—'}
                  </Typography.Text>
                ) : null}
                <Typography.Text type="secondary">
                  {formatDateTime(event.createdAt)}
                </Typography.Text>
              </Space>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ReviewExceptionRow({ exception }: { exception: AdminPaymentReviewExceptionSummary }) {
  return (
    <div className="local-payment-exception">
      <Space wrap size={6}>
        <Tag color={exception.status === 'open' ? 'red' : 'default'}>
          {REVIEW_EXCEPTION_LABELS[exception.kind]}
        </Tag>
        <span>{exception.status === 'open' ? '待核对' : exception.status === 'reviewed' ? '已查看' : '已处理'}</span>
        <Typography.Text type="secondary">
          {exception.channel === 'mock' ? '模拟渠道' : '微信 JSAPI'} · 商户单号{' '}
          {exception.merchantOrderNo}
        </Typography.Text>
      </Space>
      <Typography.Text type="secondary">
        交易号 {exception.providerTransactionIdMasked ?? '—'}
        {exception.amountCents !== null ? ` · 金额 ${formatPrice(exception.amountCents)}` : ''}
        {exception.failureCode ? ` · 失败码 ${exception.failureCode}` : ''}
        {` · 观察于 ${formatDateTime(exception.observedAt)}`}
      </Typography.Text>
    </div>
  )
}

export function OrderPaymentSection({ order }: { order: AdminLocalOrderDetail }) {
  const section = order.paymentSection
  const hasIntent = section.online.intents.length > 0
  const hasCompletion = section.online.completion !== null
  const hasOnlineReceipts = section.online.ledgerReceipts.length > 0
  const hasConflict =
    section.online.conflicts.length > 0 || section.online.reviewExceptions.length > 0

  return (
    <section className="local-section local-payment" aria-label="支付信息（只读）">
      <Space wrap size={8}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          支付与结算（只读）
        </Typography.Title>
        <Tag>只读</Tag>
      </Space>

      <div className="local-payment-layer" aria-label="订单金额分层">
        <Typography.Text strong>订单金额</Typography.Text>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="商品金额">
            {formatPrice(section.amounts.grossAmountCents)}
          </Descriptions.Item>
          <Descriptions.Item label="券抵扣">
            {formatPrice(section.amounts.couponDiscountCents)}
          </Descriptions.Item>
          <Descriptions.Item label="净应付">
            {formatPrice(section.amounts.netPayableCents)}
          </Descriptions.Item>
        </Descriptions>
      </div>

      <div className="local-payment-layer" aria-label="人工核验与线下凭据">
        <Typography.Text strong>人工核验 / 线下收款</Typography.Text>
        {section.manual.verified ? (
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="人工核验">
              已由 {section.manual.verifiedBy?.displayName ?? '运营人员'} 于{' '}
              {formatDateTime(section.manual.verifiedAt)} 完成（人工事实核验，不代表在线支付）
            </Descriptions.Item>
            {section.manual.note ? (
              <Descriptions.Item label="核验备注">{section.manual.note}</Descriptions.Item>
            ) : null}
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">本单尚无人工作出的核验终态。</Typography.Text>
        )}
        {section.manual.receipts.length > 0 ? (
          <div aria-label="人工收款凭据">
            <Typography.Text type="secondary">人工收款凭据（线下）</Typography.Text>
            {section.manual.receipts.map((receipt) => (
              <div key={receipt.entryId} className="local-payment-manual-receipt">
                <Space wrap size={6}>
                  <span>{formatPrice(receipt.amountCents)}</span>
                  <Tag>{receipt.evidenceKind === 'bank_transfer' ? '银行转账凭据' : '人工收据'}</Tag>
                  <span>凭据号 {receipt.evidenceRef ?? '—'}</span>
                  <Typography.Text type="secondary">
                    {formatDateTime(receipt.occurredAt)}
                  </Typography.Text>
                  {receipt.reversal ? (
                    <Tag color="red">
                      已冲正 {formatPrice(receipt.reversal.amountCents)}
                    </Tag>
                  ) : null}
                </Space>
              </div>
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary">
            暂无人工收款凭据。历史线下收款若未关联本单，请在经营账本按凭据号核对。
          </Typography.Text>
        )}
        {!hasIntent ? (
          <Typography.Text type="secondary">
            本单没有支付单：按下单登记与人工/线下流程处理，不显示在线支付状态。
          </Typography.Text>
        ) : null}
      </div>

      <div className="local-payment-layer" aria-label="在线渠道支付">
        <Space wrap size={6}>
          <Typography.Text strong>在线渠道支付</Typography.Text>
          {section.online.intents.some((intent) => intent.simulated) ? (
            <Tag color="purple">含模拟支付（仅测试）</Tag>
          ) : null}
        </Space>
        {!hasIntent ? (
          <Typography.Text type="secondary">未发起在线支付。</Typography.Text>
        ) : (
          section.online.intents.map((intent) => <IntentBlock key={intent.id} intent={intent} />)
        )}

        {hasCompletion && section.online.completion ? (
          <div className="local-payment-completion" aria-label="在线交易完成事实">
            <Space wrap size={6}>
              {section.online.completion.kind === 'zero_amount' ? (
                <Tag color="cyan">零元券单（无渠道）</Tag>
              ) : section.online.completion.simulated ? (
                <Tag color="purple">模拟支付/测试</Tag>
              ) : (
                <Tag color="blue">真实渠道</Tag>
              )}
              <span>
                {section.online.completion.kind === 'zero_amount'
                  ? '零元券单已完成（无现金）'
                  : '在线交易完成（渠道支付已确认）'}
              </span>
              <span>实付 {formatPrice(section.online.completion.amountCents)}</span>
              {section.online.completion.kind === 'zero_amount' ? null : (
                <span>
                  交易号 {section.online.completion.providerTransactionIdMasked ?? '—'}
                </span>
              )}
              <Typography.Text type="secondary">
                {formatDateTime(section.online.completion.completedAt)}
              </Typography.Text>
            </Space>
          </div>
        ) : (
          <Typography.Text type="secondary">尚无在线交易完成事实。</Typography.Text>
        )}

        {hasOnlineReceipts ? (
          <div aria-label="线上实收账本记录">
            <Typography.Text type="secondary">线上实收账本（online_payment）</Typography.Text>
            {section.online.ledgerReceipts.map((receipt) => (
              <div key={receipt.entryId} className="local-payment-online-receipt">
                <Space wrap size={6}>
                  {modeTag(receipt.simulated)}
                  <span>{formatPrice(receipt.amountCents)}</span>
                  <span>交易号 {receipt.providerTransactionIdMasked ?? '—'}</span>
                  <Typography.Text type="secondary">
                    {formatDateTime(receipt.occurredAt)}
                  </Typography.Text>
                </Space>
              </div>
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary">暂无线上实收账本记录。</Typography.Text>
        )}

        <div className="local-payment-totals" aria-label="实收合计口径">
          <Typography.Text type="secondary">
            人工线下实收合计 {formatPrice(section.receiptTotals.manualReceivedCents)}
          </Typography.Text>
          <Typography.Text type="secondary">
            真实线上实收合计 {formatPrice(section.receiptTotals.onlineRealReceivedCents)}
          </Typography.Text>
          <Typography.Text type="secondary">
            模拟支付实收合计 {formatPrice(section.receiptTotals.onlineSimulatedReceivedCents)}
            （不计入真实口径）
          </Typography.Text>
        </div>
      </div>

      <div className="local-payment-layer" aria-label="待核对支付异常">
        <Typography.Text strong>待核对异常（只读）</Typography.Text>
        {hasConflict ? (
          <div className="local-payment-exceptions">
            {section.online.conflicts.map((conflict) => (
              <div key={conflict.id} className="local-payment-exception">
                <Space wrap size={6}>
                  <Tag color={conflict.status === 'open' ? 'red' : 'default'}>
                    {CONFLICT_LABELS[conflict.kind]}
                  </Tag>
                  <span>
                    {conflict.status === 'open'
                      ? '待核对'
                      : conflict.status === 'reviewed'
                        ? '已查看'
                        : '已处理'}
                  </span>
                  <Typography.Text type="secondary">
                    记录于 {formatDateTime(conflict.createdAt)}
                  </Typography.Text>
                </Space>
              </div>
            ))}
            {section.online.reviewExceptions.map((exception) => (
              <ReviewExceptionRow key={exception.id} exception={exception} />
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary">当前没有待核对的支付异常。</Typography.Text>
        )}
        <Typography.Text type="secondary">
          这里只展示可定位的事实与异常原因，不提供自动恢复、重新对账或冲正操作。
        </Typography.Text>
      </div>

      <div className="local-payment-layer local-payment-settlement" aria-label="结算口径">
        <Space wrap size={8}>
          <Tag color="orange">银行结算：未核实</Tag>
          <Typography.Text type="secondary">
            渠道确认成功不等于企业银行结算到账；系统没有银行到账或结算证据，因此不展示到账/结算结论。
          </Typography.Text>
        </Space>
      </div>
    </section>
  )
}
