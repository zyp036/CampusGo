/**
 * WCAG 2.2 AA 对比度实测脚本（阶段2.2 遗留任务二）
 *
 * 用法：先起 dev server（npm run dev:web），再在仓库根目录执行
 *   node apps/web/scripts/contrast-audit.mjs
 * 环境变量：
 *   CAMPUSGO_BASE_URL      默认 http://127.0.0.1:5173
 *   CAMPUSGO_AUDIT_OUT     默认 docs/contrast-audit
 *
 * 测量口径（对应 WCAG 1.4.3 文本 / 1.4.11 非文本 / 2.4.7 与 2.4.11 焦点可见）：
 * - 文字：正文 >= 4.5:1；大号文字（>= 24px，或 >= 18.66px 且字重 >= 700）>= 3:1。
 * - 非文本：控件边框、填充、开关轨道 >= 3:1；取「边框对内填充 / 边框对外部背景 / 填充对外部背景」
 *   里最好的那一个作为边界可辨识度，只有都不到 3:1 才判失败。带可见文字标签的控件填充
 *   单列为 component-fill-labelled（1.4.11 只要求「识别组件所必需」的视觉信息）。
 * - 渐变背景不再取色阶端点极值：按 CSS linear-gradient 的几何关系，在元素包围盒的
 *   中心 + 四角共 5 个采样点求该位置的真实颜色，再取 5 个点里最差的一个（保守）。
 * - 背景按祖先链从远到近逐层合成 alpha，遇到不透明纯色层停止。
 * - 焦点环用真实键盘聚焦 + 真实截图逐像素测量：环带 = 元素外扩 0—3px，
 *   参照背景 = 再往外 4—6px 的中位亮度，取环带里与之差距最大的像素。
 * - 只统计可见元素（rect 非零、checkVisibility 通过），跳过 SVG 内部节点与仅朗读文本。
 * - 禁用/只读按 1.4.3 的 inactive 例外单列为 exempt，不计入整改项，数字照实输出。
 *
 * 输出：
 *   docs/contrast-audit/measurements.json  全部测量原始值
 *   docs/contrast-audit/failures.json      仅不达标项（含 exempt 分组）
 *   stdout                                 逐页计数 + 按根因聚合的清单
 */
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BASE = (process.env.CAMPUSGO_BASE_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '')
const OUT_DIR = path.resolve(process.env.CAMPUSGO_AUDIT_OUT || 'docs/contrast-audit')

const ALL_ROUTES = [
  { path: '/', name: '首页' },
  { path: '/plan', name: 'AI 规划' },
  { path: '/challenge', name: '每日挑战' },
  { path: '/memories', name: '时光记忆' },
  { path: '/partners', name: '校园搭子' },
  { path: '/profile', name: '个人中心' }
]

const ALL_VIEWPORTS = [
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'mobile-390', width: 390, height: 844 },
  /* 与 playwright.config.ts 的其余三个视口对齐，正式审计一轮跑满五种宽度。
     默认仍只取上面两个（desktop-1920 + mobile-390），跟 11-18 的基线口径一致，
     这样「修复前 1063 → 修复后 N」是同一批页面向同一批宽度比出来的数字。 */
  { name: 'mobile-375', width: 375, height: 667 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'laptop-1366', width: 1366, height: 768 }
]

/* 全量一轮 20 来分钟，改一轮令牌就等一轮不现实，所以留两个冒烟开关：
     CGA_ROUTES=home,plan      （home 代表 /；也可写中文路由名，如「首页」）
     CGA_VIEWPORTS=desktop-1920
   正式审计不设这两个变量。注意别在 Git Bash 里传以 / 开头的值，MSYS 会把
   '/plan' 改写成 Windows 路径，所以这里统一按去掉前导斜杠的短名匹配。 */
function routeKey(route) {
  return route.path === '/' ? 'home' : route.path.replace(/^\/+/, '')
}

function pickByEnv(list, raw, keyOf) {
  const wanted = String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!wanted.length) return list
  return list.filter((item) => wanted.includes(keyOf(item)) || wanted.includes(item.name))
}

const ROUTES = pickByEnv(ALL_ROUTES, process.env.CGA_ROUTES, routeKey)
const VIEWPORTS = pickByEnv(ALL_VIEWPORTS, process.env.CGA_VIEWPORTS, (v) => v.name)

const MAX_HOVER_TARGETS = 160
const MAX_FOCUS_TARGETS = 45
// 逐像素校准的抽查条数（每个「视口 × 路由」各取 N 条渐变/半透明背景的失败文字 + 2 条对照组）
const MAX_VERIFY_PER_PAGE = Number(process.env.CGA_VERIFY_PER_PAGE || 8)

