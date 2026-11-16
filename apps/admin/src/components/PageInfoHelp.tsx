import { QuestionCircleOutlined } from '@ant-design/icons'
import { Alert, Button, Tooltip, Typography } from 'antd'
import type { AlertProps } from 'antd'
import {
  createContext, useContext, useEffect, useId, useMemo,
  useSyncExternalStore,
} from 'react'
import type { ReactNode } from 'react'

interface HelpEntry {
  id: string
  title: ReactNode
  description?: ReactNode
}

class HelpRegistry {
  private items = new Map<string, HelpEntry>()
  private snapshot: HelpEntry[] = []
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = () => this.snapshot

  register = (entry: HelpEntry) => {
    this.items.set(entry.id, entry)
    this.notify()
  }

  unregister = (id: string) => {
    if (!this.items.delete(id)) return
    this.notify()
  }

  private notify() {
    this.snapshot = [...this.items.values()]
    this.listeners.forEach((listener) => listener())
  }
}

const RegistryContext = createContext<HelpRegistry | null>(null)
const VisibleContext = createContext(true)
const EMPTY: HelpEntry[] = []
const noSubscribe = () => () => undefined
const emptySnapshot = () => EMPTY

/** Page-scoped registry: informational content is published by children
 * but presented once in the PageHeader, beside the title. */
export function PageInfoProvider({ children }: { children: ReactNode }) {
  const registry = useMemo(() => new HelpRegistry(), [])
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
}

/** Keep-alive tab panels should publish explanations only when selected. */
export function PageInfoScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parentVisible = useContext(VisibleContext)
  return <VisibleContext.Provider value={parentVisible && active}>{children}</VisibleContext.Provider>
}

function Explanation({ entries }: { entries: HelpEntry[] }) {
  return (
    <div className="page-info-tooltip-content">
      {entries.map((entry) => (
        <div className="page-info-tooltip-entry" key={entry.id}>
          <Typography.Text strong>{entry.title}</Typography.Text>
          {entry.description ? <div className="page-info-tooltip-description">{entry.description}</div> : null}
        </div>
      ))}
    </div>
  )
}

export function PageInfoControl() {
  const registry = useContext(RegistryContext)
  const entries = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  )
  if (!entries.length) return null
  return (
    <Tooltip
      trigger={['hover', 'click']}
      placement="bottomLeft"
      title={<Explanation entries={entries}/>}
      styles={{ root: { maxWidth: 'min(440px, calc(100vw - 32px))' } }}
    >
      <Button
        type="text"
        size="small"
        shape="circle"
        icon={<QuestionCircleOutlined />}
        aria-label="页面说明"
        className="page-info-trigger"
      />
    </Tooltip>
  )
}

/** Replaces *only* informational AntD Alerts. Errors, warnings, action feedback
 * and business states stay in place. Outside the app's help provider (isolated
 * component tests) it safely falls back to the original Alert. */
export function PageInfoAlert({
  title, message, description, inline = false, ...props
}: AlertProps & { inline?: boolean }) {
  const registry = useContext(RegistryContext)
  const isActive = useContext(VisibleContext)
  const id = useId()
  const label = title ?? message

  useEffect(() => {
    if (!registry || !isActive || !label) return
    registry.register({ id, title: label, description })
    return () => registry.unregister(id)
  }, [registry, isActive, id, label, description])

  if (!registry) return <Alert {...props} type="info" title={title} message={message} description={description} />
  // The page title is behind the overlay mask while a drawer/modal is open.
  // Contextual help inside those overlays must remain reachable.
  if (inline && label) {
    return (
      <Tooltip
        title={<Explanation entries={[{ id, title: label, description }]} />}
        trigger={['hover', 'click']}
        placement="topLeft"
        styles={{ root: { maxWidth: 'min(440px, calc(100vw - 32px))' } }}
      >
        <Button
          type="text" size="small" shape="circle"
          icon={<QuestionCircleOutlined />}
          aria-label="操作说明"
          className="page-info-trigger"
        />
      </Tooltip>
    )
  }
  return null
}
