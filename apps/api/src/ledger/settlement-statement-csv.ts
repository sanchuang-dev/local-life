import type {
  SettlementStatement, SettlementStatementDetail, SettlementStatementLine,
  SettlementStatementPerformance,
} from '@sanchuang-dev/local-life-contracts'
import { maskPhoneNumbers } from './reconciliation-service.js'

/** CSV formula neutralization and evidence redaction, with RFC4180 quoted cells. */
export function settlementCsvCell(value: string | number | null | undefined): string {
  const masked = maskPhoneNumbers(String(value ?? ''))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, ' ')
  const escaped = /^[\u0000-\u0020]*[=+\-@]/u.test(masked) ? "'" + masked : masked
  return '"' + escaped.replace(/"/gu, '""') + '"'
}
function csv(rows: Array<Array<string | number | null | undefined>>): string {
  return '\ufeff' + rows.map(row => row.map(settlementCsvCell).join(',')).join('\r\n') + '\r\n'
}
const stateLabel = (s: SettlementStatement['status']): string => ({
  draft: '草案-待复核', reviewed: '已复核-待锁定',
  locked: '已锁定-尚未登记付款', superseded: '已被新版取代',
})[s]
const resultLabel = (l: SettlementStatementLine): string =>
  l.state === 'calculated' ? '规则已核准-仅供锁定结算' : '待核定-不可计价'
const amount = (l: SettlementStatementLine, key: 'sellerNetCents'|'sanchuangNetCents'|'guangdianNetCents'|'processorFeeCents'): number | string =>
  l.allocation ? l.allocation[key] : '待核定'

/** Snapshot-only, never recompute locked payouts from the current contract. */
export function entitySettlementCsv(detail: SettlementStatementDetail): string {
  const s = detail.statement
  const disputes = new Map(detail.postLockDisputes.map(x=>[x.orderId,x.reasons.join('；')]))
  const rows: Array<Array<string | number | null>> = [[
    '结算单号','版本','业务起始日','业务结束日','快照截至UTC','结算状态','付款状态',
    '社区ID','订单ID','订单编号','商品','订单登记分','收款流水ID','收款凭据引用',
    '实收日期UTC','实收金额分','经营对账批次ID','归属网格员ID','归属审核人ID',
    '实际销售商户主体ID','三创法律主体ID','广电法律主体ID','合同协议引用',
    '合同规则ID','规则版本','计价状态','阻塞原因','通道手续费分',
    '商户净额分','三创净额分','广电净额分','锁后争议原因',
    '复核人ID','复核依据','锁定人ID','锁定依据','快照SHA256',
  ]]
  for (const l of detail.lines) {
    rows.push([
      s.statementNo, s.generation, s.periodFrom, s.periodTo, s.asOf,
      stateLabel(s.status), '尚未付款登记', l.communityId, l.orderId,
      l.orderDisplayNo, l.productName, l.registeredAmountCents,
      l.receiptEntryId, l.receiptEvidenceRef, l.receiptReceivedAt,
      l.receiptAmountCents === null ? '未收款' : l.receiptAmountCents,
      l.operatingBatchId, l.gridStaffId, l.gridReviewerUserId,
      l.sellerPartyId, l.sanchuangPartyId, l.guangdianPartyId,
      l.agreementRef, l.ruleId, l.ruleVersion,
      resultLabel(l), l.blockingReasons.join('；'), amount(l,'processorFeeCents'),
      amount(l,'sellerNetCents'), amount(l,'sanchuangNetCents'), amount(l,'guangdianNetCents'),
      disputes.get(l.orderId) ?? '', s.reviewedByUserId,s.reviewEvidenceRef,
      s.lockedByUserId,s.lockEvidenceRef,s.snapshotDigest,
    ])
  }
  return csv(rows)
}

/** Worker performance is a COUNT of independently confirmed attribution, NOT money. */
export function gridPerformanceCsv(
  statement: SettlementStatement,
  lines: SettlementStatementLine[],
  performance: SettlementStatementPerformance[],
): string {
  const rows: Array<Array<string | number | null>> = [[
    '结算单号','版本','快照截至UTC','结算状态','付款状态',
    '社区ID','网格员ID','订单ID','订单编号','确认业绩笔数','归属审核人ID',
    '计价状态','结算相关提示','快照SHA256',
  ]]
  for(const l of lines) {
    if (!l.gridStaffId || !l.gridReviewerUserId) continue
    rows.push([
      statement.statementNo,statement.generation,statement.asOf,
      stateLabel(statement.status),'业绩不是网格员个人应付金额',
      l.communityId,l.gridStaffId,l.orderId,l.orderDisplayNo,
      1,l.gridReviewerUserId,resultLabel(l),
      l.blockingReasons.join('；'),statement.snapshotDigest,
    ])
  }
  // Existing CRM-confirmed Guangdian cases have no monetary basis at all.
  // An append-only fact counts as performance; it MUST NOT become a payment.
  for(const p of performance) {
    rows.push([
      statement.statementNo,statement.generation,statement.asOf,
      stateLabel(statement.status),'广电受理业绩不等于个人应付',
      p.communityId,p.staffId,p.sourceId,p.sourceDisplayNo,
      1,p.confirmedByUserId,'已确认业务-无金额',
      '仅计业绩笔数；没有收款金额不得计算分成',statement.snapshotDigest,
    ])
  }
  return csv(rows)
}
