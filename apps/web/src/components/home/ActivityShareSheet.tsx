import { useState } from 'react'
import { Copy, Share2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import type { PublicActivityDetail } from '@sanchuang-dev/local-life-contracts'
import { CampaignSheet } from '../CampaignSheet'
import type { WechatShareStatus } from '../../hooks/useWechatActivityShare'

type ShareStatus = 'idle' | 'shared' | 'copied' | 'cancelled' | 'error' | 'wechat-hint'

type ActivityShareSheetProps = {
  open: boolean
  activity: PublicActivityDetail | null
  /** One URL for the QR code, native share and copy. `null` closes the invite path. */
  shareUrl: string | null
  wechatShare: { isWechat: boolean; status: WechatShareStatus }
  seatsFilled: number | null
  seatsTotal: number | null
  onClose: () => void
}

const fallbackCopy = (value: string) => {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  return copied
}

/**
 * Invite sheet for the real three-person team of *this* activity.
 *
 * The QR code, the native share sheet and "copy link" all use the single URL the
 * server-backed participation state produced (activity id + the team's real
 * invite code). No invite code is invented, and the sheet never claims a locked
 * (3/3) team can still add members.
 */
export function ActivityShareSheet({
  open,
  activity,
  shareUrl,
  wechatShare,
  seatsFilled,
  seatsTotal,
  onClose,
}: ActivityShareSheetProps) {
  const [status, setStatus] = useState<ShareStatus>('idle')
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const handleCopyLink = async () => {
    if (!shareUrl) {
      setStatus('error')
      return
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl)
      } else if (!fallbackCopy(shareUrl)) {
        throw new Error('copy failed')
      }
      setStatus('copied')
    } catch {
      setStatus('error')
    }
  }

  const handleSystemShare = async () => {
    if (!shareUrl) {
      setStatus('error')
      return
    }
    if (wechatShare.isWechat) {
      setStatus('wechat-hint')
      return
    }
    if (!canNativeShare) {
      await handleCopyLink()
      return
    }
    try {
      await navigator.share({
        title: activity?.title ?? '社区活动',
        text: '还差街坊一起组成三人团，来一起参加本场活动。',
        url: shareUrl,
      })
      setStatus('shared')
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error')
    }
  }

  return (
    <CampaignSheet
      open={open}
      title="邀请街坊加入三人团"
      eyebrow={
        seatsFilled !== null && seatsTotal !== null ? `TEAM ${seatsFilled} / ${seatsTotal}` : 'TEAM'
      }
      variant="poster"
      onClose={() => {
        setStatus('idle')
        onClose()
      }}
      footer={
        shareUrl ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleSystemShare()}
                className="flex min-h-[48px] items-center justify-center gap-1.5 rounded-[13px] bg-teal-700 px-2 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <Share2 size={17} aria-hidden="true" />
                {wechatShare.isWechat ? '微信内分享' : '转发给好友'}
              </button>
              <button
                type="button"
                onClick={() => void handleCopyLink()}
                className="flex min-h-[48px] items-center justify-center gap-1.5 rounded-[13px] border border-teal-200 bg-white px-2 text-[13px] font-semibold text-teal-700 transition-colors hover:bg-[#f2faf6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <Copy size={17} aria-hidden="true" />
                复制链接
              </button>
            </div>
            <p className="mt-2 text-center text-[11px] leading-4 text-slate-400">
              {wechatShare.isWechat
                ? '请通过微信右上角「···」菜单选择发送给朋友或分享到朋友圈；二维码和复制使用同一邀请链接。'
                : '分享活动链接给街坊。'}
            </p>
            <div className="text-center text-[12px] font-medium" aria-live="polite">
              {wechatShare.isWechat && wechatShare.status === 'loading' ? (
                <p className="mt-1 text-slate-500">正在准备微信分享；也可以先复制链接或扫码。</p>
              ) : null}
              {wechatShare.isWechat && wechatShare.status === 'error' ? (
                <p className="mt-1 text-orange-700">微信分享初始化失败，请使用复制链接或二维码。</p>
              ) : null}
              {status === 'wechat-hint' ? (
                <p className="mt-1 text-teal-700">点击微信右上角「···」菜单，再选择好友或朋友圈。</p>
              ) : null}
              {status === 'shared' ? (
                <p className="mt-1 text-teal-700">已调起系统分享，好友需登录并主动确认才会加入。</p>
              ) : null}
              {status === 'copied' ? (
                <p className="mt-1 text-teal-700">邀请链接已复制，包含当前活动与邀请参数。</p>
              ) : null}
              {status === 'cancelled' ? (
                <p className="mt-1 text-slate-500">已取消分享，可再次点击转发。</p>
              ) : null}
              {status === 'error' ? (
                <p className="mt-1 text-orange-700">分享或复制未成功，请稍后重试。</p>
              ) : null}
            </div>
          </>
        ) : undefined
      }
    >
      {shareUrl ? (
        <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-[20px] border border-[#deebdf] bg-[#f4faf3] shadow-[0_9px_25px_rgba(26,88,62,0.08)]">
          <div className="px-3 pb-3 pt-3">
            <div className="text-center">
              <p className="text-[17px] font-bold leading-6 text-[#176149]">还差你，三人成团领好礼</p>
              <p className="mt-1 text-[12px] text-[#547c6c]">
                {activity?.community.name ?? '本社区'} · 已有 {seatsFilled ?? 0} / {seatsTotal ?? 3} 位街坊
              </p>
            </div>
            <div className="mt-3 rounded-[14px] border border-[#deece1] bg-white px-3 py-3 text-center">
              <div className="relative mx-auto w-fit rounded-lg bg-white">
                <QRCodeSVG
                  value={shareUrl}
                  size={148}
                  level="H"
                  marginSize={3}
                  fgColor="#195B4C"
                  bgColor="#FFFFFF"
                  title="本场活动邀请二维码"
                />
              </div>
              <p className="mt-2 text-[12px] font-semibold text-[#2f765f]">
                扫码打开本活动 · 邻里一起领好礼
              </p>
            </div>
            <p className="mt-2 text-center text-[11px] leading-4 text-slate-500">
              好友打开链接后，需要主动确认才能加入三人团。
            </p>
          </div>
        </div>
      ) : (
        <p className="rounded-[14px] bg-slate-50 p-3 text-[13px] leading-6 text-slate-500">
          当前没有可用的邀请码（团队可能已满员、已锁定或你尚未参与）。邀请入口已关闭，请刷新参与状态。
        </p>
      )}
    </CampaignSheet>
  )
}
