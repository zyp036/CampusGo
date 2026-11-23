/**
 * CampusGo 设计系统 —— Tailwind 主题
 *
 * 所有颜色值以 CSS 自定义属性形式定义在 src/assets/main.css 的 :root 中，
 * 这里通过 rgb(var(--x) / <alpha-value>) 引用，因此支持 bg-brand-500/10 等透明度写法。
 *
 * 响应式断点约定（阶段2 决策）：
 *   sm  640px  大屏手机
 *   md  768px  平板 —— 移动端导航范式，但内容改为双列
 *   lg  1024px PC 分界线 —— 切换为左侧固定侧边栏
 *   xl  1280px 笔记本
 *   2xl 1536px 桌面
 */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    screens: {
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px'
    },
    extend: {
      colors: {
        /** 主蓝色阶，500 = #4569E8 */
        brand: {
          50: 'rgb(var(--c-brand-50) / <alpha-value>)',
          100: 'rgb(var(--c-brand-100) / <alpha-value>)',
          200: 'rgb(var(--c-brand-200) / <alpha-value>)',
          300: 'rgb(var(--c-brand-300) / <alpha-value>)',
          400: 'rgb(var(--c-brand-400) / <alpha-value>)',
          500: 'rgb(var(--c-brand-500) / <alpha-value>)',
          600: 'rgb(var(--c-brand-600) / <alpha-value>)',
          700: 'rgb(var(--c-brand-700) / <alpha-value>)',
          800: 'rgb(var(--c-brand-800) / <alpha-value>)',
          900: 'rgb(var(--c-brand-900) / <alpha-value>)',
          950: 'rgb(var(--c-brand-950) / <alpha-value>)'
        },
        /** 辅助紫色阶，500 = #7665E8 */
        accent: {
          50: 'rgb(var(--c-accent-50) / <alpha-value>)',
          100: 'rgb(var(--c-accent-100) / <alpha-value>)',
          200: 'rgb(var(--c-accent-200) / <alpha-value>)',
          300: 'rgb(var(--c-accent-300) / <alpha-value>)',
          400: 'rgb(var(--c-accent-400) / <alpha-value>)',
          500: 'rgb(var(--c-accent-500) / <alpha-value>)',
          600: 'rgb(var(--c-accent-600) / <alpha-value>)',
          700: 'rgb(var(--c-accent-700) / <alpha-value>)',
          800: 'rgb(var(--c-accent-800) / <alpha-value>)',
          900: 'rgb(var(--c-accent-900) / <alpha-value>)'
        },
        /** 文字颜色，由深到浅 */
        ink: {
          900: 'rgb(var(--c-ink-900) / <alpha-value>)',
          700: 'rgb(var(--c-ink-700) / <alpha-value>)',
          500: 'rgb(var(--c-ink-500) / <alpha-value>)',
          400: 'rgb(var(--c-ink-400) / <alpha-value>)',
          300: 'rgb(var(--c-ink-300) / <alpha-value>)'
        },
        /** 背景与卡片 */
        surface: {
          page: 'rgb(var(--c-surface-page) / <alpha-value>)',
          card: 'rgb(var(--c-surface-card) / <alpha-value>)',
          muted: 'rgb(var(--c-surface-muted) / <alpha-value>)',
          sunken: 'rgb(var(--c-surface-sunken) / <alpha-value>)'
        },
        /** 描边 */
        line: {
          DEFAULT: 'rgb(var(--c-line) / <alpha-value>)',
          strong: 'rgb(var(--c-line-strong) / <alpha-value>)',
          /* 这两个是阶段2.2 对比度审计新加的控件专用描边。只在 main.css 里定义 CSS 变量不够，
             Tailwind 必须在这里注册，否则 border-line-control-strong 这类类不存在，
             @apply 会让 PostCSS 直接报错、整站样式编译不出来。 */
          control: 'rgb(var(--c-line-control) / <alpha-value>)',
          'control-strong': 'rgb(var(--c-line-control-strong) / <alpha-value>)'
        },
        success: {
          50: 'rgb(var(--c-success-50) / <alpha-value>)',
          500: 'rgb(var(--c-success-500) / <alpha-value>)',
          600: 'rgb(var(--c-success-600) / <alpha-value>)'
        },
        warning: {
          50: 'rgb(var(--c-warning-50) / <alpha-value>)',
          500: 'rgb(var(--c-warning-500) / <alpha-value>)',
          600: 'rgb(var(--c-warning-600) / <alpha-value>)'
        },
        danger: {
          50: 'rgb(var(--c-danger-50) / <alpha-value>)',
          500: 'rgb(var(--c-danger-500) / <alpha-value>)',
          600: 'rgb(var(--c-danger-600) / <alpha-value>)'
        }
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI Variable',
          'Segoe UI',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei UI',
          'Microsoft YaHei',
          'sans-serif'
        ],
        mono: [
          'JetBrains Mono',
          'SFMono-Regular',
          'Cascadia Code',
          'Consolas',
          'monospace'
        ]
      },
      /** 语义化字号层级，避免页面里散落 text-[15px] 之类的魔法值 */
      fontSize: {
        display: ['1.75rem', { lineHeight: '1.22', letterSpacing: '-0.022em', fontWeight: '700' }],
        h1: ['1.375rem', { lineHeight: '1.3', letterSpacing: '-0.015em', fontWeight: '700' }],
        h2: ['1.125rem', { lineHeight: '1.4', letterSpacing: '-0.01em', fontWeight: '600' }],
        h3: ['1rem', { lineHeight: '1.45', fontWeight: '600' }],
        body: ['0.9375rem', { lineHeight: '1.65' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.6' }],
        caption: ['0.75rem', { lineHeight: '1.5', fontWeight: '500' }],
        overline: ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.06em', fontWeight: '600' }]
      },
      borderRadius: {
        card: '1.5rem',
        inner: '1rem',
        control: '0.75rem',
        chip: '0.625rem',
        pill: '9999px'
      },
      boxShadow: {
        card: '0 1px 2px rgb(27 36 64 / 0.04), 0 6px 24px -8px rgb(27 36 64 / 0.07)',
        raised: '0 2px 4px rgb(27 36 64 / 0.05), 0 12px 32px -8px rgb(27 36 64 / 0.11)',
        hover: '0 4px 10px rgb(27 36 64 / 0.06), 0 18px 44px -12px rgb(69 105 232 / 0.22)',
        bar: '0 -6px 26px -10px rgb(27 36 64 / 0.12)',
        pop: '0 8px 20px -6px rgb(27 36 64 / 0.10), 0 28px 64px -16px rgb(27 36 64 / 0.22)',
        glow: '0 10px 34px -10px rgb(118 101 232 / 0.42)'
      },
      backgroundImage: {
        /* 末色原为 #7665E8：白字压在上面只有 4.38:1，不到正文 4.5:1；
           改 #6A58DE 后首/末两端分别是 4.73 / 5.17，整条渐变都够。 */
        'brand-gradient': 'linear-gradient(135deg, #4569E8 0%, #6A58DE 100%)',
        'brand-gradient-soft': 'linear-gradient(135deg, #EFF3FE 0%, #F3F1FE 100%)',
        /* 第三层高亮 radial 原来 0.55，在 70% 92% 处与底层 #6A58DE 合成约 #8C8CEB，
           白字只有 3.1:1 —— 这是首页 hero 卡文字不达标的主因。降到 0.16 后合成约 #7467E2。 */
        'ai-mesh':
          'radial-gradient(at 12% 18%, rgb(69 105 232 / 0.92) 0px, transparent 55%), radial-gradient(at 88% 8%, rgb(118 101 232 / 0.88) 0px, transparent 52%), radial-gradient(at 70% 92%, rgb(168 183 245 / 0.16) 0px, transparent 48%), linear-gradient(140deg, #3B5BD6 0%, #6A58DE 100%)'
      },
      spacing: {
        /** 侧边栏固定宽度，布局与内容区留白共用 */
        sidebar: '17rem',
        'safe-bottom': 'env(safe-area-inset-bottom)'
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.22, 0.61, 0.36, 1)'
      },
      keyframes: {
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' }
        }
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.28s cubic-bezier(0.22, 0.61, 0.36, 1) both',
        'pop-in': 'pop-in 0.18s cubic-bezier(0.22, 0.61, 0.36, 1) both'
      }
    }
  },
  plugins: []
}
