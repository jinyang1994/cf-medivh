# 账单前端

React、React Router、TypeScript、Vite、shadcn/ui 与 Recharts。

完整启动、账户配置和采集说明见[项目 README](../README.md)。下列命令在 `web` 目录运行：

```sh
npm ci
npm run dev
npm run build
npm run lint
```

开发服务将 `/api` 转发至 `http://127.0.0.1:8788`。构建产物位于 `dist`，由后端同源提供。

- `/billing`：当前周期费用、10 分钟累计折线图、服务费用、最近核对；图表可切换每日粒度。
- `/billing/services`：每个计费项的用量、单价、免费额度、本地累计和当前费用。当前费用使用历史官方记录加今日实时估算。
- `/billing/history`：本周期逐日官方 / 本地累计费用与差值。

## 目录职责

```text
src/
├── main.tsx                        React 挂载与 BrowserRouter
├── App.tsx                         应用入口，只装配 AppRoutes
├── routes/index.tsx                路由表与默认跳转
├── layouts/billing-layout.tsx      公共导航、错误提示、采集状态与页面容器
├── pages/billing/
│   ├── overview-page.tsx           当前账单
│   ├── services-page.tsx           服务明细
│   └── history-page.tsx            每日核对
├── components/billing/             图表、指标卡、历史表格和加载状态
├── components/ui/                  shadcn 生成组件
├── hooks/use-dashboard.ts          请求状态、取消、30 秒轮询与手动刷新
├── hooks/use-billing-dashboard.ts  子页面读取布局中的共享账单数据
├── services/billing-api.ts         HTTP 请求、超时与响应校验
├── constants/billing-navigation.ts 路径和导航项
├── types/billing.ts                共享账单类型及页面上下文
├── utils/                         金额日期格式化、服务展示汇总
└── lib/utils.ts                    shadcn 使用的类名工具
```

新增页面放入 `pages` 并在 `routes` 注册；账单页面共用布局中的一次数据请求与轮询，通过 `useBillingDashboard` 读取结果。展示组件放在 `components/billing`，网络请求集中在 `services`，通用格式化放在 `utils`。

项目内导入统一使用 `@/`，指向 `web/src`，省略 `.ts`、`.tsx`、`.js` 后缀；样式导入保留 `.css`。`@server/` 指向 `server/src`，仅用于共享类型边界：`types/billing.ts` 通过 `import type` / `export type` 引用 `@server/types`，不复制类型，也不把后端运行时代码引入前端。TypeScript 和 Vite 中的两套别名保持一致。

全部日期使用 UTC；周期显示结束日为后端排他结束日期的前一天。前端每 30 秒读取快照，后端每 10 分钟采集。缺失金额显示 `—`。10 分钟曲线使用真实采集槽位，缺采断线；“官方账单 + 预测”为历史官方费用加当日实时估算，“本地数据 + 预测”为本地核算，历史每日回填不会伪造成 10 分钟点。密集曲线保留全部数据，仅减少坐标标签和常驻点标记。

shadcn 组件及主题使用官方 CLI 安装，生成文件与默认主题未手动修改：

```sh
npx --yes shadcn@latest init --template vite --base radix --preset nova --no-monorepo --yes
npx --yes shadcn@latest add card badge alert chart table skeleton --yes
```
