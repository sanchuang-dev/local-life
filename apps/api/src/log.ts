/** Machine-readable JSON logs; one event per line for local and container log collection. */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }))
}
