import { Route, Routes } from 'react-router'
import { MiniProgramShell } from './components/MiniProgramShell'
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
import { HomePage } from './pages/HomePage'
import { LifePage } from './pages/LifePage'
import { PointsPage } from './pages/PointsPage'
import { ProductPage } from './pages/ProductPage'
import { ScaffoldPage } from './pages/ScaffoldPage'

export default function App() {
  return (
    <MiniProgramShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/gd" element={<GdPage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/community/broadcast" element={<CommunityBroadcastPage />} />
        <Route path="/community/activity" element={<CommunityActivityPage />} />
        <Route path="/community/culture" element={<CommunityCulturePage />} />
        <Route path="/community/notice/:noticeId" element={<CommunityNoticePage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/health/assistant" element={<HealthAssistantPage />} />
        <Route path="/health/device" element={<HealthDevicePage />} />
        <Route path="/health/lecture" element={<HealthLecturePage />} />
        <Route path="/life" element={<LifePage />} />
        <Route path="/life/exchange" element={<ExchangePage />} />
        <Route path="/life/product/:productId" element={<ProductPage />} />
        <Route path="/points" element={<PointsPage />} />
        <Route path="/me/devices" element={<HealthDevicesPage />} />
        <Route
          path="/discover"
          element={<ScaffoldPage variant="discover" />}
        />
        <Route
          path="/me"
          element={<ScaffoldPage variant="me" />}
        />
        <Route path="*" element={<ScaffoldPage variant="not-found" />} />
      </Routes>
    </MiniProgramShell>
  )
}
