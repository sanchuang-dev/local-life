export interface LocalPorts {
  api: number
  web: number
  admin: number
}

export const DEFAULT_LOCAL_PORTS: Readonly<LocalPorts>

export function resolveLocalPorts(values?: {
  PORT?: string | number | null
  WEB_PORT?: string | number | null
  ADMIN_PORT?: string | number | null
}): LocalPorts

export function localPortAssignments(ports: LocalPorts): Array<{ port: number; name: string }>

export function localTrustedOrigins(ports: LocalPorts): string

export function localVitePorts(env?: NodeJS.ProcessEnv): LocalPorts
