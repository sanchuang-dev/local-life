import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router'
import App from './App'
import { legacyHashRouteToClean } from './components/activity/loginReturn'
import './index.css'

// Online MVP upgrades old shared `/#/...` links, including activity invitation
// queries (`?activityId=..&invite=..`) and OAuth returns (`?auth=success`).
// The Pages preview is built with a non-root base and keeps its HashRouter
// routes, so normalisation only applies to the clean-path BrowserRouter build.
const legacyRoute = legacyHashRouteToClean({
  baseUrl: import.meta.env.BASE_URL,
  pathname: window.location.pathname,
  search: window.location.search,
  hash: window.location.hash,
})
if (legacyRoute) {
  window.history.replaceState(
    window.history.state,
    '',
    `${legacyRoute.pathname}${legacyRoute.search}${legacyRoute.hash}`,
  )
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
