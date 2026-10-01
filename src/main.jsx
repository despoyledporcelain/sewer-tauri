import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './app.jsx'

/* bridge.js импортируется из app.jsx — фасад window.electronAPI к этому
   моменту уже стоит (порядок модулей: bridge → react → app) */
createRoot(document.getElementById('root')).render(<App />)
