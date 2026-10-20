import './zod-config'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@xyflow/react/dist/style.css'
import './index.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root element')
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Installability is a nicety; the ledger view works without the worker.
  })
}
