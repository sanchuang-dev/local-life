import { Navigate, Route, Routes, useLocation } from 'react-router'
import { AppShell } from './components/shell/AppShell'
import { RequireResidentAuth } from './components/auth/RequireResidentAuth'
import { ResidentSiteGate } from './components/auth/ResidentSiteGate'
import { shouldShowWeChatGate } from './components/auth/wechatEnvironment'
import { ResidentAuthProvider } from './hooks/useResidentAuth'
import { OpenInWeChatPage } from './pages/OpenInWeChatPage'
import { CommunityDiscoveryPage } from './pages/CommunityDiscoveryPage'
import { ACTIVITY_DETAIL_PATH, communityRootRedirect } from './lib/communityHomeRoute'
import { CommunityActivityPage } from './pages/CommunityActivityPage'
import { CommunityBroadcastPage } from './pages/CommunityBroadcastPage'
import { CommunityCulturePage } from './pages/CommunityCulturePage'
import { CommunityNoticePage } from './pages/CommunityNoticePage'
import { CommunityPage } from './pages/CommunityPage'
import { ExchangePage } from './pages/ExchangePage'
import { GdPage } from './pages/GdPage'
import { HealthAssistantPage } from './pages/HealthAssistantPage'
import { HealthDevicePage } from './pages/HealthDevicePage'
import { HealthDevicesPage } from './pages/HealthDevicesPage'
import { HealthLecturePage } from './pages/HealthLecturePage'
import { HealthPage } from './pages/HealthPage'
import { LifePage } from './pages/LifePage'
import { LocalProductPage } from './pages/LocalProductPage'
import { MePage } from './pages/MePage'
import { ResidentCommunityConfirmPage } from './pages/ResidentCommunityConfirmPage'
import { ResidentCommunityPage } from './pages/ResidentCommunityPage'
import { ResidentLoginPage } from './pages/ResidentLoginPage'
import { MyOrderDetailPage } from './pages/MyOrderDetailPage'
import { MyOrdersPage } from './pages/MyOrdersPage'
import { MyRewardsPage } from './pages/MyRewardsPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PointsPage } from './pages/PointsPage'
import { ProductPage } from './pages/ProductPage'
import { SilverActivityProductsPage } from './pages/SilverActivityProductsPage'
import { SilverNeighborhoodCampaignPage } from './pages/SilverNeighborhoodCampaignPage'
import { WorkbenchLayout } from './pages/workbench/WorkbenchLayout'
import { WorkbenchLeadDetailPage } from './pages/workbench/WorkbenchLeadDetailPage'
import { WorkbenchLeadNewPage } from './pages/workbench/WorkbenchLeadNewPage'
import { WorkbenchLeadsPage } from './pages/workbench/WorkbenchLeadsPage'
import { WorkbenchLocalOrderDetailPage } from './pages/workbench/WorkbenchLocalOrderDetailPage'
import { WorkbenchLocalOrdersPage } from './pages/workbench/WorkbenchLocalOrdersPage'
import { WorkbenchLoginPage } from './pages/workbench/WorkbenchLoginPage'
import { WorkbenchOrderDetailPage } from './pages/workbench/WorkbenchOrderDetailPage'
import { WorkbenchOrderNewPage } from './pages/workbench/WorkbenchOrderNewPage'
import { WorkbenchOrdersPage } from './pages/workbench/WorkbenchOrdersPage'
import { WorkbenchVerifyPage } from './pages/workbench/WorkbenchVerifyPage'

// Persist the local-only UI preview switch across HashRouter navigation and login.
// Production builds never read or honor this flag.
const developmentPreviewEnabled = (() => {
  if (!import.meta.env.DEV) return false
  const previewParam = new URLSearchParams(window.location.search).get('previewApp')
  try {
    if (previewParam === '1') sessionStorage.setItem('local-life:preview-app', '1')
    if (previewParam === '0') sessionStorage.removeItem('local-life:preview-app')
    return sessionStorage.getItem('local-life:preview-app') === '1'
  } catch {
    return previewParam === '1'
  }
})()