const LIB = `
window.__cg = (function () {
  function parseColor(str) {
    if (!str || str === 'none') return null
    if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    var m = String(str).match(/rgba?\\(([^)]*)\\)/)
    if (!m) return null
    if (String(str).indexOf('%') >= 0) return null
    var parts = m[1].trim().split(/[\\s,\\/]+/).filter(function (p) { return p.length })
    var r = parseFloat(parts[0])
    var g = parseFloat(parts[1])
    var b = parseFloat(parts[2])
    var a = parts.length > 3 ? parseFloat(parts[3]) : 1
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null
    if (isNaN(a)) a = 1
    return { r: r, g: g, b: b, a: a > 1 ? a / 255 : a }
  }

  /* computed background-image 的多图层写法：A, B, C（逗号分隔，A 画在最上面）。
     逐个图层解析（linear 与 radial 都支持），repeating-* 与本渐变以外的 image 类型忽略。 */
  function splitLayers(image) {
    var out = []
    var depth = 0
    var cur = ''
    for (var i = 0; i < image.length; i++) {
      var ch = image[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (ch === ',' && depth === 0) {
        out.push(cur)
        cur = ''
      } else cur += ch
    }
    out.push(cur)
    return out
  }

  function gradientBody(layer, kind) {
    var head = kind + '-gradient('
    var m = layer.indexOf(head)
    if (m < 0) return null
    var start = m + head.length
    var depth = 1
    var i = start
    while (i < layer.length && depth > 0) {
      var ch = layer[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    return layer.slice(start, i - 1)
  }

  /* 色标里的颜色与位置必须分开取：整段匹配串带上「 0%」会让 parseColor 直接返回 null
     （它把带 % 的字符串当作无法判定的百分比语法），过去就是这个 bug 让所有带位置参数的
     渐变被当成不存在，白色文字于是落在白色卡片上量出 1:1。 */
  function parseGradientStops(body) {
    var stops = []
    var re = /(rgba?\\([^)]*\\)|hsla?\\([^)]*\\))(?:\\s+(-?[\\d.]+%))?/g
    var mm
    while ((mm = re.exec(body))) {
      var c = parseColor(mm[1])
      if (!c) continue
      stops.push({ c: c, pos: mm[2] ? parseFloat(mm[2]) / 100 : null })
    }
    if (stops.length < 2) return []
    /* 本项目（Tailwind 令牌）不会出现「部分色标省略位置」的写法，缺失时按等分填充即可。 */
    for (var i = 0; i < stops.length; i++) {
      if (stops[i].pos === null) stops[i].pos = i / (stops.length - 1)
    }
    return stops
  }

  function parseGradients(image) {
    if (!image || image === 'none') return []
    var layers = splitLayers(String(image))
    var out = []
    for (var i = 0; i < layers.length; i++) {
      var kind = layers[i].indexOf('linear-gradient(') >= 0
        ? 'linear'
        : layers[i].indexOf('radial-gradient(') >= 0 ? 'radial' : null
      if (!kind) continue
      var body = gradientBody(layers[i], kind)
      if (body === null) continue
      var stops = parseGradientStops(body)
      if (stops.length < 2) continue
      var grad = { kind: kind, stops: stops, angle: 180, cx: 0.5, cy: 0.5 }
      if (kind === 'linear') {
        var am = body.match(/(-?[\\d.]+)deg/)
        var toDir = body.match(/to\\s+(top|right|bottom|left)(?:\\s+(top|right|bottom|left))?/)
        var map = { top: 0, right: 90, bottom: 180, left: 270 }
        if (am) grad.angle = parseFloat(am[1])
        else if (toDir) {
          grad.angle = map[toDir[1]]
          if (toDir[2]) grad.angle = (grad.angle + map[toDir[2]]) / 2
        }
      } else {
        /* 只认百分比圆心；at center、px、以及 closest-side 之类的半径关键字统一退回默认值
           0.5/0.5 + farthest-corner（本项目的 ai-mesh 装饰层就是默认圆心的百分比写法）。 */
        var at = body.match(/at\\s+(-?[\\d.]+)%\\s+(-?[\\d.]+)%/)
        if (at) {
          grad.cx = parseFloat(at[1]) / 100
          grad.cy = parseFloat(at[2]) / 100
        }
      }
      out.push(grad)
    }
    return out
  }

  /* 兼容旧调用点：只取最上面的那个渐变图层 */
  function parseGradient(image) {
    var list = parseGradients(image)
    return list.length ? list[0] : null
  }

  function radialT(grad, box, x, y) {
    var cx = box.left + box.width * grad.cx
    var cy = box.top + box.height * grad.cy
    var corners = [
      [box.left, box.top],
      [box.right, box.top],
      [box.left, box.bottom],
      [box.right, box.bottom]
    ]
    var rMax = 0
    for (var i = 0; i < corners.length; i++) {
      var d = Math.sqrt(Math.pow(corners[i][0] - cx, 2) + Math.pow(corners[i][1] - cy, 2))
      if (d > rMax) rMax = d
    }
    if (rMax <= 0) return 0
    return Math.sqrt(Math.pow(x - cx, 2) + Math.pow(y - cy, 2)) / rMax
  }

  function gradientAt(grad, box, x, y) {
    var t = 0
    if (grad.kind === 'radial') {
      t = radialT(grad, box, x, y)
    } else {
      var rad = (grad.angle * Math.PI) / 180
      var dx = Math.sin(rad)
      var dy = -Math.cos(rad)
      var len = Math.abs(box.width * dx) + Math.abs(box.height * dy)
      if (len <= 0) len = 1
      var cx = box.left + box.width / 2
      var cy = box.top + box.height / 2
      t = ((x - cx) * dx + (y - cy) * dy) / len + 0.5
    }
    if (t < 0) t = 0
    if (t > 1) t = 1
    var stops = grad.stops
    /* CSS 规则：色标区间之外取端点色，不做外推。ai-mesh 的径向渐变终点是 48%—55%，
       一旦把 t 直接代进插值公式就会算出负 alpha，叠加结果反而变亮（此前白色文字
       量到 #aea4ff 这类浅色就是这么来的）。 */
    if (t < stops[0].pos) t = stops[0].pos
    if (t > stops[stops.length - 1].pos) t = stops[stops.length - 1].pos
    var lo = stops[0]
    var hi = stops[stops.length - 1]
    for (var i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].pos && t <= stops[i + 1].pos) { lo = stops[i]; hi = stops[i + 1]; break }
    }
    var span = hi.pos - lo.pos
    var k = span > 0 ? (t - lo.pos) / span : 0
    var c1 = lo.c
    var c2 = hi.c
    return {
      r: c1.r + (c2.r - c1.r) * k,
      g: c1.g + (c2.g - c1.g) * k,
      b: c1.b + (c2.b - c1.b) * k,
      a: c1.a + (c2.a - c1.a) * k
    }
  }

  function channel(v) {
    var c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }

  function luminance(rgb) {
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
  }

  function ratio(a, b) {
    var l1 = luminance(a)
    var l2 = luminance(b)
    var hi = Math.max(l1, l2)
    var lo = Math.min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)
  }

  function over(fg, bg) {
    var a = fg.a === undefined ? 1 : fg.a
    return [fg.r * a + bg[0] * (1 - a), fg.g * a + bg[1] * (1 - a), fg.b * a + bg[2] * (1 - a)]
  }

  function hex(color) {
    var t = function (n) {
      var v = Math.round(Math.max(0, Math.min(255, n))).toString(16)
      return v.length === 1 ? '0' + v : v
    }
    return '#' + t(color[0]) + t(color[1]) + t(color[2])
  }

  function stackOf(el, skipSelf) {
    var stack = []
    var node = skipSelf ? (el ? el.parentElement : null) : el
    while (node) {
      var cs = getComputedStyle(node)
      var rect = node.getBoundingClientRect()
      var c = parseColor(cs.backgroundColor)
      /* 同一元素上 background-image 画在 background-color 之上，多图层里靠前的图层更靠上；
         本数组按「后入栈的先绘制」自底向上铺开，所以按 CSS 顺序铺渐变、最后压 background-color。 */
      var grads = parseGradients(cs.backgroundImage)
      for (var k = 0; k < grads.length; k++) stack.push({ type: 'gradient', grad: grads[k], box: rect })
      if (c && c.a > 0) stack.push({ type: 'color', c: c })
      if (c && c.a >= 1) break
      node = node.parentElement
    }
    stack.push({ type: 'color', c: { r: 255, g: 255, b: 255, a: 1 } })
    return stack
  }

  function samplePoints(rect) {
    return [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + 0.5, rect.top + 0.5],
      [rect.right - 0.5, rect.top + 0.5],
      [rect.left + 0.5, rect.bottom - 0.5],
      [rect.right - 0.5, rect.bottom - 0.5]
    ]
  }

  function bgAtPoint(stack, x, y) {
    var acc = [255, 255, 255]
    var via = 'canvas-white'
    for (var i = stack.length - 1; i >= 0; i--) {
      var item = stack[i]
      if (item.type === 'color') {
        acc = over(item.c, acc)
      } else {
        var c = gradientAt(item.grad, item.box, x, y)
        acc = over(c, acc)
        if (c.a > 0) via = item.grad.kind + '-gradient@' + hex(acc)
      }
    }
    return { rgb: acc, via: via }
  }

  function backgrounds(stack, rect) {
    var pts = samplePoints(rect)
    var out = []
    for (var i = 0; i < pts.length; i++) out.push(bgAtPoint(stack, pts[i][0], pts[i][1]))
    return out
  }

  function textFill(cs) {
    var out = []
    var main = parseColor(cs.color)
    if (main && main.a > 0) out.push(main)
    var webkit = parseColor(cs.getPropertyValue('-webkit-text-fill-color'))
    if (webkit && webkit.a > 0) out = [webkit]
    if (!out.length) {
      var grad = parseGradient(cs.backgroundImage)
      var clip = cs.getPropertyValue('-webkit-background-clip') || cs.backgroundClip || ''
      if (grad && /text/.test(clip)) {
        for (var i = 0; i < grad.stops.length; i++) out.push(grad.stops[i].c)
      }
    }
    return out
  }

  function visible(el) {
    if (!el || el === document.body || el === document.documentElement) return false
    if (el.closest('svg')) return false
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
    var rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    var cs = getComputedStyle(el)
    if (cs.opacity === '0') return false
    return true
  }

  function ownText(el) {
    var t = []
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i]
      if (n.nodeType === 3 && n.textContent.trim()) t.push(n.textContent.trim())
    }
    return t.join(' ')
  }

  function describe(el, text) {
    var cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 5).join('.')
    var tag = el.tagName.toLowerCase()
    var testid = el.getAttribute('data-testid') || ''
    var aria = el.getAttribute('aria-label') || ''
    return tag + (cls ? '.' + cls : '') + (testid ? '[testid=' + testid + ']' : '') +
      (aria ? '[aria=' + aria + ']' : '') + (text ? ' “' + text.slice(0, 18) + '”' : '')
  }

  function statesOf(el) {
    var out = []
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled')
    if (el.readOnly && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) out.push('readonly')
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' ||
        el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'page' ||
        el.classList.contains('cg-chip--active') || el.classList.contains('router-link-exact-active') ||
        el.classList.contains('router-link-active')) out.push('selected')
    return out.length ? out : ['normal']
  }

  function interactive(el) {
    var tag = el.tagName
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true
    var role = el.getAttribute('role')
    return role === 'switch' || role === 'checkbox' || role === 'button' || role === 'tab' || role === 'link'
  }

  /* 「看得见」才算标签：aria-label / aria-labelledby 是读屏软件用的，眼睛看不到，
     不能拿来当 1.4.11 的豁免理由，否则纯图标按钮会被误判成「有文字标签、底色不用管」。 */
  function hasVisibleLabel(el) {
    if (ownText(el)) return true
    if (el.textContent.trim().length > 1) return true
    return false
  }

  function measureText(el) {
    var cs = getComputedStyle(el)
    var text = ownText(el)
    if (!text) return null
    var rect = el.getBoundingClientRect()
    var size = parseFloat(cs.fontSize)
    var weight = parseInt(cs.fontWeight || '400', 10) || 400
    var large = size >= 24 || (size >= 18.66 && weight >= 700)
    var required = large ? 3 : 4.5
    var bases = backgrounds(stackOf(el), rect)
    var fills = textFill(cs)
    if (!fills.length) return null
    var worst = null
    for (var i = 0; i < fills.length; i++) {
      for (var b = 0; b < bases.length; b++) {
        var fg = over(fills[i], bases[b].rgb)
        var r = ratio(fg, bases[b].rgb)
        if (!worst || r < worst.r) worst = { r: r, fg: fg, bg: bases[b].rgb, via: bases[b].via }
      }
    }
    var st = statesOf(el)
    return {
      kind: 'text',
      key: el.getAttribute('data-cg-audit'),
      selector: describe(el, text),
      text: text.slice(0, 36),
      state: st[0],
      fontSize: Math.round(size * 100) / 100,
      fontWeight: weight,
      large: large,
      required: required,
      ratio: Math.round(worst.r * 100) / 100,
      pass: worst.r >= required,
      fg: hex(worst.fg),
      fgRaw: cs.color,
      bg: hex(worst.bg),
      bgVia: worst.via,
      exempt: st[0] === 'disabled' || st[0] === 'readonly'
    }
  }

  /* asIndicator：角色控件（checkbox/switch/radio）真正表示状态的是里面那一小块
     （勾选方块、开关滑轨），外层那一行只是可点的标签容器。外层底色天然等于卡片底色，
     拿它当「状态指示器」去判 3:1 是测错了对象，所以带 data-cg-indicator 的子元素单独测一遍。 */
  function measureComponent(el, asIndicator) {
    var cs = getComputedStyle(el)
    var rect = el.getBoundingClientRect()
    var bases = backgrounds(stackOf(el), rect)
    var outside = backgrounds(stackOf(el, true), rect)
    var out = []
    var labelled = hasVisibleLabel(el)
    var st = statesOf(el)
    var exempt = st[0] === 'disabled' || st[0] === 'readonly'
    var ownKey = el.getAttribute('data-cg-audit')

    var sides = ['Top', 'Right', 'Bottom', 'Left']
    var seen = {}
    for (var i = 0; i < sides.length; i++) {
      var w = parseFloat(cs['border' + sides[i] + 'Width']) || 0
      if (w < 1) continue
      var c = parseColor(cs['border' + sides[i] + 'Color'])
      if (!c || c.a === 0) continue
      var key = hex([c.r, c.g, c.b]) + '#' + w
      if (seen[key]) continue
      seen[key] = true
      var best = null
      for (var b = 0; b < bases.length; b++) {
        var bo = over(c, bases[b].rgb)
        var rIn = ratio(bo, bases[b].rgb)
        var rOut = ratio(bo, outside[b].rgb)
        var pick = Math.max(rIn, rOut)
        if (!best || pick > best.ratio) {
          best = { ratio: pick, rIn: rIn, rOut: rOut, col: bo, bg: outside[b].rgb, via: bases[b].via }
        }
      }
      out.push({
        kind: asIndicator ? 'state-indicator-border' : 'component-border',
        key: asIndicator ? ownKey : ownKey,
        indicatorKey: asIndicator ? ownKey : undefined,
        selector: describe(el, ownText(el)),
        state: st[0],
        part: 'border ' + sides[i].toLowerCase() + ' ' + w + 'px',
        required: 3,
        ratio: Math.round(best.ratio * 100) / 100,
        pass: best.ratio >= 3,
        fg: hex(best.col),
        bg: hex(best.bg),
        bgVia: 'vs inner ' + (Math.round(best.rIn * 100) / 100) + ' / vs outer ' + (Math.round(best.rOut * 100) / 100),
        labelled: labelled,
        exempt: exempt
      })
    }

    var own = parseColor(cs.backgroundColor)
    var role = el.getAttribute('role')
    var isStateIndicator = role === 'switch' || role === 'checkbox' || role === 'radio'
    if (own && own.a > 0 && rect.width > 0) {
      var bestFill = null
      for (var f = 0; f < bases.length; f++) {
        var fill = over(own, outside[f].rgb)
        var rf = ratio(fill, outside[f].rgb)
        if (!bestFill || rf > bestFill.ratio) bestFill = { ratio: rf, col: fill, bg: outside[f].rgb }
      }
      out.push({
        kind: asIndicator
          ? 'state-indicator-child'
          : isStateIndicator
            ? 'state-indicator-fill'
            : labelled
              ? 'component-fill-labelled'
              : 'component-fill',
        key: ownKey,
        selector: describe(el, ownText(el)),
        state: st[0],
        part: 'fill',
        required: 3,
        ratio: Math.round(bestFill.ratio * 100) / 100,
        pass: bestFill.ratio >= 3,
        fg: hex(bestFill.col),
        bg: hex(bestFill.bg),
        bgVia: 'fill vs outside',
        labelled: labelled,
        exempt: exempt
      })
    }

    if (isStateIndicator && !asIndicator) {
      var kids = Array.from(el.querySelectorAll('[data-cg-indicator]'))
      for (var q = 0; q < kids.length; q++) {
        var sub = measureComponent(kids[q], true)
        for (var s2 = 0; s2 < sub.length; s2++) {
          sub[s2].indicatorOf = ownKey
          sub[s2].bgVia = String(sub[s2].bgVia || '') + ' · 角色控件内的指示块'
          out.push(sub[s2])
        }
      }
    }
    return out
  }

  function tagTargets() {
    var n = 0
    var all = Array.from(document.querySelectorAll('body *'))
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (!visible(el)) continue
      if (ownText(el) || interactive(el)) el.setAttribute('data-cg-audit', String(n++))
    }
    return n
  }

  /* 给每条组件记录补上「它自己或它内部的文字标签测得怎么样」，供 Node 侧的 R3 判定使用：
     1.4.11 只要求「识别组件所必需的视觉信息」达到 3:1，组件里有一段达标的可见文字时，
     文字本身就已经把组件认出来了，底色/描边不再单独要求。 */
  function annotateLabelTexts(texts, comps) {
    var elByKey = {}
    var all = Array.from(document.querySelectorAll('[data-cg-audit]'))
    for (var i = 0; i < all.length; i++) elByKey[all[i].getAttribute('data-cg-audit')] = all[i]
    var textByKey = {}
    for (var t = 0; t < texts.length; t++) {
      if (texts[t].key) textByKey[texts[t].key] = texts[t]
    }
    for (var c = 0; c < comps.length; c++) {
      var comp = comps[c]
      var el = comp.key != null ? elByKey[comp.key] : null
      if (!el) continue
      var count = 0
      var worst = null
      var keys = []
      for (var k in textByKey) {
        var tr = textByKey[k]
        var inside = k === comp.key ? true : el.contains(elByKey[k])
        if (!inside) continue
        count++
        keys.push(k)
        if (!worst || tr.ratio / tr.required < worst.ratio / worst.required) worst = tr
      }
      comp.labelTexts = count
      comp.labelKeys = keys
      comp.labelWorst = worst ? worst.ratio : null
      comp.labelAllPass = count > 0 && !!worst && worst.ratio >= worst.required
    }
  }

  function measureAll() {
    tagTargets()
    var texts = []
    var comps = []
    var seen = {}
    var all = Array.from(document.querySelectorAll('[data-cg-audit]'))
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      var t = measureText(el)
      if (t) {
        var k = t.selector + '|' + t.state + '|' + t.fg + '|' + t.bg + '|' + t.fontSize
        if (!seen[k]) { seen[k] = true; texts.push(t) }
      }
      if (interactive(el)) {
        var list = measureComponent(el)
        for (var j = 0; j < list.length; j++) comps.push(list[j])
      }
    }
    annotateLabelTexts(texts, comps)
    return { texts: texts, components: comps, count: all.length }
  }

  function measureOne(key, stateLabel) {
    var el = document.querySelector('[data-cg-audit="' + key + '"]')
    if (!el) return null
    var t = measureText(el)
    if (t) t.state = stateLabel
    return t
  }

  /* 注意：LIB 是普通模板字符串，运行时的反斜杠转义会被吃掉（正则里的 d 类写法失效），
     上一轮焦点环全报 1.00 就是这么来的：扩散半径匹配不到数字，退化成 outline-none 的 2px 透明描边。
     所以这段代码里的字符类一律写 [0-9]、[ ]，不用反斜杠转义。 */
  function toLength(str, axis) {
    var s = String(str || '').trim()
    if (!s) return 0
    if (s.indexOf('%') >= 0) return (parseFloat(s) / 100) * axis
    var px = /^(-?[0-9.]+)px$/.exec(s)
    return px ? Math.max(0, parseFloat(px[1])) : 0
  }

  function radiiOf(cs, w, h) {
    var spec = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
    return spec.map(function (one) {
      var parts = String(one).trim().split(/[ ,/]+/)
      var rx = toLength(parts[0], w)
      var ry = toLength(parts.length > 1 ? parts[1] : parts[0], h)
      return [rx, ry]
    })
  }

  /* 浏览器在两个相邻半径之和超过边长时，把这条边上的半径等比缩小，这里照做，
     否则 rounded-pill 的 9999px 会把整条边都算成圆弧、一个像素都不剩。 */
  function clampRadii(radii, w, h) {
    var f = 1
    function chk(a, b, limit) {
      var sum = a + b
      if (sum > limit && sum > 0) f = Math.min(f, limit / sum)
    }
    chk(radii[0][0], radii[1][0], w)
    chk(radii[2][0], radii[3][0], w)
    chk(radii[0][1], radii[3][1], h)
    chk(radii[1][1], radii[2][1], h)
    return radii.map(function (c) { return [c[0] * f, c[1] * f] })
  }

  /* inset 是把取样区往里缩一圈：圆角边界上的像素是「渐变 + 页面底色」的抗锯齿混合，
     留着它们，p05 会整片落在描边混合带上，读出「白字白底 1.0」的假结论。 */
  function insideRounded(shape, x, y, inset) {
    var pad = inset > 0 ? inset : 0
    var w = shape.w - pad * 2
    var h = shape.h - pad * 2
    if (w <= 0 || h <= 0) return false
    x = x - pad
    y = y - pad
    if (x < 0 || y < 0 || x >= w || y >= h) return false
    var radii = clampRadii(
      shape.radii.map(function (c) { return [Math.max(0, c[0] - pad), Math.max(0, c[1] - pad)] }),
      w,
      h
    )
    if (x < radii[0][0] && y < radii[0][1]) {
      var dx = radii[0][0] - x, dy = radii[0][1] - y
      if (radii[0][0] > 0 && radii[0][1] > 0 && (dx * dx) / (radii[0][0] * radii[0][0]) + (dy * dy) / (radii[0][1] * radii[0][1]) > 1) return false
    }
    if (x >= w - radii[1][0] && y < radii[1][1]) {
      var dx2 = x - (w - radii[1][0]), dy2 = radii[1][1] - y
      if (radii[1][0] > 0 && radii[1][1] > 0 && (dx2 * dx2) / (radii[1][0] * radii[1][0]) + (dy2 * dy2) / (radii[1][1] * radii[1][1]) > 1) return false
    }
    if (x >= w - radii[2][0] && y >= h - radii[2][1]) {
      var dx3 = x - (w - radii[2][0]), dy3 = y - (h - radii[2][1])
      if (radii[2][0] > 0 && radii[2][1] > 0 && (dx3 * dx3) / (radii[2][0] * radii[2][0]) + (dy3 * dy3) / (radii[2][1] * radii[2][1]) > 1) return false
    }
    if (x < radii[3][0] && y >= h - radii[3][1]) {
      var dx4 = radii[3][0] - x, dy4 = y - (h - radii[3][1])
      if (radii[3][0] > 0 && radii[3][1] > 0 && (dx4 * dx4) / (radii[3][0] * radii[3][0]) + (dy4 * dy4) / (radii[3][1] * radii[3][1]) > 1) return false
    }
    return true
  }

  /* 元素自身是圆角/胶囊/圆形时，包围盒的四个角根本不被它的底色覆盖，
     那些角上拿到的是卡片或页面的浅色，逐像素校准会把「渐变白字 5:1」误读成「白底白字 1:1」。
     这里把元素自己的圆角连同祖先的 overflow:hidden 圆角一起还原成裁剪形状，采样时只留真正被覆盖的像素。 */
  function insideShapes(shapes, x, y, inset) {
    for (var i = 0; i < shapes.length; i++) {
      var s = shapes[i]
      var cx = x - s.x
      var cy = y - s.y
      if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) return false
      if (!insideRounded(s, cx, cy, inset)) return false
    }
    return true
  }

  function shapeOf(key) {
    var el = document.querySelector('[data-cg-audit="' + key + '"]')
    if (!el) return null
    var r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    var shapes = [
      {
        x: 0,
        y: 0,
        w: r.width,
        h: r.height,
        radii: radiiOf(getComputedStyle(el), r.width, r.height)
      }
    ]
    var p = el.parentElement
    while (p && p.tagName !== 'HTML') {
      var pcs = getComputedStyle(p)
      if (pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') {
        var pr = p.getBoundingClientRect()
        var rad = radiiOf(pcs, pr.width, pr.height)
        var maxRx = Math.max(rad[0][0], rad[1][0], rad[2][0], rad[3][0])
        if (maxRx > 0) shapes.push({ x: pr.left - r.left, y: pr.top - r.top, w: pr.width, h: pr.height, radii: rad })
      }
      p = p.parentElement
    }
    return { width: Math.round(r.width), height: Math.round(r.height), shapes: shapes }
  }

  function boxOf(key) {
    var el = document.querySelector('[data-cg-audit="' + key + '"]')
    if (!el) return null
    /* 这里必须给「视口坐标」：page.screenshot({clip}) 的 clip 就是视口坐标系
       （实测：滚动 1013px 后，用 rect+scroll 当 clip 直接报「区域在图片之外」）。
       之前加过 scrollX/scrollY，焦点环截图整体往下偏一个滚动量，
       读到的环带是别处的白底，全站焦点环一起变成 1.0～2.6 的假不达标。 */
    var r = el.getBoundingClientRect()
    var cs = getComputedStyle(el)
    /* 焦点环是沿着元素的圆角轮廓画出去的（rounded-full 的圆形按钮根本没有方角），
       所以取样必须知道圆角半径，否则方框四角会取到环之外的背景。 */
    var radii = clampRadii(radiiOf(cs, r.width, r.height), r.width, r.height)
    var corner = 0
    for (var ci = 0; ci < radii.length; ci++) {
      corner = Math.max(corner, Math.min(radii[ci][0], radii[ci][1]))
    }
    corner = Math.min(corner, Math.min(r.width, r.height) / 2)
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      radius: Math.round(corner * 100) / 100,
      label: describe(el, ownText(el))
    }
  }

  function parseAny(str) {
    var c = parseColor(str)
    if (c) return [c.r, c.g, c.b]
    var s = String(str || '').trim()
    var m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s)
    if (!m) return null
    var body = m[1]
    if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
    return [
      parseInt(body.slice(0, 2), 16),
      parseInt(body.slice(2, 4), 16),
      parseInt(body.slice(4, 6), 16)
    ]
  }

  /* 逐像素校准用的取样：截图里每个像素都算一次与前景的比值，取第 5 百分位当作结论值，
     同时给出最差值与中位值。模型算错时（多层径向渐变最容易）以像素为准，报告里可以
     指名道姓地说「这个数字是浏览器实际渲染的像素，不是推测」。 */
  function sampleFromPixels(fgStr, data, w, h, shapes, inset) {
    var pad = inset === undefined || inset === null ? 1 : inset
    var hist = {}
    var list = []
    var skipped = 0
    function collect(p, useShapes) {
      list = []
      hist = {}
      skipped = 0
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var i = (y * w + x) * 4
          if (data[i + 3] < 200) continue
          if (useShapes && !insideShapes(shapes, x, y, p)) { skipped++; continue }
          var q = [data[i], data[i + 1], data[i + 2]]
          var hk = q[0] + ',' + q[1] + ',' + q[2]
          hist[hk] = (hist[hk] || 0) + 1
          list.push(q)
        }
      }
    }
    var hasShapes = !!(shapes && shapes.length)
    var mode = 'unmasked'
    /* 先往里缩 1px（默认）避开圆角抗锯齿混合带；缩完样本太少就退回不缩，
       再少就整个放弃裁剪，并把实际用了哪一种口径报进结果，报告里能追溯。 */
    if (hasShapes && pad > 0) { collect(pad, true); mode = 'inset-' + pad }
    if (hasShapes && list.length < 16) { collect(0, true); mode = 'shape-only' }
    if (!hasShapes || list.length < 16) { collect(0, false); mode = 'unmasked' }
    if (list.length < 16) return null
    var topKey = null
    var topN = -1
    for (var kk in hist) {
      if (hist[kk] > topN) { topN = hist[kk]; topKey = kk }
    }
    var parts = topKey.split(',')
    var bg = [Number(parts[0]), Number(parts[1]), Number(parts[2])]
    /* 前景可能是半透明（text-white/70 这类），要按各自背景合成后再算比值，
       否则会把 0.7 alpha 的白字当成纯白，结论偏乐观。 */
    var f = parseColor(fgStr)
    var fg0 = f ? [f.r, f.g, f.b] : parseAny(fgStr)
    if (!fg0) return null
    function ratioAgainst(pixel) {
      var fg = fg0
      if (f && f.a < 1) {
        fg = [f.r * f.a + pixel[0] * (1 - f.a), f.g * f.a + pixel[1] * (1 - f.a), f.b * f.a + pixel[2] * (1 - f.a)]
      }
      var l1 = Math.max(luminance(fg), luminance(pixel))
      var l2 = Math.min(luminance(fg), luminance(pixel))
      return (l1 + 0.05) / (l2 + 0.05)
    }
    /* 渐变底色的逐像素比值都不一样，取第 5 百分位当作「最差但确实是真实像素」的数字：
       既不会因为单个杂散像素过度悲观，也不会像纯色那样只挑一个众数。 */
    var pairs = list
      .map(function (p) { return { p: p, r: ratioAgainst(p) } })
      .sort(function (a, b) { return a.r - b.r })
    var p05 = pairs[Math.floor(pairs.length * 0.05)]
    var mid = pairs[Math.floor(pairs.length / 2)]
    var rnd = function (n) { return Math.round(n * 100) / 100 }
    return {
      mode: hex(bg),
      ratio: rnd(p05.r),
      ratioColor: hex(p05.p),
      medianRatio: rnd(mid.r),
      worstRatio: rnd(pairs[0].r),
      worstColor: hex(pairs[0].p),
      modeShare: Math.round((topN / list.length) * 100) / 100,
      pixels: list.length,
      clippedOut: skipped,
      clipMode: mode,
      shapeClipped: mode !== 'unmasked'
    }
  }

  function ringFromPixels(data, w, h, padX, padY, sx, extent, boxW, boxH, boxR) {
    /* 焦点环的位置不是「贴着盒子」：全站用的是 ring-2 + ring-offset-2，
       所以 0—2px 是 offset 的留白色，真正的环画在 2—4px，参照区要在环外面。
       extent 取自元素聚焦时 computed box-shadow 的最大扩散半径（Tailwind 会算成 4px）。
       距离先按实际缩放比例换算回 CSS 像素再比。
       「离边界多远」用圆角矩形的带符号距离，不用方框的切比雪夫距离：
       box-shadow 是顺着元素的圆角轮廓画出去的，rounded-full 的圆形按钮（收藏心形）
       方框四角离边 3—4px 的地方根本没有环，只有背后的照片，
       上一版把照片的浅蓝读成参照色，真实的 3.4:1 留白被算成 2.26:1。
       取样口径（第三次修，前两版都会读偏）：
       1. 环带只取最外两行（e-1 到 e）。抗锯齿让 2—3px 这一行混进半个留白像素，
          上一版按「取最大对比度的那个像素」挑色，于是白色的锯齿角赢了，蓝色环反而落选。
       2. 环色和参照色都用「出现次数最多的精确 RGB」，众数比中位数稳。
       3. 参照区先排除与环同色（含过渡色）的像素：侧边栏这类紧挨着的列表项，
          外侧 5—7px 有一半是上/下一个元素自己的焦点环，不排除参照会被读成中灰，
          真实差距 6.95:1 的环会被算成 2.57:1。排除后不足 4 个像素则回到未排除的众数。
       4. 色环和 offset 留白是同一套指示器，各自与参照比，取更好的那条。 */
    var e = extent > 0 ? extent : 3
    var bandLo = Math.max(1, e - 1)
    var bandHi = e
    var ring = []
    var halo = []
    var adj = []
    var inner = []
    if (!(boxW > 0) || !(boxH > 0)) return null
    var cx = padX + boxW / 2
    var cy = padY + boxH / 2
    var rr = boxR > 0 ? Math.min(boxR, Math.min(boxW, boxH) / 2) : 0
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4
        if (data[i + 3] < 200) continue
        var qx = Math.abs(x + 0.5 - cx) - boxW / 2 + rr
        var qy = Math.abs(y + 0.5 - cy) - boxH / 2 + rr
        var ox = Math.max(qx, 0)
        var oy = Math.max(qy, 0)
        var d = (Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rr) / (sx > 0 ? sx : 1)
        var p = [data[i], data[i + 1], data[i + 2]]
        if (d < 0) {
          if (((x + y) & 3) === 0) inner.push(p)
          continue
        }
        if (d < bandLo) halo.push(p)
        else if (d <= bandHi) ring.push(p)
        else if (d <= bandHi + 3) adj.push(p)
      }
    }
    function lum(p) { return luminance([p[0], p[1], p[2]]) }
    function dist(a, b) {
      var dr = a[0] - b[0]
      var dg = a[1] - b[1]
      var db = a[2] - b[2]
      return Math.sqrt(dr * dr + dg * dg + db * db)
    }
    function ratioOf(a, b) {
      var hi = Math.max(a, b)
      var lo = Math.min(a, b)
      return (hi + 0.05) / (lo + 0.05)
    }
    function mode(list, skip) {
      var map = {}
      var kept = 0
      for (var k = 0; k < list.length; k++) {
        if (skip && skip(list[k])) continue
        kept++
        var key = list[k][0] + ',' + list[k][1] + ',' + list[k][2]
        map[key] = (map[key] || 0) + 1
      }
      var bk = null
      var bn = 0
      for (var q in map) {
        if (map[q] > bn) { bk = q; bn = map[q] }
      }
      if (!bk || bn < 4) return null
      var a = bk.split(',')
      return { rgb: [Number(a[0]), Number(a[1]), Number(a[2])], n: bn, kept: kept, total: list.length }
    }
    var ringTop = mode(ring)
    var haloTop = mode(halo)
    var innerTop = mode(inner)
    if (!ringTop || adj.length < 8) return null
    var ringRgb = ringTop.rgb
    var adjTop = mode(adj, function (p) { return dist(p, ringRgb) < 60 }) || mode(adj)
    if (!adjTop) return null
    var fromRing = { band: '环带 ' + bandLo + '—' + bandHi + 'px', rgb: ringRgb, top: ringTop, ratio: ratioOf(lum(ringRgb), lum(adjTop.rgb)) }
    var fromHalo = haloTop ? { band: '留白带 0—' + bandLo + 'px', rgb: haloTop.rgb, top: haloTop, ratio: ratioOf(lum(haloTop.rgb), lum(adjTop.rgb)) } : null
    var sameAsSelf = innerTop && dist(ringRgb, innerTop.rgb) < 24
    var sameAsRef = dist(ringRgb, adjTop.rgb) < 60
    /* 焦点指示器是「色环 + offset 留白」一整套，SC 2.4.11/2.4.7 看的是这套东西能不能被看见：
       两条带各自和外层参照众色比，取更好的那条。色环画在同色表面上（品牌底、蓝色照片）时，
       起作用的是那一圈浅色留白，这不是放水，量的是同一套指示器里真正可见的部分。 */
    var pick = fromRing
    if (fromHalo && fromHalo.ratio > fromRing.ratio) pick = fromHalo
    if (!pick.top) return null
    return {
      ratio: Math.round(pick.ratio * 100) / 100,
      ring: hex(pick.rgb),
      bg: hex(adjTop.rgb),
      ringPixels: pick.top.total,
      ringMode: pick.top.n,
      adjMode: adjTop.n,
      adjKept: adjTop.kept,
      band: pick.band,
      adjBand: (bandHi + 1) + '—' + (bandHi + 3) + 'px',
      ringRatio: Math.round(fromRing.ratio * 100) / 100,
      haloRatio: fromHalo ? Math.round(fromHalo.ratio * 100) / 100 : null,
      ringLikeSelf: !!sameAsSelf,
      ringLikeRef: !!sameAsRef
    }
  }

  return {
    measureAll: measureAll,
    measureOne: measureOne,
    boxOf: boxOf,
    ringFromPixels: ringFromPixels,
    sampleFromPixels: sampleFromPixels,
    interactiveKeys: function () {
      var out = []
      var all = Array.from(document.querySelectorAll('[data-cg-audit]'))
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (el.tagName === 'LABEL') continue
        if (interactive(el)) out.push(el.getAttribute('data-cg-audit'))
      }
      return out
    },
    selOf: function (key) {
      var el = document.querySelector('[data-cg-audit="' + key + '"]')
      return el ? describe(el, ownText(el)) : null
    },
    /* 聚焦时真实生效的 box-shadow 扩散半径，决定「环画在第几像素」；outline 也算进来。 */
    focusExtentOf: function (key) {
      var el = document.querySelector('[data-cg-audit="' + key + '"]')
      if (!el) return 0
      var cs = getComputedStyle(el)
      var best = 0
      /* 按逗号切分层，但 rgb()/rgba() 内部也有逗号：正则里写转义括号在这段模板字符串里
         很容易被二次转义吃掉（上一轮就是把环带算到 offset 上），所以改成按括号深度扫描。 */
      var raw = String(cs.boxShadow || '')
      var layers = []
      var depth = 0
      var cur = ''
      for (var c = 0; c < raw.length; c++) {
        var ch = raw.charAt(c)
        if (ch === '(') depth++
        else if (ch === ')') depth--
        if (ch === ',' && depth <= 0) { layers.push(cur); cur = '' }
        else cur += ch
      }
      if (cur) layers.push(cur)
      for (var i = 0; i < layers.length; i++) {
        var nums = layers[i].match(/-?[0-9.]+px/g)
        if (!nums) continue
        var spread = parseFloat(nums[nums.length - 1])
        if (spread > best) best = spread
      }
      /* Tailwind 的 outline-none 是「2px 实心透明」，outlineStyle 并不是 none：
         只看 style/width 会把透明描边当成 2px 的环，正好盖住真正的偏移层。必须验颜色透明度。 */
      var ow = parseFloat(cs.outlineWidth) || 0
      var oc = cs.outlineColor ? parseColor(cs.outlineColor) : null
      if (cs.outlineStyle !== 'none' && ow > 0 && oc && oc.a > 0) best = Math.max(best, ow)
      return best
    },
    shapeOf: shapeOf
  }
})()
`

