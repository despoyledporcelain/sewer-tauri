import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/* порт 1420 — дефолтный devUrl tauri.conf.json, менять надо оба */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    /* Явно оба адреса. По умолчанию vite слушает только ::1 (ipv6), а
       tauri dev стучится на 127.0.0.1 (ipv4) и вечно ждёт «Waiting for
       your frontend dev server» — при этом vite рапортовал, что готов. */
    host: ['127.0.0.1', '::1'],
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    /* webview2 на win10/11 — chrome105+, не выше: esbuild-таргет влияет только
       на синтаксис, всё равно режет esbuild-минификацией */
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      output: {
        /* framer-motion — единственная тяжёлая библиотека, которая нужна на
           КАЖДОМ кадре (все 42 использования <motion.*> в app.jsx). Ленивым
           его делать нельзя, но и тащить в общий чанк с app-кодом незачем:
           отдельный vendor-чанк кэшируется webview независимо от app.jsx —
           при пересборке приложения в dev-цикле движок перечитывает только
           изменённый app.jsx, а framer-motion остаётся в HTTP-кэше. */
        manualChunks(id) {
          if (id.includes('node_modules/framer-motion')) return 'framer-motion'
        },
      },
    },
  },
})
