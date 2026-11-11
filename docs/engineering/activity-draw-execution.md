# LL-LOT-002 · 今日抽奖服务端执行与核销

Issue #174 的服务端实现；建立在 #173 的真实奖品池上。H5 入口、动画与“我的奖励” UI 属于 #175，本卡并未恢复前端抽奖。

## 发布前必要配置

由运营人员注入稳定且保密的 DRAW_CREDENTIAL_SECRET，至少 32 字符，建议使用密码管理器生成随机值；不可写入 Git、SQLite 或客户端。未配置时抽奖返回不可用且不扣库存。密钥跨重启必须一致，变更密钥将使未核销码无法再派生和核销，切换前必须有迁移方案。不得与微信 Master Key、Cookie 密钥、供应商凭证混用。

只有后台配置了真实商品、独立库存、奖品实际履约成本、抽奖权重和已发布活动，才能开放真实开奖。默认不要自动启用、不要预置虚构奖品。

## 共享 API 契约

- GET /activities/:activityId/draw-state：允许匿名查看登录状态与不可用原因，已登录用户可看到北京时间当日次数与剩余次数。
- POST /activities/:activityId/draw：居民登录、CSRF、可信 Origin，body 必须仅含 idempotencyKey UUID。系统自己判断用户、社区、活动、库存、随机结果；返回持久化中奖或未中奖。
- GET /activities/:activityId/draw-history：仅当前登录用户自己的历史和中奖凭据（最近 200 条抽奖记录，同时独立返回所有尚未核销的中奖凭据，不受历史条数限制）。只有 active 凭据返回完整码，核销后只返回尾号。
- POST /admin/activities/:activityId/draw-verify：授权员工验证码的有效性与状态，验证不会核销。
- POST /admin/activities/:activityId/draw-redeem：授权员工核销 active 中奖码，成功且只能一次，重复为 409。
- POST /admin/activities/:activityId/draw-revoke：有奖品池管理权限的工作人员撤销尚未使用的码并留下审计理由；已经核销的中奖只能追加 disputed 事件，不得抹除既有核销。

## 不变量

迁移 0016 新增 activity_draw_attempts、activity_draw_credentials 与 activity_draw_fulfilment_events。与三人团 activity_reward_*、activity_prize_stocks 完全隔离。

- 北京时间 UTC+8 自然日；数据库唯一索引分别约束“用户+活动+日期+次数”和“用户+活动+幂等键”。原请求键重试返回原结果，含在活动暂停后。
- 同一 SQLite BEGIN IMMEDIATE 事务执行资格与次数检查、Node crypto.randomInt 加权抽取、条件扣库存、结果记录和中奖凭据入库。任一环节失败全部回滚。无中奖同样持久入账。
- 有效奖品只包含启用、正权重、有剩余数量的真实库存，额外存在后台配置的未中奖权重，不自动必中。
- 奖品名称、图片、实际成本在中奖瞬间冻结；已中奖和已核销的数据不可删改，数据库触发器守护追加式流水。
- SQLite 仅持有核销码 SHA-256 哈希与后四位。码由随机凭据 UUID 与独立部署密钥 HMAC 派生，保障重启后本人可查看、泄露库文件不能直接伪造。
- 居民必须已绑定活动所属社区。员工核销/验证具备该社区服务端权限；所有 POST 验证会话、CSRF 和可信 Origin。
- 撤销不自动返还库存，已核销纠纷用追加事实记录，不改写历史。

## 验证与限制

新 API 测试使用真实 Hono app + SQLite，覆盖登录、CSRF、幂等重放、每日限额、无中奖、北京时间跨日、密钥缺失 fail-closed、社区权限、核销一次性、两账号争抢库存、旧库迁移与审计不可变。构建、全量检查以对应 GitHub PR CI 和本地执行日志为准。

没有微信真机验收、真实商品清点或线上配置。即使合并 dev 也不等于抽奖功能已向居民上线；必须先完成 #175 及运营配置，再独立晋级 MVP。
