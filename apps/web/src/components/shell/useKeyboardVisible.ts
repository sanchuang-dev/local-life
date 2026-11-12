import { useEffect, useState } from 'react'

/**
 * The software keyboard is not exposed by a browser event. What it does do is
 * shrink the visual viewport far below the layout viewport, so we use that
 * difference: the bottom navigation steps aside while the keyboard is up and
 * the focused field keeps its caret and content visible.
 *
 * Pinch-zoom also shrinks the visual viewport, but it changes `scale`, so zoom
 * must not be mistaken for a keyboard.
 */
const OCCLUSION_THRESHOLD_PX = 120
const MAX_SCALE_WITHOUT_ZOOM = 1.05

export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const update = () => {
      const occludedBy = window.innerHeight - viewport.height
      setVisible(viewport.scale <= MAX_SCALE_WITHOUT_ZOOM && occludedBy > OCCLUSION_THRESHOLD_PX)
    }

    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])

  return visible
}
