import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, App as AntdApp, Button, Layout, Menu, Modal, Space, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import {
  BarChartOutlined,
  EditOutlined,
  InboxOutlined,
  MoneyCollectOutlined,
  PayCircleOutlined,
  PictureOutlined,
  PlusSquareOutlined,
  SettingOutlined,
  ShopOutlined,
  ToolOutlined,
  UserOutlined,
  WalletOutlined
} from '@ant-design/icons'
import { api, toErrorText, type AppInfo, type MissingPhotoItem } from './api'
import { Daily, createDailyDraft, type DailyDraft } from './pages/Daily'
import { QuickBatch, createBatchDraft, type BatchDraft } from './pages/QuickBatch'
import { Workers } from './pages/Workers'
import { Sites } from './pages/Sites'
import { Settings } from './pages/Settings'
import { PhotoPool } from './pages/PhotoPool'
import { Summary, createSummaryDraft, type SummaryDraft } from './pages/Summary'
import { Payroll, createPayrollDraft, type PayrollDraft } from './pages/Payroll'
import { Advances, createAdvanceDraft, type AdvanceDraft } from './pages/Advances'
import { Payments, createPaymentsDraft, type PaymentsDraft } from './pages/Payments'
import { Archive } from './pages/Archive'
import { ArchiveViewer } from './pages/ArchiveViewer'
import { MaintPanel } from './components/MaintPanel'

type PageKey =
  | 'daily'
  | 'batch'
  | 'workers'
  | 'sites'
  | 'photos'
  | 'summary'
  | 'payroll'
  | 'advances'
  | 'payments'
  | 'archive'
  | 'archiveViewer'
  | 'settings'
  | 'maint'

/**
 * 左侧导航（RQ-004 v2 §6）：每项一个图标，按 `日常 / 台账 / 统计 / 数据` 四组分组。
 * 当前项由 antd `Menu` 的 `selectedKeys` 高亮；左侧 3px 竖条与高亮底色见 `NAV_STYLE`。
 */
interface NavItem {
  key: PageKey
  label: string
  icon: ReactNode
}

const NAV_GROUPS: Array<{ key: string; label: string; items: NavItem[] }> = [
  {
    key: 'group-daily',
    label: '日常',
    items: [
      { key: 'daily', label: '每日录入', icon: <EditOutlined /> },
      { key: 'batch', label: '批量登记', icon: <PlusSquareOutlined /> }
    ]
  },
  {
    key: 'group-ledger',
    label: '台账',
    items: [
      { key: 'workers', label: '工人台账', icon: <UserOutlined /> },
      { key: 'sites', label: '工地', icon: <ShopOutlined /> },
      { key: 'photos', label: '照片池', icon: <PictureOutlined /> }
    ]
  },
  {
    key: 'group-stats',
    label: '统计',
    items: [
      { key: 'summary', label: '汇总', icon: <BarChartOutlined /> },
      { key: 'payroll', label: '工资表', icon: <MoneyCollectOutlined /> },
      { key: 'advances', label: '预支', icon: <WalletOutlined /> },
      // 「工资发放」排在「预支」之后（PL-004-sds §16 T8）。
      // 图标：前面两项已占了 `WalletOutlined`（预支）与 `MoneyCollectOutlined`（工资表），
      // 所以这里用同样表示「发钱」但不重复的 `PayCircleOutlined`。
      // 旧「结算单」那一项已随 `Settlement.tsx` 下线（RQ-005 C9 拆锁，PL-004 T9）——
      // 发钱只走这一页，结算单只剩只读的历史单（提示条归 T14），不再有导航入口。
      { key: 'payments', label: '工资发放', icon: <PayCircleOutlined /> }
    ]
  },
  {
    key: 'group-data',
    label: '数据',
    items: [
      { key: 'archive', label: '归档', icon: <InboxOutlined /> },
      { key: 'maint', label: '维护 / 快照', icon: <ToolOutlined /> },
      { key: 'settings', label: '设置', icon: <SettingOutlined /> }
    ]
  }
]

/** 扁平化的导航项（找标题 / 判断当前项用） */
const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

