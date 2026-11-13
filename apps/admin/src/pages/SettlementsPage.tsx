import { useState } from 'react'
import { Result, Tabs, Tag } from 'antd'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { PageInfoScope } from '../components/PageInfoHelp'
import { SettlementCandidatePanel } from './SettlementCandidatePanel'
import { SettlementMappingPanel } from './SettlementMappingPanel'
import { SettlementPartyPanel } from './SettlementPartyPanel'
import { SettlementQuotePanel } from './SettlementQuotePanel'
import { SettlementRulesPanel } from './SettlementRulesPanel'
import { SettlementStatementPanel } from './SettlementStatementPanel'
import './ledger.css'

type SettlementView = 'candidates' | 'parties' | 'mappings' | 'rules' | 'quote' | 'statements'

/** Settlement has its own route and header tabs; reconciliation lives at /reconciliation. */
export function SettlementsPage() {
  const { session } = useAdminAuth()
  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="分成结算"
          description="主体、合同规则、试算和结算单只对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <Result status="403" title="网格员没有分成结算权限" />
      </div>
    )
  }
  return <SettlementConsole />
}

function SettlementConsole() {
  const [active, setActive] = useState<SettlementView>('candidates')
  // Keep visited views mounted, preserving their filters/drafts on tab changes.
  // Unvisited panels never mount or issue requests.
  const [mounted, setMounted] = useState<ReadonlySet<SettlementView>>(
    () => new Set<SettlementView>(['candidates']),
  )
  const selectTab = (key: string) => {
    const next: SettlementView =
      key === 'parties' || key === 'mappings' || key === 'rules' ||
      key === 'quote' || key === 'statements'
        ? key : 'candidates'
    setMounted((current) => new Set(current).add(next))
    setActive(next)
  }

  return (
    <div className="page settlement-page">
      <PageHeader
        title="分成结算"
        description="主体确认、合同规则、试算与结算单按各自业务事实管理；试算不等于应付，锁单不等于付款。"
        subnav={
          <Tabs
            activeKey={active}
            onChange={selectTab}
            items={[
              { key: 'candidates', label: '候选看板' },
              { key: 'parties', label: '主体目录' },
              { key: 'mappings', label: '商户映射' },
              { key: 'rules', label: '合同规则' },
              { key: 'quote', label: '服务端试算' },
              { key: 'statements', label: '结算单' },
            ]}
          />
        }
      />
      <div className="page-stack settlement-page-body">
        <div className="ledger-tabpanel" role="tabpanel" aria-label="分成结算单">
          {mounted.has('candidates') && (
            <div hidden={active !== 'candidates'}><PageInfoScope active={active === 'candidates'}><SettlementCandidatePanel /></PageInfoScope></div>
          )}
          {mounted.has('parties') && (
            <div hidden={active !== 'parties'}><PageInfoScope active={active === 'parties'}><SettlementPartyPanel /></PageInfoScope></div>
          )}
          {mounted.has('mappings') && (
            <div hidden={active !== 'mappings'}><PageInfoScope active={active === 'mappings'}><SettlementMappingPanel /></PageInfoScope></div>
          )}
          {mounted.has('rules') && (
            <div hidden={active !== 'rules'}><PageInfoScope active={active === 'rules'}><SettlementRulesPanel /></PageInfoScope></div>
          )}
          {mounted.has('quote') && (
            <div hidden={active !== 'quote'}><PageInfoScope active={active === 'quote'}><SettlementQuotePanel /></PageInfoScope></div>
          )}
          {mounted.has('statements') && (
            <div hidden={active !== 'statements'}><PageInfoScope active={active === 'statements'}><SettlementStatementPanel /></PageInfoScope></div>
          )}
        </div>
      </div>
    </div>
  )
}
