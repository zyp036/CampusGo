import { validate } from './validate.js'
import { string } from './fields.js'

/**
 * 阶段4.6：认证接口的参数校验。
 *
 * 注册和登录都只收两个必填字段（nickname/password 或 userCode/password），
 * 其余可选字段走 strip 策略——多传的不报错，直接忽略。
 */

export const parseRegisterBody = validate({
  body: {
    nickname: string({ required: true, minLength: 2, maxLength: 16, label: '昵称' }),
    password: string({ required: true, minLength: 6, maxLength: 128, label: '口令' }),
    school: string({ maxLength: 64, label: '学校' }),
    major: string({ maxLength: 64, label: '专业' }),
    grade: string({ maxLength: 16, label: '年级' }),
    signature: string({ maxLength: 120, label: '签名' })
  },
  unknown: { body: 'strip' }
})

export const parseLoginBody = validate({
  body: {
    userCode: string({ required: true, maxLength: 24, label: '用户码' }),
    password: string({ required: true, maxLength: 128, label: '口令' })
  },
  unknown: { body: 'strip' }
})

export const parseChangePasswordBody = validate({
  body: {
    oldPassword: string({ required: true, maxLength: 128, label: '原口令' }),
    newPassword: string({ required: true, minLength: 6, maxLength: 128, label: '新口令' })
  },
  unknown: { body: 'strip' }
})

export const parseProfileUpdateBody = validate({
  body: {
    nickname: string({ minLength: 2, maxLength: 16, label: '昵称' }),
    signature: string({ maxLength: 120, label: '签名' }),
    school: string({ maxLength: 64, label: '学校' }),
    major: string({ maxLength: 64, label: '专业' }),
    grade: string({ maxLength: 16, label: '年级' })
  },
  unknown: { body: 'strip' }
})
