import { useCallback, useEffect, useState } from 'react'
import type { PaymentCapabilities } from '@sanchuang-dev/local-life-contracts'
import { getPaymentCapabilities } from '../services/localPayments'
import { describeLocalError } from '../services/localApi'

export type PaymentCapabilitiesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; capabilities: PaymentCapabilities }

/**
 * Reads server payment capability truth. The browser never derives a payment
 * mode from `import.meta.env`; a missing server flag means no payment button.
 */
export function usePaymentCapabilities() {
  const [state, setState] = useState<PaymentCapabilitiesState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    getPaymentCapabilities(controller.signal)
      .then((capabilities) => {
        if (!controller.signal.aborted) setState({ status: 'ready', capabilities })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          message: describeLocalError(cause, '暂时无法确认支付能力，请稍后刷新'),
        })
      })
    return () => controller.abort()
  }, [reloadToken])

  return { state, reload }
}