const PIXEL_FN = `async function (b64, meta) {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height)
  /* 截图可能按 deviceScaleFactor 放大（本审计上下文是 1 倍，但仍按实际比例换算），
     先把盒子偏移换成像素偏移，ringFromPixels 再把逐像素距离换算回 CSS 像素，环带才对得上真实位置。 */
  const sx = meta.cssW > 0 ? c.width / meta.cssW : 1
  const sy = meta.cssH > 0 ? c.height / meta.cssH : 1
  return window.__cg.ringFromPixels(
    new Uint8ClampedArray(d.data),
    c.width,
    c.height,
    meta.offX * sx,
    meta.offY * sy,
    sx,
    meta.extent,
    (meta.boxW || 0) * sx,
    (meta.boxH || 0) * sy,
    (meta.boxR || 0) * sx
  )
}`

const PIXEL_MODE_FN = `async function (b64, fgStr, info) {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height)
  /* 截图可能是按 deviceScaleFactor 放大过的（这里 context 是 2），裁剪形状要换算到像素坐标。 */
  const sx = info && info.width ? c.width / info.width : 1
  const sy = info && info.height ? c.height / info.height : 1
  const shapes = info && info.shapes && sx > 0 && sy > 0
    ? info.shapes.map((s) => ({
        x: s.x * sx,
        y: s.y * sy,
        w: s.w * sx,
        h: s.h * sy,
        radii: s.radii.map((r) => [r[0] * sx, r[1] * sy])
      }))
    : null
  return window.__cg.sampleFromPixels(fgStr, new Uint8ClampedArray(d.data), c.width, c.height, shapes, sx)
}`

