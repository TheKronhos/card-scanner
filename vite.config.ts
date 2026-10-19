/// <reference types="vitest/config" />
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// In dev, serve a locally built data pack (../mtg-scanner-data/site) at /dev-pack/ so Refresh works offline.
function devPack(): Plugin {
  const dir = fileURLToPath(new URL('../mtg-scanner-data/site/', import.meta.url))
  return {
    name: 'dev-pack',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/dev-pack/', (req, res, next) => {
        const file = dir + decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream')
        res.setHeader('Content-Length', statSync(file).size)
        createReadStream(file).pipe(res)
      })
    },
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    devPack(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Card Scanner',
        short_name: 'Card Scanner',
        description: 'Catalog Magic: The Gathering cards, offline.',
        theme_color: '#14161a',
        background_color: '#14161a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            // Card thumbnails seen once stay available offline.
            urlPattern: /^https:\/\/cards\.scryfall\.io\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'scryfall-images',
              expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
})
