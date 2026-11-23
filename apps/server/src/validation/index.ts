/**
 * 请求参数校验体系（阶段3.3.2）的对外入口。
 *
 * 业务代码统一从这里 import，内部拆成两个文件：
 * - fields.ts   单个字段的规则：必填 / 类型 / 长度 / 范围 / 格式 / 枚举
 * - validate.ts 组装成 Express 中间件、未知字段策略、类型推导和 req.validated
 */
export * from './fields.js'
export * from './validate.js'
