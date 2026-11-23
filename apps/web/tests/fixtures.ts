import { test as base, expect } from '@playwright/test'
export type { APIRequestContext, Locator, Page } from '@playwright/test'

/**
 * 阶段3.4.3：给「已验收界面用例」固定使用示例数据模式。
 *
 * 为什么要固定：这一轮起页面默认走真实接口，而正式库 `campusgo` 的地点表虽有真实数据，
 * 挑战/徽章表仍是 0 行，且库里的内容会随运营变化。
 * 阶段2.2 那套交互与响应式用例检查的是「页面在有一份完整内容时的行为」，
 * 所以把它们钉在显式的示例数据模式上继续跑，真实接口模式由 phase343-real-data.spec.ts 单独覆盖。
 *
 * 这里只做一件事：在应用代码执行之前把数据源开关写进 localStorage，
 * 不拦截请求、不伪造响应，页面本身仍然按同一套代码渲染。
 */
export const DATA_SOURCE_STORAGE_KEY = 'campusgo.data-source.v1'

export const test = base.extend<{ demoDataSource: void }>({
  demoDataSource: [
    async ({ page }, use) => {
      await page.addInitScript(
        ([key]) => window.localStorage.setItem(key, 'demo'),
        [DATA_SOURCE_STORAGE_KEY]
      )
      await use()
    },
    { auto: true }
  ]
})

export { expect }