/* 只抹掉前景，不能整个元素藏起来：visibility:hidden 连元素自己的 background 一起不画，
   截到的是父容器的颜色，会把「元素自身有底色」的结论洗成白色。
   这里是把元素及其后代的文字颜色全透明化（嵌套 span 自带 text-xxx 也要抹干净），
   图标/图片一并隐藏，但任何元素的 background 都照常绘制 —— 内层底色本来就是「文字背后」的一部分。 */
const HIDE_FN = `(function (k, off) {
  var el = document.querySelector('[data-cg-audit="' + k + '"]')
  if (!el) return false
  if (off) {
    el.setAttribute('data-cg-fg-off', '1')
  } else {
    el.removeAttribute('data-cg-fg-off')
  }
  return true
})`

/* 抹前景、留背景：文字（含嵌套 span 自带的 color）、伪元素内容、图标都透明化，
   但任何元素自身的 background 都照常绘制 —— 内层底色本来就是「文字背后」的一部分。
   曾经用 visibility:hidden 隐藏子节点，结果连子节点自己的胶囊底色一起抹掉了。 */
const FG_OFF_CSS = `
[data-cg-fg-off], [data-cg-fg-off] * {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  fill: transparent !important;
  stroke: transparent !important;
}
[data-cg-fg-off]::before, [data-cg-fg-off]::after,
[data-cg-fg-off] *::before, [data-cg-fg-off] *::after {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
}
[data-cg-fg-off] svg, [data-cg-fg-off] img, [data-cg-fg-off] canvas { opacity: 0 !important; }
`

