import type { Request, Response } from 'express'
import { sendSuccess } from '../utils/response.js'

/** GET /api/health —— 阶段1 唯一业务接口，用于验证前后端连通 */
export function getHealth(_req: Request, res: Response): void {
  sendSuccess(res, { status: 'ok' }, 'CampusGo API is running!')
}
