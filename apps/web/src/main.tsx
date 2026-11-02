import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Static GitHub Pages hosting does not rewrite browser-history deep links. */}
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