/**
 * 逐像素校准：抹掉文字本身后，截该元素自己的盒子，对每个像素算一次与前景色的比值，
 * 取第 5 百分位作为「文字背后真正渲染出来的颜色」对应的比值。
 * 必须用 locator.screenshot —— page.screenshot({clip}) 的坐标是视口坐标系，
 * 元素滚动到屏幕外时截到的是空白页面，此前 #4569e8 渐变按钮「实测全白」就是这么来的。
 * 模型和渲染器不一致时以像素为准，报告里的数字因此可以追溯到浏览器输出。
 */
async function verifyTextPixels(page, rec) {
  if (!rec.key) return null
  const box = await page.evaluate(`window.__cg.boxOf(${JSON.stringify(rec.key)})`)
  if (!box || box.width < 8 || box.height < 6) return null
  /* data-cg-audit 的键是按 DOM 顺序临时编号的，页面在测量之后又重渲染过一次
     （后端状态胶囊的耗时文字会刷新），键就可能落到别的元素上。截图前先核对身份，
     对不上就放弃这条校准，宁可少一条数据也不拿别人的像素去推翻模型。 */
  const live = await page.evaluate(`window.__cg.selOf(${JSON.stringify(rec.key)})`)
  if (!live || live !== rec.selector) return null
  const loc = page.locator(`[data-cg-audit="${rec.key}"]`).first()
  let shot = null
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 })
    await page.evaluate(`${HIDE_FN}(${JSON.stringify(rec.key)}, true)`)
    shot = await loc.screenshot({ timeout: 5000, animations: 'disabled', caret: 'hide' })
  } catch {
    return null
  } finally {
    await page.evaluate(`${HIDE_FN}(${JSON.stringify(rec.key)}, false)`).catch(() => {})
  }
  /* 形状必须从「Playwright 实际截图的那个元素」上读，而不是再 querySelector 一次键：
     上一轮 shapeOf(key) 在同一时刻给出的半径是 0，而 getComputedStyle 给的是 12px，
     两次取到的不是同一个节点时，裁剪就形同虚设，白底白字的假 1.00 会盖掉模型的 4.74。 */
  const shapeInfo = await loc.evaluate((el) => {
    var r = el.getBoundingClientRect()
    var cs = getComputedStyle(el)
    function len(s, axis) {
      var t = String(s || '').trim()
      if (!t) return 0
      if (t.indexOf('%') >= 0) return (parseFloat(t) / 100) * axis
      var m = /^(-?[\d.]+)px$/.exec(t)
      return m ? Math.max(0, parseFloat(m[1])) : 0
    }
    function radii(c, w, h) {
      return [
        [len(c.borderTopLeftRadius, w), len(c.borderTopLeftRadius, h)],
        [len(c.borderTopRightRadius, w), len(c.borderTopRightRadius, h)],
        [len(c.borderBottomRightRadius, w), len(c.borderBottomRightRadius, h)],
        [len(c.borderBottomLeftRadius, w), len(c.borderBottomLeftRadius, h)]
      ]
    }
    var shapes = [{ x: 0, y: 0, w: r.width, h: r.height, radii: radii(cs, r.width, r.height) }]
    var p = el.parentElement
    while (p && p.tagName !== 'HTML') {
      var pcs = getComputedStyle(p)
      if (pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') {
        var pr = p.getBoundingClientRect()
        var rr = radii(pcs, pr.width, pr.height)
        if (Math.max(rr[0][0], rr[1][0], rr[2][0], rr[3][0]) > 0) {
          shapes.push({ x: pr.left - r.left, y: pr.top - r.top, w: pr.width, h: pr.height, radii: rr })
        }
      }
      p = p.parentElement
    }
    return {
      width: Math.round(r.width),
      height: Math.round(r.height),
      shapes: shapes,
      rawRadius: cs.borderTopLeftRadius,
      cls: String(el.className).slice(0, 70)
    }
  })
  /* 校准前把这个键当前真的落在哪个元素上抄一份（类名/圆角/位置/文字）。
     describe() 出来的 selector 是截断的，同类元素多的时候「键还在、但已经不是这个元素」
     是可能发生的，像素复核要是拿错元素的底图去推翻模型，报告里的数字就全部不可信。 */
  const geom = await page.evaluate(`(() => {
    var el = document.querySelector('[data-cg-audit="' + ${JSON.stringify(rec.key)} + '"]')
    if (!el) return null
    var cs = getComputedStyle(el)
    var r = el.getBoundingClientRect()
    return {
      cls: String(el.className).slice(0, 120),
      radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      text: String(el.textContent || '').slice(0, 24),
      ownAuditCount: document.querySelectorAll('[data-cg-audit]').length
    }
  })()`)
  const res = await page.evaluate(
    `(${PIXEL_MODE_FN})(${JSON.stringify(shot.toString('base64'))}, ${JSON.stringify(rec.fgRaw || rec.fg)}, ${JSON.stringify(shapeInfo)})`
  )
  if (res) {
    res.shapeInfo = shapeInfo
    res.geom = geom
  }
  return res || null
}