/** antd Menu 的 items：分组标题 + 带图标的菜单项 */
const MENU_ITEMS: MenuProps['items'] = NAV_GROUPS.map((group) => ({
  key: group.key,
  type: 'group' as const,
  label: group.label,
  children: group.items.map((item) => ({ key: item.key, label: item.label, icon: item.icon }))
}))

/**
 * 导航样式（antd v5 是 CSS-in-JS，这里只补两件它没提供的：
 * 当前项左侧 3px 竖条、分组标题的字号与留白）。样式作用域挂在 `.att-nav` 上。
 */
const NAV_STYLE = `
.att-nav .ant-menu-item-group-title { padding: 6px 14px 2px; font-size: 12px; color: #8c8c8c; letter-spacing: 0.5px; }
.att-nav .ant-menu-item-group:first-child .ant-menu-item-group-title { padding-top: 2px; }
.att-nav .ant-menu-item {
  width: calc(100% - 12px) !important;
  margin: 3px 6px !important;
  padding-left: 14px !important;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  position: relative;
  transition: border-color 0.15s, background 0.15s;
}
.att-nav .ant-menu-item:hover { border-color: #91caff; background: #f5faff !important; }
.att-nav .ant-menu-item-selected {
  background: #e6f4ff !important;
  border-color: #1677ff;
  font-weight: 600;
}
.att-nav .ant-menu-item-selected::before {
  content: ''; position: absolute; left: 3px; top: 7px; bottom: 7px; width: 3px;
  border-radius: 2px; background: #1677ff;
}
`

/**
 * 下拉框的手型光标（YG 2026-11-09）。
 *
 * 带 `showSearch` 的 `Select`（工人 / 工地）里，antd 把 `.ant-select-selector` 与搜索输入框的
 * `cursor` 设成 `text`：只管根节点 `cursor: pointer` 会被子元素盖掉，鼠标悬上去还是「工字光标」。
 * 这个全局类把整片子元素统一改回 `pointer`（`!important` 用来压过 antd 的
 * `.ant-select-show-search... .ant-select-selector { cursor: text }`）。
 * 时段那个不带搜索的 `Select` 本来是对的，不动它。
 */
const CURSOR_STYLE = `
.att-select-pointer,
.att-select-pointer .ant-select-selector,
.att-select-pointer .ant-select-selection-search,
.att-select-pointer .ant-select-selection-search-input,
.att-select-pointer .ant-select-selection-item,
.att-select-pointer .ant-select-selection-placeholder { cursor: pointer !important; }
`

/**
 * 页面标题：`archiveViewer`（档案打开页）不在左侧菜单里，它由「归档 → 档案柜 → 打开」进来，
 * 所以标题单独给一条，别让表头出现空白。
 */
const EXTRA_TITLES: Partial<Record<PageKey, string>> = {
  archiveViewer: '档案查看'
}

/**
 * 「等重启」的现场（PL-005 S4）：迁移还是恢复、新根在哪、用的哪个包、退路 zip 在哪。
 *
 * 数据来自 `settings:all` 的 `pathInfo`（主进程是唯一权威）；`restoreBackupPath` 在**重启之后**
 * 从 `<数据根上一级>\Attendance-恢复退路-最近一次.txt` 读回来（F20：不能只活在内存里）。
 */
interface PendingRestartInfo {
  kind: 'migrate' | 'restore'
  root: string
  /** 恢复用的包名（迁移路径为空串） */
  pack: string
  /** 退路 zip 的绝对路径（迁移路径为空串） */
  backupPath: string
}