export default function App() {
  const location = useLocation()
  if (shouldShowWeChatGate({
    userAgent: navigator.userAgent,
    pathname: location.pathname,
    search: window.location.search,
    isDevelopment: import.meta.env.DEV,
    previewSessionEnabled: developmentPreviewEnabled,
  })) return <OpenInWeChatPage />

  return (
    <ResidentAuthProvider>
      <ResidentSiteGate>
      <AppShell>
      <Routes>
        <Route path="/" element={<CommunityRoot />} />
        <Route path="/gd" element={<GdPage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/community/broadcast" element={<CommunityBroadcastPage />} />
        <Route path="/community/activity" element={<CommunityActivityPage />} />
        <Route path={ACTIVITY_DETAIL_PATH} element={<SilverNeighborhoodCampaignPage />} />
        <Route path="/community/activity/silver-neighborhood/products" element={<SilverActivityProductsPage />} />
        <Route path="/community/activity/silver-neighborhood/products/:productId" element={<SilverActivityProductsPage />} />
        <Route path="/community/activity/:activityId" element={<CommunityActivityPage />} />
        <Route path="/community/culture" element={<CommunityCulturePage />} />
        <Route path="/community/notice/:noticeId" element={<CommunityNoticePage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/health/assistant" element={<HealthAssistantPage />} />
        <Route path="/health/device" element={<HealthDevicePage />} />
        <Route path="/health/lecture" element={<HealthLecturePage />} />
        <Route path="/life" element={<LifePage />} />
        <Route path="/life/exchange" element={<ExchangePage />} />
        <Route path="/life/local-products/:productId" element={<LocalProductPage />} />
        <Route path="/life/product/:productId" element={<ProductPage />} />
        <Route path="/points" element={<PointsPage />} />
        <Route element={<RequireResidentAuth />}>
          <Route path="/me" element={<MePage />} />
          <Route path="/me/community" element={<ResidentCommunityPage />} />
          <Route path="/me/community/confirm" element={<ResidentCommunityConfirmPage />} />
          <Route path="/me/devices" element={<HealthDevicesPage />} />
          <Route path="/me/orders" element={<MyOrdersPage />} />
          <Route path="/me/orders/:localOrderId" element={<MyOrderDetailPage />} />
          <Route path="/me/rewards" element={<MyRewardsPage />} />
        </Route>
        <Route path="/login" element={<ResidentLoginPage />} />
        <Route path="/workbench" element={<WorkbenchLayout />}>
          <Route index element={<WorkbenchLoginPage />} />
          <Route path="leads" element={<WorkbenchLeadsPage />} />
          <Route path="leads/new" element={<WorkbenchLeadNewPage />} />
          <Route path="leads/:leadId" element={<WorkbenchLeadDetailPage />} />
          <Route path="leads/:leadId/orders/new" element={<WorkbenchOrderNewPage />} />
          <Route path="local-orders" element={<WorkbenchLocalOrdersPage />} />
          <Route path="local-orders/:localOrderId" element={<WorkbenchLocalOrderDetailPage />} />
          <Route path="orders" element={<WorkbenchOrdersPage />} />
          <Route path="orders/:orderId" element={<WorkbenchOrderDetailPage />} />
          <Route path="verify" element={<WorkbenchVerifyPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      </AppShell>
      </ResidentSiteGate>
    </ResidentAuthProvider>
  )
}

/**
 * The root is always the community discovery home. Old distributed
 * `/?activityId=...&invite=...` links are forwarded to the single activity
 * detail page with their query untouched, so invitation attribution and the
 * OAuth return markers survive; `replace` keeps the back button loop-free.
 */
function CommunityRoot() {
  const location = useLocation()
  const redirect = communityRootRedirect(location.search, location.state)
  return redirect
    ? <Navigate to={redirect} replace />
    : <CommunityDiscoveryPage />
}
