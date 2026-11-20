import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './app.jsx'
import { MotionConfig } from 'framer-motion'

/* bridge.js импортируется из app.jsx — фасад window.electronAPI к этому
   моменту уже стоит (порядок модулей: bridge → react → app) */
createRoot(document.getElementById('root')).render(<MotionConfig reducedMotion="user"><App /></MotionConfig>)