export function App(): JSX.Element {
  const [page, setPage] = useState<PageKey>('daily')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  /** 档案查看页要打开哪一份（从「归档 → 档案柜 → 打开」传进来；只在主进程认 id） */
  const [archiveId, setArchiveId] = useState<number | null>(null)

  /** 「去定位」缺照片时：切到每日录入并把日期定在那天 */
  const [focusDate, setFocusDate] = useState<string | undefined>(undefined)
  /**
   * 定位到某天的点击计数（IS-006 ④）。只有它变了，每日录入才会把草稿日期改到 `focusDate`；
   * 否则「点过定位 → 填一半 → 切走 → 切回来」会被这条信号把日期顶回去。
   */
  const [focusToken, setFocusToken] = useState(0)
  /**
   * 两页的表单草稿（IS-006 ④）。页面切走会被卸载，`useState` 初值会重来一遍，
   * 所以草稿放在 `App`：卸载不销毁，提交 / 生成成功由页面自己 `onPatch` 清对应字段。
   */
  const [dailyDraft, setDailyDraft] = useState<DailyDraft>(() => createDailyDraft())
  const [batchDraft, setBatchDraft] = useState<BatchDraft>(() => createBatchDraft())
  const patchDaily = useCallback((patch: Partial<DailyDraft>): void => {
    setDailyDraft((prev) => ({ ...prev, ...patch }))
  }, [])
  const patchBatch = useCallback((patch: Partial<BatchDraft>): void => {
    setBatchDraft((prev) => ({ ...prev, ...patch }))
  }, [])
  /**
   * 汇总 / 工资表 / 预支 / 工资发放四页的输入草稿（**RQ-006**，照 `IS-006` 的既有做法：
   * 同一套「提升到 `App`」）。
   *
   * 为什么放在这里：切导航时页面组件会被卸载，页面里的 `useState` 跟着销毁、下次进来重跑初值。
   * 草稿提到 `App` 之后，页面卸载只是不渲染，容器里的值一直在；页面把它当**受控 props** 读写
   * （`draft` + `onPatch`），自己不存一份，所以「切走再回来还在」。
   *
   * 三条语义靠这里保证：
   *   1. **只在内存**：全是 React state，不写 `localStorage` / `sessionStorage` / 磁盘 / 数据库，
   *      也不进 `ui-prefs.json`（那由主进程管，本文件不碰）。
   *   2. **退出即清空**：进程退出 = 这份 state 销毁，重开是新的 `App`，全部回默认。
   *   3. **默认值不被污染**：默认值只由 `create*Draft()` 在**这里**算一次（`useState` 的惰性初值，
   *      只在挂载时执行），页面自己不再造默认值、也不从任何持久化处读回旧值；
   *      用户没动过的控件拿到的就是那份初值（例如汇总页 = 本月、工资表 = 本月初到月末、预支金额 = 空、
   *      发放页 = 本月、记发放弹窗 = 今天 + 全空）。
   */
  const [summaryDraft, setSummaryDraft] = useState<SummaryDraft>(() => createSummaryDraft())
  const [payrollDraft, setPayrollDraft] = useState<PayrollDraft>(() => createPayrollDraft())
  const [advanceDraft, setAdvanceDraft] = useState<AdvanceDraft>(() => createAdvanceDraft())
  /**
   * 工资发放页（RQ-006 最后一页）：① 页面时间范围；② 「记发放」弹窗里没保存的内容。
   *
   * 弹窗那部分用 `form: PaymentsFormDraft | null`：`null` = 从没打开过 / 已清空 / 刚保存成功。
   * 这样「没动过」与「动过再清空」是同一个状态，默认值（今天 + 空）永远只由页面现算，不会被旧值顶掉。
   */
  const [paymentsDraft, setPaymentsDraft] = useState<PaymentsDraft>(() => createPaymentsDraft())
  const patchSummary = useCallback((patch: Partial<SummaryDraft>): void => {
    setSummaryDraft((prev) => ({ ...prev, ...patch }))
  }, [])
  const patchPayroll = useCallback((patch: Partial<PayrollDraft>): void => {
    setPayrollDraft((prev) => ({ ...prev, ...patch }))
  }, [])
  const patchAdvance = useCallback((patch: Partial<AdvanceDraft>): void => {
    setAdvanceDraft((prev) => ({ ...prev, ...patch }))
  }, [])
  const patchPayments = useCallback((patch: Partial<PaymentsDraft>): void => {
    setPaymentsDraft((prev) => ({ ...prev, ...patch }))
  }, [])
  const [missingPhotoCount, setMissingPhotoCount] = useState(0)
  /**
   * 主界面「缺少 N 张照片」横幅被 × 关掉那一刻的缺失张数（`null` = 没关过）。
   *
   * YG 2026-11-11 定：**页头那个红标删掉**（和这条横幅重复），只留这一条横幅，且横幅可关。
   *
   * 只活在这次运行的组件内存里：不写磁盘、不进 `ui-prefs.json`、不进数据库，
   * 重启后缺失还在就照常显示。
   *
   * 记的是「关掉时的张数」而不是一个布尔，是为了让**张数一变就重新出现**：
   * 下面那条 effect 一发现当前张数不等于记下的值（含先归零、后来又变正数）就把这条记录作废。
   */
  const [missingBannerClosedAt, setMissingBannerClosedAt] = useState<number | null>(null)
  /** 那条横幅现在该不该显示：有缺失，且不是「刚被关掉的那一批」 */
  const showMissingBanner = missingPhotoCount > 0 && missingPhotoCount !== missingBannerClosedAt

  useEffect(() => {
    setMissingBannerClosedAt((prev) => (prev === null || prev === missingPhotoCount ? prev : null))
  }, [missingPhotoCount])
  /**
   * P1：数据目录已迁移 / 整库已恢复、当前进程还没摆正。
   *
   * 这时主进程会拒绝一切写操作（`E_DB_LOCKED`）。红条必须**常驻**在每个页面顶部——
   * 用户切到「每日录入」看到空白表单就开录，录完才报错，等于白干。
   *
   * PL-005 S4 起多一个 `kind`：`'restore'` 还要弹一条**不可关闭**的 Modal（带退路 zip 路径
   * 与「立即重启」），因为恢复的退路是用户唯一的后悔药，而 toast 会被 Modal 挡住（F20）。
   */
  const [pendingRestart, setPendingRestart] = useState<PendingRestartInfo | null>(null)
  /** 恢复后那条 Modal 上的就地提示（「立即重启」/「打开文件夹」失败时用，不靠 toast） */
  const [restartHint, setRestartHint] = useState('')

  useEffect(() => {
    api.settings
      .all()
      .then((s) => {
        const info = s.pathInfo
        setPendingRestart(
          info?.pendingRestart
            ? {
                kind: info.pendingRestartKind ?? 'migrate',
                root: info.pendingRestartRoot ?? '',
                pack: info.pendingRestartPack ?? '',
                backupPath: info.restoreBackupPath ?? ''
              }
            : null
        )
      })
      .catch((err: unknown) => console.warn(`[app] 读取目录状态失败：${toErrorText(err)}`))
  }, [])

  /** 恢复后点「立即重启」：主进程 `app.relaunch()` + `app.exit(0)` */
  const relaunch = useCallback((): void => {
    setRestartHint('')
    api.relaunch().catch((err: unknown) => {
      setRestartHint(`重启没成功：${toErrorText(err)}。请手动关闭软件并重新打开。`)
    })
  }, [])

  /** 在资源管理器里定位退路 zip（`app:showItemInFolder` 已放行 `.zip`） */
  const revealBackup = useCallback((path: string): void => {
    setRestartHint('')
    api.revealFile(path).catch((err: unknown) => {
      setRestartHint(`打开所在文件夹失败：${toErrorText(err)}`)
    })
  }, [])

  useEffect(() => {
    api
      .info()
      .then(setInfo)
      .catch((e: unknown) => setInfoError(toErrorText(e)))
  }, [])

  /**
   * 启动检查（G-7 缺照片）。照片目录不可读只让这一条提醒消失，不牵动其它状态。
   *
   * 这里只查「缺照片」：「缺记录」（最近 30 天有几天一条记录都没有）已按 YG 决定整条删除 ——
   * 这家公司有活儿才出工，任何一天（含周六周日）没有记录都正常，那条横幅会常驻、多半在列周日，
   * 看两周就麻木，反而把「照片被删了」这种真正要处理的信号盖掉。
   */
  const runStartupChecks = useCallback(async () => {
    try {
      const photos = await api.maint.missingPhotos()
      setMissingPhotoCount(photos.photoCount)
    } catch (err) {
      console.warn(`[app] 缺照片检查失败：${toErrorText(err)}`)
    }
  }, [])

  useEffect(() => {
    void runStartupChecks()
  }, [runStartupChecks])

  const locateDate = (date: string): void => {
    setFocusDate(date)
    setFocusToken((n) => n + 1)
    setPage('daily')
  }

  const locatePhoto = (item: MissingPhotoItem): void => {
    if (item.workDate) {
      locateDate(item.workDate)
      return
    }
    setPage('photos')
  }

  /**
   * 页头右侧的「库诊断」（库版本 / 日志模式 / 数据路径）收成一个 8px 圆点：
   * 平时不占位、不往页头 innerText 里塞字，悬停才用 Tooltip 摊开——
   * 之前那三个常驻 Tag/文本把 40px 的页头撑得很挤，且每次截图都挡住该看的东西。
   *
   * 颜色沿用原来那三个控件的语义：还没读到 info 时灰、`db.ok` 绿、否则红；
   * 库异常时圆点红、Tooltip 只报 `库异常：<error>`。
   */
  const dbDotColor = info === null ? '#d9d9d9' : info.db.ok ? '#52c41a' : '#ff4d4f'
  const dbTooltip =
    info === null
      ? '正在读取库信息…'
      : info.db.ok
        ? `库 v${info.db.schemaVersion}（结构版本 ${info.db.schemaVersion}）\n日志模式：${info.db.journalMode}\n数据目录：${info.db.path}`
        : `库异常：${info.db.error ?? '未知错误'}`

  return (
    <AntdApp>
      <style>{CURSOR_STYLE}</style>
      {/*
        IS-002 布局（方案 1）：外层固定一屏高 + 裁掉溢出，滚动条只落在 Content 里。
        `minHeight: '100vh'` 会让整个文档随内容撑高、滚动条跑到 body 上，
        Sider 是文档流里的普通 flex 子项，于是跟着一起滚出视口；
        Header 里的「缺照片」提醒也就跟着滚走了。
        antd 的 Layout 与 Content 自带 `min-height:0`（见 antd/es/layout/style），
        所以这里给 Content 加 `overflow:'auto'` 就能真正在内容区内部滚动。
      */}
      <Layout style={{ height: '100vh', overflow: 'hidden' }}>
        <Layout.Sider width={190} theme="light" style={{ overflow: 'auto' }}>
          <style>{NAV_STYLE}</style>
          <Menu
            className="att-nav"
            mode="inline"
            selectedKeys={[page]}
            items={MENU_ITEMS}
            onClick={(e) => setPage(e.key as PageKey)}
            style={{ borderInlineEnd: 'none', paddingTop: 8 }}
          />
        </Layout.Sider>

        <Layout>
          <Layout.Header
            /**
             * 紧凑页头：antd 默认 64px 高、line-height 64px，菜单条常驻后顶部会多占一行，
             * 这里压到 40px 把高度补回来。`lineHeight` 必须跟着收（否则 64px 行高会把
             * 内容顶出 40px 盒子），`alignItems: 'center'` 让标题与右侧徽标垂直居中。
             * 徽标字号保持 12px 不变——塞得进去靠的是高度，不是把字缩小。
             */
            style={{
              background: '#fff',
              height: 40,
              lineHeight: '40px',
              padding: '0 20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              // 页头与下方工作区的分界：比 #f0f0f0 明显，一眼看出上面是标题/菜单、下面是内容
              borderBottom: '1px solid #d9d9d9'
            }}
          >
            <Typography.Text strong>
              {NAV_ITEMS.find((m) => m.key === page)?.label ?? EXTRA_TITLES[page] ?? ''}
            </Typography.Text>
            <Space size={12} wrap>
              {/*
                YG 2026-11-11 定：**页头这个「缺照片」红标删掉** —— 它和主界面那条
                「缺少 N 张照片」横幅重复，留一条就够；横幅那边可关（见下方 Content 里的 Alert）。
              */}
              {/*
                库诊断收成一个 8px 圆点（悬停出 Tooltip，内容三行；`whiteSpace:'pre-line'`
                吃 `\n`）。圆点不参与页头高度：它是 Space 的 flex 子项，8px < 40px 行高。
              */}
              <Tooltip
                title={<span style={{ whiteSpace: 'pre-line' }}>{dbTooltip}</span>}
                placement="bottomRight"
              >
                <span
                  data-testid="db-status-dot"
                  aria-label="库状态"
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: dbDotColor,
                    flex: '0 0 auto'
                  }}
                />
              </Tooltip>
            </Space>
          </Layout.Header>

          {/*
            RQ-004 v4：汇总页要「整页只有一个滚动区」，它自己是三段式（工具条 / 内容区 / 合计条）。
            这里只在汇总页把 Content 变成 flex 列，让页面根节点能用 `flex:1 + min-height:0` 精确吃掉
            剩余高度——包括顶部有告警条时也不会把页面顶出第二根滚动条。
            其它页面保持原来的块级流，不受影响。
          */}
          <Layout.Content
            style={{
              padding: 20,
              background: '#f5f5f5',
              overflow: 'auto',
              ...(page === 'summary' ? { display: 'flex', flexDirection: 'column' } : {})
            }}
          >
            {pendingRestart !== null && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message={
                  pendingRestart.kind === 'restore'
                    ? `已用整库备份包${pendingRestart.pack === '' ? '' : `「${pendingRestart.pack}」`}恢复数据，请重启软件后再操作`
                    : '数据目录已迁移，请重启软件后再操作'
                }
                description={
                  pendingRestart.kind === 'restore' ? (
                    <Space direction="vertical" size={4}>
                      <Typography.Text>数据根：{pendingRestart.root}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        当前进程已经换成包里的库，但界面里的缓存还是旧的：现在所有保存 / 录入 / 导入都会被拒绝
                        （E_DB_LOCKED）。请点下方弹窗里的「立即重启」，或手动关闭软件再重新打开。
                      </Typography.Text>
                      {pendingRestart.backupPath !== '' && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          退路包（恢复前的整库）：{pendingRestart.backupPath}
                        </Typography.Text>
                      )}
                    </Space>
                  ) : (
                    <Space direction="vertical" size={4}>
                      <Typography.Text>
                        新数据目录：{pendingRestart.root}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        当前进程仍连着旧库：现在录的考勤会写进旧库、重启后消失，收件箱也已停止吸入。
                        请关闭软件后重新打开；旧目录保留，确认新位置无误后再手工删除。
                      </Typography.Text>
                    </Space>
                  )
                }
              />
            )}

            {infoError && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message="读取主进程信息失败"
                description={infoError}
              />
            )}

            {showMissingBanner && page !== 'maint' && (
              <Alert
                type="error"
                showIcon
                /**
                 * YG 2026-11-11 定：这条横幅**可以关掉**，页头那个重复的红标已删。
                 * 关掉只关「这一次运行的这一批」：把当前张数记进内存（`missingBannerClosedAt`），
                 * 张数一变它自己回来（含先归零、后来又变正数）；不写磁盘、重启照常显示。
                 */
                closable
                onClose={() => setMissingBannerClosedAt(missingPhotoCount)}
                style={{ marginBottom: 16 }}
                message={`缺少 ${missingPhotoCount} 张照片`}
                description="记录不会被清空，可以继续录入；这些照片的位置会显示裂图。"
                action={
                  <Button size="small" onClick={() => setPage('maint')}>
                    去定位
                  </Button>
                }
              />
            )}

            {/* IS-006 ④：两页的草稿都在这个组件里，切导航（页面卸载）不会丢 */}
            {page === 'daily' && (
              <Daily
                focusDate={focusDate}
                focusToken={focusToken}
                draft={dailyDraft}
                onPatch={patchDaily}
              />
            )}
            {page === 'batch' && <QuickBatch draft={batchDraft} onPatch={patchBatch} />}
            {page === 'workers' && <Workers />}
            {page === 'sites' && <Sites />}
            {page === 'photos' && <PhotoPool />}
            {/* 汇总页（RQ-004 v2）：点格子只开浮窗，不再跳「每日录入」 */}
            {/* RQ-006：日期范围 / 视图 / 选中对象由 `App` 的 `summaryDraft` 持有，切导航不丢 */}
            {page === 'summary' && <Summary draft={summaryDraft} onPatch={patchSummary} />}
            {/* RQ-006：起止日期由 `App` 的 `payrollDraft` 持有，切导航不丢 */}
            {page === 'payroll' && <Payroll draft={payrollDraft} onPatch={patchPayroll} />}
            {/* RQ-006：记一笔的金额 / 备注 / 已选凭证由 `App` 的 `advanceDraft` 持有，切导航不丢 */}
            {page === 'advances' && <Advances draft={advanceDraft} onPatch={patchAdvance} />}
            {/* 工资发放（PL-004 T8）：记发放 + 结余看板，是发钱的唯一入口 */}
            {/* RQ-006：时间范围 + 记发放弹窗里没保存的内容由 `App` 的 `paymentsDraft` 持有，切导航不丢 */}
            {page === 'payments' && <Payments draft={paymentsDraft} onPatch={patchPayments} />}
            {page === 'archive' && (
              <Archive
                onOpen={(id) => {
                  setArchiveId(id)
                  setPage('archiveViewer')
                }}
              />
            )}
            {page === 'archiveViewer' && archiveId !== null && (
              <ArchiveViewer archiveId={archiveId} onBack={() => setPage('archive')} />
            )}
            {page === 'maint' && (
              <MaintPanel
                onLocatePhoto={locatePhoto}
                onDataChanged={() => void runStartupChecks()}
              />
            )}
            {page === 'settings' && <Settings />}
          </Layout.Content>
        </Layout>
      </Layout>

      {/*
        PL-005 S4 / RQ-008 U10：恢复成功后那条**不可关闭**的 Modal（根级、只在 restore 时出现）。

        三件必须在这里、不能只放 toast 的事（F20：toast 会被这条 Modal 挡住）：
          1. 退路 zip 的绝对路径（可选中复制）+「打开所在文件夹」——那是用户唯一的后悔药；
          2. 「立即重启」（`app:relaunch`）+ 兜底文案「手动关闭再打开」（U10）；
          3. 包名与数据根（说清「现在的数据是从哪来的」）。
        `closable/maskClosable/keyboard` 三个全关：写通道在等重启期间一律 E_DB_LOCKED，关掉也做不了事。
      */}
      {pendingRestart !== null && pendingRestart.kind === 'restore' && (
        <Modal
          open
          closable={false}
          maskClosable={false}
          keyboard={false}
          width={680}
          title="已恢复整库数据，请重启软件"
          footer={[
            <Button
              key="reveal"
              disabled={pendingRestart.backupPath === ''}
              onClick={() => revealBackup(pendingRestart.backupPath)}
            >
              打开退路所在文件夹
            </Button>,
            <Button key="relaunch" type="primary" onClick={relaunch}>
              立即重启
            </Button>
          ]}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <div style={{ lineHeight: 1.9, fontSize: 12 }}>
              <div>
                包文件：
                <Typography.Text copyable style={{ fontSize: 12 }}>
                  {pendingRestart.pack === '' ? '(未知包名)' : pendingRestart.pack}
                </Typography.Text>
              </div>
              <div>数据根：{pendingRestart.root}</div>
              <div>
                退路包（恢复**前**的整库，点上面按钮可打开它所在的文件夹）：
                {pendingRestart.backupPath === '' ? (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    没拿到路径（见数据根上一级的「Attendance-恢复退路-最近一次.txt」）
                  </Typography.Text>
                ) : (
                  <Typography.Text copyable style={{ fontSize: 12 }}>
                    {pendingRestart.backupPath}
                  </Typography.Text>
                )}
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  退路包含快照，但不含收件箱里还没吸进来的照片与缩略图缓存。
                </Typography.Text>
              </div>
              <div>
                <Typography.Text style={{ fontSize: 12 }}>
                  重启之前所有保存 / 录入 / 导入都会被拒绝（E_DB_LOCKED）：当前进程已经换成包里的库，
                  界面里的缓存还是旧的。
                </Typography.Text>
              </div>
            </div>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              如果「立即重启」没反应，请手动关闭软件并重新打开。
            </Typography.Text>
            {restartHint !== '' && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                {restartHint}
              </Typography.Text>
            )}
          </Space>
        </Modal>
      )}
    </AntdApp>
  )
}