/**
 * WCAG 判定规则（写进 docs/contrast-report.md，逐条可复核）：
 * R5  禁用/只读控件按 SC 1.4.3 的 inactive 例外豁免（浏览器已有，这里只是继续标出来）。
 * R3  组件的底色/描边与相邻背景不足 3:1，但这个组件自己或它内部有一段可见文字，且那段文字实测达标
 *     → 按 SC 1.4.11「识别组件所必需的视觉信息」豁免：认出这个控件靠的是文字，不是它的外框。
 *     aria-label 不算（读屏能读、眼睛看不到），所以 hasVisibleLabel 只认可见文字。
 * R3b 组件没有可见文字标签，但它自己的描边已达 3:1（例如搜索框）→ 底色不再单独要求；
 *     勾选方块/开关滑块这类指示块同理，识别选中/未选中靠描边和形状，内部是白的不影响。
 * R3c 带 role=checkbox/switch/radio 的行：行本身的底色等于卡片底色，但行内的指示块
 *     （勾选方块、开关滑轨）已按 data-cg-indicator 单独测过并且达标 → 行的底色豁免。
 * 文字（kind=text）与键盘焦点环（kind=focus-ring）不吃上面任何一条，只能真改。
 * 焦点环按 SC 2.4.13 的口径：色环和 ring-offset 留白带各与环外侧参照区比，取更好的一条
 * （深色照片上起作用的是那圈浅色留白）；元素滚不到视口中间或被吸顶栏挡住时跳过该样本，
 * 计入「焦点跳过」，不冒充不达标。
 */
