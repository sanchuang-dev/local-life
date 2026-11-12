# LL-MVP-006 迁移 0006 与旧库升级证据

> 本文只记录**队长亲自执行**的验证，不转载队友报告。
> 验证时间：2026-11-04（本机 macOS / Node 22 / better-sqlite3 13.0.3）
> 基线：`sanchuang-dev/local-life` `dev@7095b845c3a47a6d08d2ad663b10bcffe51e1194`

## 1. 迁移历史顺延，未覆盖既有文件

```
git status --short apps/api/db/migrations/ | grep -E '000[0-5]'   → 空
```

`meta/_journal.json` 实际条目：

```
0 0000_freezing_micromax
1 0001_oval_mulholland_black
2 0002_nosy_white_queen
3 0003_crm_core
4 0004_polite_black_bird
5 0005_opposite_gunslinger
6 0006_wakeful_wallow      ← 本卡新增，idx 顺延
```

`0000`–`0005` 六个文件未被修改，0006 以追加方式进入历史。

## 2. 旧库原地升级（真实 SQLite 文件）

方法：复制 `db/migrations` 到临时目录，把 journal 截断为 `idx <= 5`，先用它建一个**只有旧历史**的库；
再用完整的迁移目录重新打开同一个 `.sqlite` 文件，让 0006 原地生效。

```
LEGACY has 0006 tables? false      ← 旧库确实不含本卡对象
LEGACY object count: 136
AFTER has activity_checkins? true
AFTER has grants uq? true          ← activity_reward_grants_activity_team_uq
AFTER has stocks uq? true          ← activity_prize_stocks_activity_prize_uq
AFTER activities.reward_plan_json? true
backfilled rows (must be 0): 0     ← 既有行未被回填
```

结论：

- 0006 能在**已存在的旧库**上原地应用，不需要删库重建；
- `ALTER TABLE activities ADD reward_plan_json` 以可空列追加，**未重建表、未回填历史行**；
- 两处新唯一索引（活动级 grant、`(activity_id, prize_name)` stock）在升级后均存在。

## 3. 已知运维事实：Drizzle 不比对 SQL 文本

`drizzle-orm` 的 migrator 以 `meta/_journal.json` 的时间戳 + `__drizzle_migrations` 表判定"是否已应用"，
**不比对迁移文件内容**。因此：

- 若某个本地库**已经跑过旧版 0006**（本卡开发过程中改过 0006 的索引定义），再次启动**不会重跑**，
  会静默保留旧索引，且**不报错**；
- 表现是"代码是修复后的，库还是旧约束"，容易得到**假阴性**验收结论。

处置：

- CI 与全新环境每次从零建库，不受影响；
- **本地验收与 R2 端到端验收必须从零建库**，不要复用已有的 `.data/local-life-dev.sqlite`；
- 已在 `apps/api/db/migrations/0006_wakeful_wallow.sql` 文件头写明该事实，并附手工
  `DROP INDEX` / `CREATE INDEX` 语句，供无法重建库时补救。

## 4. 复查方法（任何人都可重跑）

```bash
# 1) 旧库升级
cp -r apps/api/db/migrations /tmp/m && \
  python3 - <<'PY'
import json,io
p='/tmp/m/meta/_journal.json'
j=json.load(open(p)); j['entries']=[e for e in j['entries'] if e['idx']<=5]
json.dump(j,open(p,'w'))
PY
# 用 /tmp/m 建库，再用 apps/api/db/migrations 重新打开同一文件，比对 sqlite_master

# 2) 全量测试（含既有迁移升级用例）
pnpm --filter @sanchuang-dev/local-life-api test
```
