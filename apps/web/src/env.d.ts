/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基础地址：相对路径 /api（走 Vite proxy，同源于当前访问地址），或 http://192.168.1.20:3000/api 这样的绝对地址 */
  readonly VITE_API_BASE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
