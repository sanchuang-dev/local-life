import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router'
import App from './App'
import './index.css'

// Online MVP upgrades old shared /#/... links, including invitation queries.
const oldRoute = window.location.hash.slice(1)
if (import.meta.env.BASE_URL === '/' && window.location.pathname === '/' &&
    oldRoute.startsWith('/') && !oldRoute.startsWith('//')) {
  window.history.replaceState(window.history.state, '', oldRoute)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {import.meta.env.BASE_URL === '/' ? (
      <BrowserRouter><App /></BrowserRouter>
    ) : (
      <HashRouter><App /></HashRouter>
    )}
  </StrictMode>,
)
