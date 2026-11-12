/** The staff workbench has a separate auth system; /login must never guard itself. */
export function isResidentGateExempt(pathname: string): boolean {
  return pathname === '/login' || pathname === '/workbench' || pathname.startsWith('/workbench/')
}
