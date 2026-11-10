import { Route, Routes } from 'react-router'
import { AppShell } from './components/shell/AppShell'
import { RequireResidentAuth } from './components/auth/RequireResidentAuth'
import { ResidentAuthProvider } from './hooks/useResidentAuth'
import { ActivityHomePage } from './pages/ActivityHomePage'
import { CommunityDiscoveryPage } from './pages/CommunityDiscoveryPage'
import { isLegacyActivityHome } from './lib/communityHomeRoute'
import { useLocation } from 'react-router'
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

export default function App() {
  return (
    <ResidentAuthProvider>
      <AppShell>
      <Routes>
        <Route path="/" element={<CommunityRoot />} />
        <Route path="/gd" element={<GdPage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/community/broadcast" element={<CommunityBroadcastPage />} />
        <Route path="/community/activity" element={<CommunityActivityPage />} />
        <Route
          path="/community/activity/silver-neighborhood"
          element={<SilverNeighborhoodCampaignPage />}
        />
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
    </ResidentAuthProvider>
  )
}

/** Keep old distributed invite links intact while the default root becomes discovery. */
function CommunityRoot() {
  const location = useLocation()
  return isLegacyActivityHome(location.search)
    ? <ActivityHomePage />
    : <CommunityDiscoveryPage />
}
