import { createPigeon, createRace, createUser, addResult, publishRace } from "./services.js";
import { addDays } from "./util.js";

/**
 * 幂等迁移：早期版本把角色写进了 display_name（如「张三（鸽主）」），
 * 导致身份栏「名称（角色）」中角色重复。名称只保留姓名，角色由界面按 role 字段渲染。
 */
export function migrateDisplayNames(db) {
  db.prepare(
    `UPDATE users SET display_name = TRIM(REPLACE(REPLACE(display_name, '（鸽主）', ''), '（审理人）', ''))
     WHERE display_name LIKE '%（鸽主）%' OR display_name LIKE '%（审理人）%'`
  ).run();
}

/**
 * 首次启动时写入演示数据（users 表为空才执行）：
 *  - 鸽主 owner1/owner2（密码 owner123），审理人 reviewer（密码 review123）
 *  - 一场「申诉期内」的赛事 + 一场「申诉期已过」的赛事，方便走通全部流程
 */
export function seedIfEmpty(db, now = new Date()) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (count > 0) return false;

  const nowDate = new Date(now);
  const owner1 = createUser(db, { username: "owner1", password: "owner123", displayName: "张三", role: "owner" }, nowDate);
  const owner2 = createUser(db, { username: "owner2", password: "owner123", displayName: "李四", role: "owner" }, nowDate);
  createUser(db, { username: "reviewer", password: "review123", displayName: "王五", role: "reviewer" }, nowDate);

  const p1 = createPigeon(db, { ringNo: "CHN-2026-001", color: "灰", loft: "北岸A棚", ownerId: owner1 }, nowDate);
  const p2 = createPigeon(db, { ringNo: "CHN-2026-002", color: "雨点", loft: "北岸A棚", ownerId: owner1 }, nowDate);
  const p3 = createPigeon(db, { ringNo: "CHN-2026-003", color: "红轮", loft: "东郊棚", ownerId: owner2 }, nowDate);
  const p4 = createPigeon(db, { ringNo: "CHN-2026-004", color: "白花", loft: "东郊棚", ownerId: owner2 }, nowDate);

  // 赛事一：昨天公布，申诉期 3 天（当前可申诉）
  const raceA = createRace(db, { name: "2026秋季300公里大奖赛", distanceKm: 300 }, nowDate);
  const publishedA = addDays(nowDate.toISOString(), -1);
  addResult(db, { raceId: raceA, ringNo: "CHN-2026-001", score: 1520.5 }, publishedA);
  addResult(db, { raceId: raceA, ringNo: "CHN-2026-003", score: 1498.2 }, publishedA);
  addResult(db, { raceId: raceA, ringNo: "CHN-2026-002", score: 1461.0 }, publishedA);
  addResult(db, { raceId: raceA, ringNo: "CHN-2026-004", score: 1402.7 }, publishedA);
  publishRace(db, { raceId: raceA, appealDays: 3 }, publishedA);

  // 赛事二：十天前公布，申诉期 3 天（已过期，用于演示逾期拦截）
  const raceB = createRace(db, { name: "2026春季200公里赛", distanceKm: 200 }, nowDate);
  const publishedB = addDays(nowDate.toISOString(), -10);
  addResult(db, { raceId: raceB, ringNo: "CHN-2026-002", score: 1350.0 }, publishedB);
  addResult(db, { raceId: raceB, ringNo: "CHN-2026-001", score: 1340.0 }, publishedB);
  addResult(db, { raceId: raceB, ringNo: "CHN-2026-003", score: 1305.4 }, publishedB);
  publishRace(db, { raceId: raceB, appealDays: 3 }, publishedB);

  return true;
}
