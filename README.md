# 赛鸽登记站 · 成绩申诉复核系统

成绩公布后鸽主可在申诉期内提交异议并附证据，审理人受理 / 要求补证 / 驳回 / 改判；
改判自动重算同场排名并保留原始名次，全程留痕可追溯。

## 运行

```bash
npm install   # 若 better-sqlite3 编译失败，使用 CC=/usr/bin/gcc CXX=/usr/bin/g++ npm install
npm start     # http://localhost:3024 ，数据库文件 data/app.db（重启不丢数据）
npm test      # 31 项测试：业务规则 / 并发 / 事务回滚 / 重启持久化
bash scripts/walkthrough.sh   # 31 项端到端走查（需服务已启动）
```

演示账号：鸽主 `owner1` / `owner2`（密码 `owner123`），审理人 `reviewer`（密码 `review123`）。
种子数据含一场申诉期内的赛事和一场已过申诉期的赛事。

## 业务规则

- **申诉提交**：仅申诉期内、已公布赛事、归属自己的已登记成绩；每条成绩只能申诉一次（唯一约束拦截重复）。
- **状态机**：`待审理 → 已受理 / 待补证 → 已驳回 / 已改判`；受理冻结该鸽转让与成绩修改，终态自动解冻；终态后任何操作返回 `appeal_closed`。
- **补证**：审理人设期限，鸽主限期内补证回到待审理；超期补证返回 `supplement_overdue`。
- **改判**：仅已受理状态可改判；按新分速重算同场全部名次，`original_rank` 永久保留，调整写入 `ranking_history`。
- **越权**：未登录 401；鸽主调审理接口、审理人代补证、申诉他人成绩均 403。
- **并发**：状态迁移使用 `status + version` 条件更新，并发受理/改判只有一个成功（`concurrent_modification`）；重复申诉由唯一索引兜底。
- **事务**：所有多步写操作包裹在 SQLite 事务中，任一步失败整体回滚，不留半条记录（测试用故障注入验证）。
- **追溯**：`appeal_events` 记录每次状态迁移（操作人/时间/备注），`ranking_history` 记录每次名次与分速变化（含关联申诉号）。

## 结构

```
server.js            入口（PORT 默认 3024，DB_PATH 默认 data/app.db）
src/db.js            SQLite schema（WAL、外键、唯一约束）
src/services.js      领域服务：状态机、事务、排名重算、冻结
src/app.js           HTTP 路由与鉴权
src/seed.js          演示数据
public/              前端单页（鸽主 / 审理人 / 成绩榜）
test/                node:test 测试（31 项）
scripts/walkthrough.sh  端到端走查脚本
scripts/restart.sh      重启脚本（--fresh 重置数据）
```
