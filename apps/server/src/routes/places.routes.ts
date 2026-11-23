import { Router } from 'express'
import { getPlace, listPlaces } from '../controllers/places.controller.js'
import { parsePlaceListQuery, parsePlaceParams } from '../validation/places.js'

/**
 * 校园地点（阶段3.4.2）。对外路径：
 * - GET /api/places            列表：分页 + 分类 / 关键词 / 来源筛选
 * - GET /api/places/:id        详情
 * 只读，不写库。
 */
const placesRouter = Router()

placesRouter.get('/', parsePlaceListQuery, listPlaces)
placesRouter.get('/:id', parsePlaceParams, getPlace)

export default placesRouter