function applyWcagRules(records) {
  const childIndicators = records.filter((r) => r.kind === 'state-indicator-child' || r.kind === 'state-indicator-border')
  const borderPassByKey = new Map()
  for (const r of records) {
    if (r.kind !== 'component-border' || !r.key) continue
    borderPassByKey.set(r.key, (borderPassByKey.get(r.key) || false) || r.pass)
  }
  /* 勾选方块/开关滑块这类指示块自己也有「描边 vs 内部底色」两条记录：
     识别选中/未选中靠的是描边和形状（打勾、滑块位置），内部是白的并不影响识别。 */
  const indicatorBorderPassBySel = new Map()
  for (const r of records) {
    if (r.kind !== 'state-indicator-border' || !r.selector) continue
    indicatorBorderPassBySel.set(r.selector, (indicatorBorderPassBySel.get(r.selector) || false) || r.pass)
  }
  /* 标签到底达不达标，以逐像素校准之后的数字为准（校准会就地改写 records 里的 ratio/pass），
     不能沿用页面里那份模型值，否则渐变文字「模型过、像素不过」时会被误豁免。 */
  const textByKey = new Map()
  for (const r of records) {
    if (r.kind !== 'text' || !r.key) continue
    const prev = textByKey.get(r.key)
    if (!prev || r.ratio < prev.ratio) textByKey.set(r.key, r)
  }
  function labelStatus(comp) {
    const keys = comp.labelKeys || []
    if (!keys.length) return { count: 0, pass: false, worst: null }
    let pass = true
    let worst = null
    for (const k of keys) {
      const t = textByKey.get(k)
      if (!t) continue
      if (!worst || t.ratio / t.required < worst.ratio / worst.required) worst = t
      if (!t.pass) pass = false
    }
    return { count: keys.length, pass, worst: worst ? worst.ratio : null }
  }
  const summary = {}
  for (const r of records) {
    if (r.pass) continue
    if (r.exempt) {
      r.rule = 'R5 禁用/只读（SC 1.4.3 inactive 例外）'
      summary[r.rule] = (summary[r.rule] || 0) + 1
      continue
    }
    if (r.kind === 'state-indicator-fill') {
      const kids = childIndicators.filter((k) => k.indicatorOf === r.key)
      const kidPass = kids.some((k) => k.pass)
      const label = labelStatus(r)
      if (kidPass && (label.count === 0 || label.pass)) {
        r.exempt = true
        r.rule = 'R3c 状态由行内指示块标识（SC 1.4.11）'
      }
    } else if (r.kind === 'state-indicator-child') {
      if (r.selector && indicatorBorderPassBySel.get(r.selector)) {
        r.exempt = true
        r.rule = 'R3b 指示块描边已≥3:1，内部底色不再单独要求（SC 1.4.11）'
      }
    } else if (r.kind === 'component-border' || r.kind === 'component-fill-labelled') {
      const label = labelStatus(r)
      if (r.labelled && label.count > 0 && label.pass) {
        r.exempt = true
        r.rule = 'R3 组件由可见文字标签识别（SC 1.4.11）'
        r.labelWorst = label.worst
      }
    } else if (r.kind === 'component-fill') {
      if (r.key && borderPassByKey.get(r.key)) {
        r.exempt = true
        r.rule = 'R3b 组件描边已≥3:1，底色不再单独要求（SC 1.4.11）'
      }
    }
    if (r.rule) summary[r.rule] = (summary[r.rule] || 0) + 1
  }
  return summary
}

async function focusRing(page, key, label, stats) {
  /* clip 用的是文档坐标，元素没滚进视口时截到的是空白页，此前「焦点环全是 1.00」就是这么来的：
     先滚进视口、再重新读一次盒子，环带和参照区才真的是这个元素周围的颜色。
     scrollIntoViewIfNeeded 会把元素停在视口上/下边缘，那里正好是吸顶栏/弹层盖住的位置，
     截到的是别人家的白底，所以改成滚到视口中间，并用 elementFromPoint 验一次没被遮挡，
     确实取不到干净样本时跳过这一条（记进 stats，不冒充「不达标」）。 */
  const scrolled = await page
    .evaluate(
      `(() => {
         var el = document.querySelector('[data-cg-audit="' + ${JSON.stringify(String(key))} + '"]')
         if (!el) return false
         el.scrollIntoView({ block: 'center', inline: 'center' })
         return true
       })()`
    )
    .catch(() => false)
  if (!scrolled) return null
  const box = await page.evaluate(`window.__cg.boxOf(${JSON.stringify(key)})`)
  if (!box || box.width < 6 || box.height < 6) return null
  const vis = await page
    .evaluate(`(() => {
       var el = document.querySelector('[data-cg-audit="' + ${JSON.stringify(String(key))} + '"]')
       if (!el) return null
       var r = el.getBoundingClientRect()
       if (r.top < 6 || r.bottom > innerHeight - 6 || r.left < 6 || r.right > innerWidth - 6) return { clear: false }
       var pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2]]
       var ok = 0
       for (var i = 0; i < pts.length; i++) {
         var p = document.elementFromPoint(pts[i][0], pts[i][1])
         if (p && (p === el || el.contains(p) || p.contains(el))) ok++
       }
       return { clear: ok >= 2, hits: ok }
     })()`)
    .catch(() => null)
  if (!vis || !vis.clear) {
    if (stats) stats.skipped++
    return null
  }
  const pad = 10
  const clipX = Math.max(0, Math.floor(box.left - pad))
  const clipY = Math.max(0, Math.floor(box.top - pad))
  const clipW = Math.min(600, Math.ceil(box.width + pad * 2))
  const clipH = Math.min(600, Math.ceil(box.height + pad * 2))
  const extent = await page.evaluate(`window.__cg.focusExtentOf(${JSON.stringify(key)})`)
  const shadowRaw = await page
    .evaluate(
      `document.querySelector('[data-cg-audit="' + ${JSON.stringify(String(key))} + '"]') && getComputedStyle(document.querySelector('[data-cg-audit="' + ${JSON.stringify(String(key))} + '"]')).boxShadow`
    )
    .catch(() => '')
  let shot
  /* 带 transition-all 的组件（.cg-btn / .cg-chip）聚焦时色环是「长」出来的：
     computed box-shadow 立刻是终值 4px，截图却落在 200ms 过渡中间，环还没画到第 3—4 像素，
     读出来就是 1.00。截图前先结束这个元素身上还在跑的过渡/动画，拿到的才是静止终态。 */
  const settled = await page
    .evaluate(
      `(() => { var el = document.querySelector('[data-cg-audit="' + ${JSON.stringify(String(key))} + '"]'); if (!el || !el.getAnimations) return 0; var n = 0; var list = el.getAnimations(); for (var i = 0; i < list.length; i++) { try { list[i].finish(); n++ } catch (e) {} } return n })()`
    )
    .catch(() => 0)
  await page
    .evaluate('new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r) }) })')
    .catch(() => {})
  try {
    shot = await page.screenshot({ clip: { x: clipX, y: clipY, width: clipW, height: clipH } })
  } catch {
    return null
  }
  if (process.env.CGA_DUMP) {
    const dir = process.env.CGA_DUMP
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `ring-${key}-${Math.round(box.left)},${Math.round(box.top)}.png`), shot).catch(() => {})
  }
  const b64 = shot.toString('base64')
  const res = await page.evaluate(
    `(${PIXEL_FN})(${JSON.stringify(b64)}, ${JSON.stringify({
      cssW: clipW,
      cssH: clipH,
      offX: box.left - clipX,
      offY: box.top - clipY,
      boxW: box.width,
      boxH: box.height,
      boxR: box.radius || 0,
      extent: Math.round(extent * 100) / 100
    })})`
  )
  if (!res) return null
  return {
    kind: 'focus-ring',
    key: String(key),
    selector: label || box.label,
    state: 'focus',
    part: 'keyboard focus indicator（逐像素）',
    required: 3,
    ratio: res.ratio,
    pass: res.ratio >= 3,
    fg: res.ring,
    bg: res.bg,
    bgVia: `${res.band} 众色 ${res.ring}（${res.ringMode}/${res.ringPixels} 个像素，真实扩散 ${extent}px，截图前结束过渡 ${settled} 个）、参照 ${res.adjBand} 众色 ${res.bg}（排除同环色后 ${res.adjKept} 个，众数 ${res.adjMode}） · 环 ${res.ringRatio} / 留白 ${res.haloRatio}${res.ringLikeSelf ? ' · 环色≈元素底色' : ''}${res.ringLikeRef ? ' · 环色≈外侧参照（画在同色表面上）' : ''} · boxShadow ${String(shadowRaw).slice(0, 96)}`,
    labelled: true,
    exempt: false
  }
}

