import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { fileURLToPath } from 'node:url'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))
  return {
    resolve: { alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ENV: 'test',
            APP_ORIGIN: 'http://example.com',
            SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
            DATA_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
          },
        },
      }),
    ],
    test: { setupFiles: ['./tests/setup.ts'], include: ['tests/**/*.test.ts'] },
  }
})
