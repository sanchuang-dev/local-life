import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App'
import { adminTheme } from './app/theme'
import './index.css'

// Bookmarked /#/... links must continue opening their original page.
const oldRoute = window.location.hash.slice(1)
if (window.location.pathname === '/' && oldRoute.startsWith('/') && !oldRoute.startsWith('//')) {
  window.history.replaceState(window.history.state, '', oldRoute)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        {/* HashRouter keeps the static admin build usable without server rewrites. */}
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
)
