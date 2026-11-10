# LL-LOT-001 验证证据（Issue #173）

日期：2026-11-10
基线：`dev@dc2d4589361c2a9ce91fa198937dcfba27e2d970`

## 1. 自动化门禁

```bash
pnpm check
```

结果：**EXIT 0**（日志 `/tmp/ll-check.log`，仅本机临时路径，不入库）。

| 门禁 | 结果 |
| --- | --- |
| oxlint | 0 error（存在仓库既有 warning；本次新增文件无 warning） |
| contracts / api / admin / web typecheck | 通过 |
| API tests | **394 pass / 0 fail**（含新增 `apps/api/test/activity-draw.test.ts` 9 条） |
| admin vitest | **215 pass / 0 fail**（含新增 `DrawPoolDrawer.test.tsx` 3 条） |
| web tests | 27 pass / 0 fail |
| local-dev scripts | 7 pass / 0 fail |
| build | contracts + api + admin + web 全部通过 |

新增 API 用例覆盖：

1. 未配置活动返回 `configured:false`，居民只读返回 `draw_pool_not_configured`；
2. 真实商品快照持久化，刷新 / 重启后配置不丢，商品改名改价不回写奖品；
3. 启用前必须有真实「已启用 + 有库存 + 权重大于 0」的奖品；
4. 未发布 / 未启用 / 无可抽奖品时居民响应不带任何奖品行；
5. 管理员 / 运营员 / 网格员 / 未登录权限、跨社区读写、CSRF、跨社区商品、缺失商品；
6. 参数越界、重复商品、总量小于已抽取数量、剩余量不能被重新补回、陈旧并发令牌；
7. 已抽取后的奖品快照、已抽数量、删除与审计追加不可变；
8. 已结束活动拒绝配置写入，居民只读返回 `activity_ended`；
9. 截取 `0000..0014` 的真实旧库升级到 `0015`，原活动数据保留，新表可立即使用。

复跑命令：

```bash
pnpm --filter @sanchuang-dev/local-life-api test
pnpm --filter @sanchuang-dev/local-life-admin test
pnpm check
```

## 2. 真实浏览器验证

环境：Chromium headless（本机 `/usr/bin/chromium`），1440 × 1000，
本地 `pnpm dev:local`（API 4080 / Admin 5174），真实 SQLite。

步骤：

1. 通过真实 `POST /auth/login` 建立管理员会话；
2. 打开真实活动列表并点击行内「今日抽奖」；
3. 确认抽屉显示真实商品快照、成本 `¥88.88`、库存 `5 / 1 / 4`、权重 `90`；
4. 点击「一键关闭抽奖」，确认页面提示「抽奖已关闭，居民端立即返回不可用」；
5. 关闭后调用 `GET /activities/public/:activityId/draw-pool`，确认
   `available:false`、`unavailableReason:"draw_pool_disabled"`、`prizes:[]`。

浏览器控制台：**0 exceptions / 0 error logs**。

截图：

- [`draw-pool-enabled-1440.png`](draw-pool-enabled-1440.png)：真实奖品池启用态；
- [`draw-pool-disabled-1440.png`](draw-pool-disabled-1440.png)：一键关闭后的服务端状态与提示。

说明与验证缺口：

- 仓库未安装 Playwright / Puppeteer，本次使用一次性 Chromium CDP 脚本（仅验证用，未入库）；
- 运行环境默认无中文字体，首次截图汉字为方框；为取得可读证据，本次在工作机用户字体目录临时安装
  Noto Sans CJK SC 后重拍，未修改仓库依赖；
- 本卡只改管理台桌面配置界面，未改居民 H5 路由或页面，因此未重复执行 H5 的 375 / 320 宽度检查；
- 截图来自 headless Chromium，不是真机或 Android 验收。
