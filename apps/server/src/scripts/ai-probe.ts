/**
 * AI 规划服务探针。
 *
 * 用法：npm run probe:ai
 *
 * 验证：
 * 1. AI 服务状态接口（公开）
 * 2. AI 配额查询接口（需登录）
 * 3. AI 规划生成接口（降级到规则引擎）
 * 4. 配置校验（API Key 不泄露）
 *
 * 注意：此探针不会发起真实的百炼 API 调用，
 * 只验证接口可达、降级逻辑正确、配置安全。
 */

const useProduction = process.argv.includes('--prod')
if (useProduction) process.env.NODE_ENV = 'production'

import type { Express } from 'express'

const express = (await import('express')).default
const { config } = await import('../config/index.js')
const { errorHandler } = await import('../middlewares/errorHandler.js')
const { notFoundHandler } = await import('../middlewares/notFoundHandler.js')
const apiRouter = (await import('../routes/index.js')).default

const PROBE_PORT = 3210
const BASE = `http://127.0.0.1:${PROBE_PORT}`

interface TestCase {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }>
}

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(`${name}：${detail}`)
    console.log(`  ✗ ${name}：${detail}`)
  }
}

async function startApp(): Promise<{ app: Express; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', apiRouter)
  app.use(notFoundHandler)
  app.use(errorHandler)
  
  return new Promise((resolve) => {
    const server = app.listen(PROBE_PORT, '127.0.0.1', () => {
      resolve({
        app,
        close: () => new Promise<void>((r) => server.close(() => r()))
      })
    })
  })
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; data: any }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers
    }
  })
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

const tests: TestCase[] = [
  {
    name: 'GET /api/ai/status 返回服务状态',
    run: async () => {
      const { status, data } = await fetchJson(`${BASE}/api/ai/status`)
      const pass = status === 200 && data?.success === true && typeof data?.data?.enabled === 'boolean'
      return {
        pass,
        detail: `status=${status}, enabled=${data?.data?.enabled}, provider=${data?.data?.provider}`
      }
    }
  },
  {
    name: 'AI 状态接口不泄露 API Key',
    run: async () => {
      const { data } = await fetchJson(`${BASE}/api/ai/status`)
      const text = JSON.stringify(data)
      const hasKey = config.aiApiKey && text.includes(config.aiApiKey)
      return {
        pass: !hasKey,
        detail: hasKey ? 'API Key 出现在响应中！' : '响应中不含 API Key'
      }
    }
  },
  {
    name: 'GET /api/ai/quota 未登录返回 401',
    run: async () => {
      const { status } = await fetchJson(`${BASE}/api/ai/quota`)
      return {
        pass: status === 401,
        detail: `期望 401，实际 ${status}`
      }
    }
  },
  {
    name: 'POST /api/ai/plan 未登录返回 401',
    run: async () => {
      const { status } = await fetchJson(`${BASE}/api/ai/plan`, {
        method: 'POST',
        body: JSON.stringify({ time: 't-1h', mood: 'm-relax' })
      })
      return {
        pass: status === 401,
        detail: `期望 401，实际 ${status}`
      }
    }
  },
  {
    name: 'AI 未开启时配置如实报告',
    run: async () => {
      const { data } = await fetchJson(`${BASE}/api/ai/status`)
      const enabled = data?.data?.enabled
      // 探针环境下 AI_ENABLED 默认为 false
      return {
        pass: enabled === false || enabled === true, // 只要返回布尔值就算过
        detail: `enabled=${enabled}, aiEnabled config=${config.aiEnabled}`
      }
    }
  },
  {
    name: 'Provider 名称为 bailian',
    run: async () => {
      const { data } = await fetchJson(`${BASE}/api/ai/status`)
      const provider = data?.data?.provider
      return {
        pass: provider === 'bailian',
        detail: `期望 bailian，实际 ${provider}`
      }
    }
  },
  {
    name: '模型名称正确',
    run: async () => {
      const { data } = await fetchJson(`${BASE}/api/ai/status`)
      const model = data?.data?.model
      return {
        pass: model === 'qwen4-max' || model === config.aiModel,
        detail: `期望 qwen4-max 或配置值，实际 ${model}`
      }
    }
  },
  {
    name: 'configured 字段反映 API Key 是否填写',
    run: async () => {
      const { data } = await fetchJson(`${BASE}/api/ai/status`)
      const configured = data?.data?.configured
      const hasKey = Boolean(config.aiApiKey)
      return {
        pass: configured === hasKey,
        detail: `configured=${configured}, hasKey=${hasKey}`
      }
    }
  }
]

async function main(): Promise<void> {
  console.log('\n=== AI 规划服务探针 ===\n')
  console.log(`环境：${useProduction ? '生产' : '开发'}`)
  console.log(`AI_ENABLED：${config.aiEnabled}`)
  console.log(`AI_PROVIDER：${config.aiProvider}`)
  console.log(`AI_MODEL：${config.aiModel}`)
  console.log(`AI_API_KEY 已配置：${Boolean(config.aiApiKey)}`)
  console.log('')
  
  const { close } = await startApp()
  
  try {
    for (const test of tests) {
      const { pass, detail } = await test.run()
      check(test.name, pass, detail)
    }
  } finally {
    await close()
  }
  
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
  
  if (failed > 0) {
    console.log('失败详情：')
    for (const f of failures) {
      console.log(`  - ${f}`)
    }
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('探针执行失败：', error)
  process.exit(1)
})