async function main() {
  if (!ROUTES.length || !VIEWPORTS.length) {
    throw new Error(
      `CGA_ROUTES/CGA_VIEWPORTS 过滤后没有任何目标（当前 ${JSON.stringify([
        process.env.CGA_ROUTES,
        process.env.CGA_VIEWPORTS
      ])}），拒绝跑空一轮。`
    )
  }
  console.log(`本轮范围：${VIEWPORTS.map((v) => v.name).join(' + ')} · ${ROUTES.map((r) => r.path).join(' ')} · 输出 ${OUT_DIR}`)
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const results = []
  const verified = []
  const ruleTotals = {}

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    for (const route of ROUTES) {
      const page = await context.newPage()
      await page.goto(BASE + route.path, { waitUntil: 'load' })
      await page.evaluate(LIB)
      await page.evaluate(
        `(function (css) {
           var s = document.createElement('style')
           s.id = 'cg-audit-fg-off'
           s.textContent = css
           document.head.appendChild(s)
         })(${JSON.stringify(FG_OFF_CSS)})`
      )
      await page.getByRole('heading', { level: 1 }).first().waitFor({ state: 'visible', timeout: 20000 })
      const skip = page.getByRole('button', { name: '直接开始规划' })
      if ((await skip.count().catch(() => 0)) > 0) {
        await skip.first().click().catch(() => {})
        await page.waitForTimeout(250)
      }
      await page.waitForTimeout(350)

      const data = await page.evaluate('window.__cg.measureAll()')

      // 悬停态：真实 hover 之后重算该元素的文字对比度
      const hovered = []
      const keys = await page.evaluate('window.__cg.interactiveKeys()')
      let budget = MAX_HOVER_TARGETS
      for (const key of keys) {
        if (budget <= 0) break
        const el = page.locator(`[data-cg-audit="${key}"]`)
        budget -= 1
        try {
          await el.hover({ timeout: 700 })
        } catch {
          continue
        }
        const rec = await page.evaluate(`window.__cg.measureOne(${JSON.stringify(key)}, "hover")`).catch(() => null)
        if (rec) hovered.push(rec)
        await page.mouse.move(1, 1)
      }

      // 焦点态：真实键盘聚焦 + 真实截图逐像素
      const focus = []
      const focusKeys = []
      const seenFocus = new Set()
      const ringStats = { skipped: 0 }
      await page.evaluate('window.scrollTo(0, 0)')
      for (let i = 0; i < MAX_FOCUS_TARGETS; i++) {
        await page.keyboard.press('Tab').catch(() => {})
        const key = await page.evaluate(
          'document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-cg-audit")'
        )
        if (!key || seenFocus.has(key)) continue
        seenFocus.add(key)
        focusKeys.push(key)
        const text = await page.evaluate(`window.__cg.measureOne(${JSON.stringify(key)}, "focus")`).catch(() => null)
        if (text) focus.push(text)
        const ring = await focusRing(page, key, undefined, ringStats).catch(() => null)
        if (ring) focus.push(ring)
      }

      const records = [...data.texts, ...data.components, ...hovered, ...focus].map((r) => ({
        ...r,
        viewport: vp.name,
        route: route.name,
        url: route.path
      }))

      // 像素校准：只抽查「背景涉及渐变/半透明」的记录，模型与渲染不符时以像素为准
      const candidates = records.filter(
        (r) => r.kind === 'text' && r.key && /gradient|\/\d|canvas-white/.test(String(r.bgVia || ''))
      )
      const risky = candidates.filter((r) => !r.pass).sort((a, b) => a.ratio - b.ratio).slice(0, MAX_VERIFY_PER_PAGE)
      const controls = candidates.filter((r) => r.pass).slice(0, 2)
      const pixelChecks = []
      for (const rec of [...risky, ...controls]) {
        const v = await verifyTextPixels(page, rec).catch(() => null)
        if (!v) continue
        const delta = Math.round(Math.abs(v.ratio - rec.ratio) * 100) / 100
        pixelChecks.push({
          selector: rec.selector,
          state: rec.state,
          required: rec.required,
          modelBg: rec.bg,
          modelRatio: rec.ratio,
          pixelBg: v.mode,
          pixelRatio: v.ratio,
          pixelWorst: v.worstRatio,
          pixelMedian: v.medianRatio,
          delta,
          modeShare: v.modeShare,
          pixels: v.pixels,
          clipMode: v.clipMode,
          clippedOut: v.clippedOut,
          shapeRadii: v.shapeInfo && v.shapeInfo.shapes ? v.shapeInfo.shapes.map((s) => s.radii) : null,
          shapeSize: v.shapeInfo ? [v.shapeInfo.width, v.shapeInfo.height] : null,
          geom: v.geom
        })
        // 前景已抹掉，盒子里剩下的像素都是真实背景；渐变底色的 modeShare 天然偏低，不作拒绝理由
        if (delta >= 0.25) {
          rec.ratio = v.ratio
          rec.pass = v.ratio >= rec.required
          rec.bg = v.ratioColor
          rec.bgVia =
            String(rec.bgVia || '') +
            ' → 像素校准 p05 ' +
            v.ratio +
            '（最差 ' +
            v.worstRatio +
            '，中位 ' +
            v.medianRatio +
            '，' +
            v.pixels +
            ' 个像素，取样口径 ' +
            v.clipMode +
            '）'
        }
      }
      verified.push(...pixelChecks)
      const pageRules = applyWcagRules(records)
      for (const [k, v] of Object.entries(pageRules)) ruleTotals[k] = (ruleTotals[k] || 0) + v
      const fails = records.filter((r) => !r.pass && !r.exempt)
      const exempt = records.filter((r) => r.exempt && !r.pass)
      results.push({
        viewport: vp.name,
        route: route.name,
        url: route.path,
        tagged: data.count,
        records: records.length,
        fail: fails.length,
        exempt: exempt.length,
        focusSamples: focusKeys.length,
        ringSkipped: ringStats.skipped,
        pixelSamples: pixelChecks.length,
        list: records
      })
      console.log(
        `${vp.name} ${route.path} 可见元素 ${data.count} · 记录 ${records.length} · 不达标 ${fails.length} · 禁用豁免 ${exempt.length} · 焦点取样 ${focusKeys.length}（跳过 ${ringStats.skipped}） · 像素校准 ${pixelChecks.length}`
      )
      await page.close()
    }
    await context.close()
  }

  await browser.close()

  await writeFile(path.join(OUT_DIR, 'measurements.json'), JSON.stringify(results, null, 2), 'utf8')

  const all = results.flatMap((r) => r.list)
  const failing = all.filter((r) => !r.pass && !r.exempt)
  const exempt = all.filter((r) => r.exempt && !r.pass)
  const exemptInactive = exempt.filter((r) => !r.rule || r.rule.startsWith('R5'))
  await writeFile(
    path.join(OUT_DIR, 'failures.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        counts: { records: all.length, failing: failing.length, exempt: exempt.length },
        ruleCounts: ruleTotals,
        failingByKind: failing.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] || 0) + 1 }), {}),
        failingByViewport: failing.reduce((m, r) => ({ ...m, [r.viewport]: (m[r.viewport] || 0) + 1 }), {}),
        failingByRoute: failing.reduce((m, r) => ({ ...m, [r.route]: (m[r.route] || 0) + 1 }), {}),
        failing,
        exemptByRule: exempt,
        exemptByInactiveRule: exemptInactive
      },
      null,
      2
    ),
    'utf8'
  )

  await writeFile(
    path.join(OUT_DIR, 'pixel-verify.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: '把该行文字的前景置为 transparent、子节点隐藏，元素自身底色照常渲染，再截元素自己的盒子，对每个像素算一次与前景的比值，取第 5 百分位作为文字背后真实渲染色对应的比值，与 CSS 模型结果对照。',
        samples: verified.length,
        overridden: verified.filter((v) => v.delta >= 0.25).length,
        maxDelta: verified.reduce((m, v) => Math.max(m, v.delta), 0),
        list: verified
      },
      null,
      2
    ),
    'utf8'
  )

  console.log(`\n=== 汇总 ===\n记录 ${all.length} · 不达标 ${failing.length} · 规则豁免 ${exempt.length}`)
  for (const [k, v] of Object.entries(ruleTotals)) console.log(`  ${k}：${v} 条`)
  const overridden = verified.filter((v) => v.delta >= 0.25)
  console.log(
    `像素校准抽查 ${verified.length} 条 · 与模型不一致 ${overridden.length} 条 · 最大偏差 ${verified.reduce(
      (m, v) => Math.max(m, v.delta),
      0
    )}`
  )
  const groups = new Map()
  for (const f of failing) {
    const k = `${f.kind}|${f.state}|${(f.selector || '').replace(/“.*”/, '').replace(/\[testid=[^\]]*\]/, '')}|${f.fg}|${f.bg}|${f.required}|${f.part || ''}`
    const e = groups.get(k)
    if (e) {
      e.n += 1
      e.min = Math.min(e.min, f.ratio)
      e.max = Math.max(e.max, f.ratio)
      e.routes.add(`${f.route}/${f.viewport}`)
      if (e.texts.length < 3 && f.text && !e.texts.includes(f.text)) e.texts.push(f.text.slice(0, 14))
    } else {
      groups.set(k, { n: 1, min: f.ratio, max: f.ratio, routes: new Set([`${f.route}/${f.viewport}`]), texts: f.text ? [f.text.slice(0, 14)] : [], rec: f })
    }
  }
  const rows = [...groups.values()].sort((a, b) => a.min - b.min)
  for (const r of rows) {
    const f = r.rec
    console.log(
      `×${r.n} [${f.state}] ${f.kind} ${f.selector.replace(/“.*”/, '').replace(/\[testid=[^\]]*\]/, '')} ${f.fg}/${f.bg} ${r.min}~${r.max} 需 ${f.required} 例:${r.texts.join(' | ')}`
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
