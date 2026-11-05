import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {import.meta.env.BASE_URL === '/' ? (
      <BrowserRouter><App /></BrowserRouter>
    ) : (
      <HashRouter><App /></HashRouter>
    )}
  </StrictMode>,
)
