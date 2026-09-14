import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { addDays, addMinutes, isAfter, nowIso } from "./util.js";
import { hashPassword } from "./auth.js";

// ---------------------------------------------------------------------------
// 申诉状态机
//   PENDING              --受理-->      ACCEPTED            （冻结该鸽）
//   PENDING              --要求补证-->  SUPPLEMENT_REQUIRED （设补证期限）
//   SUPPLEMENT_REQUIRED  --补证-->      PENDING             （期限内）
//   PENDING / SUPPLEMENT_REQUIRED / ACCEPTED --驳回--> REJECTED（终态，解冻）
//   ACCEPTED             --改判-->      REJUDGED            （终态，重算排名，解冻）
// ---------------------------------------------------------------------------
const TRANSITIONS = {
  accept: { from: ["PENDING"], to: "ACCEPTED" },
  request_supplement: { from: ["PENDING"], to: "SUPPLEMENT_REQUIRED" },
  supplement: { from: ["SUPPLEMENT_REQUIRED"], to: "PENDING" },
  reject: { from: ["PENDING", "SUPPLEMENT_REQUIRED", "ACCEPTED"], to: "REJECTED" },
  rejudge: { from: ["ACCEPTED"], to: "REJUDGED" },
};
const TERMINAL_STATUSES = ["REJECTED", "REJUDGED"];

const STATUS_LABELS = {
  PENDING: "待审理",
  ACCEPTED: "已受理",
  SUPPLEMENT_REQUIRED: "待补证",
  REJECTED: "已驳回",
  REJUDGED: "已改判",
};

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------
export function createUser(db, { username, password, displayName, role }, now) {
  if (!username?.trim()) throw badRequest("用户名不能为空");
  if (!password) throw badRequest("密码不能为空");
  if (!["owner", "reviewer"].includes(role)) throw badRequest("角色必须是 owner 或 reviewer");
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim());
  if (existing) throw conflict("username_exists", `用户名 ${username} 已存在`);
  const info = db
    .prepare("INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)")
    .run(username.trim(), hashPassword(password), displayName?.trim() || username.trim(), role, nowIso(now));
  return info.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// 鸽只与转让
// ---------------------------------------------------------------------------
export function createPigeon(db, { ringNo, color, loft, ownerId }, now) {
  if (!ringNo?.trim()) throw badRequest("足环号不能为空");
  const owner = db.prepare("SELECT id FROM users WHERE id = ?").get(ownerId);
  if (!owner) throw notFound("鸽主不存在");
  const existing = db.prepare("SELECT id FROM pigeons WHERE ring_no = ?").get(ringNo.trim());
  if (existing) throw conflict("ring_exists", `足环号 ${ringNo} 已登记`);
  const info = db
    .prepare("INSERT INTO pigeons (ring_no, owner_id, color, loft, frozen, created_at) VALUES (?,?,?,?,0,?)")
    .run(ringNo.trim(), ownerId, color?.trim() || "", loft?.trim() || "", nowIso(now));
  return info.lastInsertRowid;
}

export function listPigeons(db, user) {
  const sql = `
    SELECT p.*, u.display_name AS owner_name, u.username AS owner_username
    FROM pigeons p JOIN users u ON u.id = p.owner_id
    ${user.role === "owner" ? "WHERE p.owner_id = @ownerId" : ""}
    ORDER BY p.id`;
  return db.prepare(sql).all({ ownerId: user.id });
}

export function listTransfers(db, pigeonId) {
  return db
    .prepare(
      `SELECT t.*, fu.display_name AS from_name, tu.display_name AS to_name
       FROM transfers t
       JOIN users fu ON fu.id = t.from_owner_id
       JOIN users tu ON tu.id = t.to_owner_id
       WHERE t.pigeon_id = ? ORDER BY t.id`
    )
    .all(pigeonId);
}

export const transferPigeon = (db, { pigeonId, toUsername, actorId }, now) =>
  db.transaction(() => {
    const pigeon = db.prepare("SELECT * FROM pigeons WHERE id = ?").get(pigeonId);
    if (!pigeon) throw notFound("鸽只不存在");
    if (pigeon.owner_id !== actorId) throw forbidden("只有当前鸽主可以转让该鸽");
    if (pigeon.frozen) throw conflict("pigeon_frozen", "该鸽存在已受理的申诉，复核期间冻结转让");
    const to = db.prepare("SELECT * FROM users WHERE username = ?").get(String(toUsername || "").trim());
    if (!to) throw notFound("接收人不存在");
    if (to.role !== "owner") throw badRequest("只能转让给鸽主账号");
    if (to.id === pigeon.owner_id) throw badRequest("不能转让给自己");
    const ts = nowIso(now);
    db.prepare("UPDATE pigeons SET owner_id = ? WHERE id = ?").run(to.id, pigeonId);
    db.prepare("INSERT INTO transfers (pigeon_id, from_owner_id, to_owner_id, created_at) VALUES (?,?,?,?)").run(
      pigeonId,
      pigeon.owner_id,
      to.id,
      ts
    );
    return { pigeonId, fromOwnerId: pigeon.owner_id, toOwnerId: to.id };
  })();

// ---------------------------------------------------------------------------
// 赛事与成绩
// ---------------------------------------------------------------------------
export function createRace(db, { name, distanceKm }, now) {
  if (!name?.trim()) throw badRequest("赛事名称不能为空");
  const info = db
    .prepare("INSERT INTO races (name, distance_km, status, created_at) VALUES (?,?, 'draft', ?)")
    .run(name.trim(), Number(distanceKm) || 0, nowIso(now));
  return info.lastInsertRowid;
}

export function listRaces(db) {
  return db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM results x WHERE x.race_id = r.id) AS result_count,
              (SELECT COUNT(*) FROM appeals a WHERE a.race_id = r.id) AS appeal_count
       FROM races r ORDER BY r.id DESC`
    )
    .all();
}

export const addResult = (db, { raceId, ringNo, score }, now) =>
  db.transaction(() => {
    const race = db.prepare("SELECT * FROM races WHERE id = ?").get(raceId);
    if (!race) throw notFound("赛事不存在");
    if (race.status !== "draft") throw conflict("race_not_draft", "赛事已公布，不能再登记成绩");
    const pigeon = db.prepare("SELECT * FROM pigeons WHERE ring_no = ?").get(String(ringNo || "").trim());
    if (!pigeon) throw notFound(`足环号 ${ringNo} 未登记`);
    const scoreNum = Number(score);
    if (!Number.isFinite(scoreNum) || scoreNum < 0) throw badRequest("分速必须是不小于 0 的数字");
    const ts = nowIso(now);
    try {
      const info = db
        .prepare("INSERT INTO results (race_id, pigeon_id, owner_id, score, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(raceId, pigeon.id, pigeon.owner_id, scoreNum, ts, ts);
      return info.lastInsertRowid;
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw conflict("duplicate_result", "该鸽在此赛事已有成绩");
      throw error;
    }
  })();

/** 按分速降序重算整场名次；名次变化写入 ranking_history，原名次（original_rank）永不改动。 */
function recalcRanks(db, raceId, { appealId = null, reason, scoreChanges = new Map() }, now) {
  const ts = nowIso(now);
  const results = db.prepare("SELECT * FROM results WHERE race_id = ? ORDER BY score DESC, id ASC").all(raceId);
  const changes = [];
  results.forEach((result, index) => {
    const newRank = index + 1;
    const scoreChange = scoreChanges.get(result.id);
    if (result.rank !== newRank || scoreChange) {
      db.prepare("UPDATE results SET rank = ?, updated_at = ? WHERE id = ?").run(newRank, ts, result.id);
      db.prepare(
        `INSERT INTO ranking_history (race_id, appeal_id, pigeon_id, old_score, new_score, old_rank, new_rank, reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        raceId,
        appealId,
        result.pigeon_id,
        scoreChange ? scoreChange.oldScore : result.score,
        scoreChange ? scoreChange.newScore : result.score,
        result.rank,
        newRank,
        reason,
        ts
      );
      changes.push({ pigeonId: result.pigeon_id, oldRank: result.rank, newRank });
    }
  });
  return changes;
}

export const publishRace = (db, { raceId, appealDays }, now) =>
  db.transaction(() => {
    const race = db.prepare("SELECT * FROM races WHERE id = ?").get(raceId);
    if (!race) throw notFound("赛事不存在");
    if (race.status !== "draft") throw conflict("invalid_state", "赛事已公布，不能重复公布");
    const days = Number(appealDays);
    if (!Number.isFinite(days) || days <= 0) throw badRequest("申诉期天数必须大于 0");
    const count = db.prepare("SELECT COUNT(*) AS c FROM results WHERE race_id = ?").get(raceId).c;
    if (count === 0) throw badRequest("赛事尚无成绩，无法公布");
    const ts = nowIso(now);
    const deadline = addDays(ts, days);
    recalcRanks(db, raceId, { reason: "publish" }, now);
    db.prepare("UPDATE results SET original_rank = rank WHERE race_id = ?").run(raceId);
    db.prepare("UPDATE races SET status = 'published', published_at = ?, appeal_deadline = ? WHERE id = ?").run(ts, deadline, raceId);
    return { raceId, publishedAt: ts, appealDeadline: deadline };
  })();

export const adjustResultScore = (db, { resultId, newScore, reason }, now) =>
  db.transaction(() => {
    const result = db
      .prepare(
        `SELECT r.*, p.frozen AS pigeon_frozen, race.status AS race_status
         FROM results r JOIN pigeons p ON p.id = r.pigeon_id JOIN races race ON race.id = r.race_id
         WHERE r.id = ?`
      )
      .get(resultId);
    if (!result) throw notFound("成绩不存在");
    const scoreNum = Number(newScore);
    if (!Number.isFinite(scoreNum) || scoreNum < 0) throw badRequest("分速必须是不小于 0 的数字");
    if (result.race_status !== "published") {
      db.prepare("UPDATE results SET score = ?, updated_at = ? WHERE id = ?").run(scoreNum, nowIso(now), resultId);
      return { resultId, adjusted: "draft" };
    }
    if (result.pigeon_frozen) throw conflict("score_locked", "该鸽申诉已受理，成绩已冻结，须通过改判调整");
    const ts = nowIso(now);
    db.prepare("UPDATE results SET score = ?, updated_at = ? WHERE id = ?").run(scoreNum, ts, resultId);
    const changes = recalcRanks(
      db,
      result.race_id,
      { reason: reason?.trim() || "manual_adjust", scoreChanges: new Map([[resultId, { oldScore: result.score, newScore: scoreNum }]]) },
      now
    );
    return { resultId, adjusted: "published", rankChanges: changes };
  })();

export function getStandings(db, raceId) {
  const race = db.prepare("SELECT * FROM races WHERE id = ?").get(raceId);
  if (!race) throw notFound("赛事不存在");
  const results = db
    .prepare(
      `SELECT r.id AS result_id, r.score, r.rank, r.original_rank, p.ring_no, p.frozen,
              u.display_name AS owner_name, a.id AS appeal_id, a.status AS appeal_status
       FROM results r
       JOIN pigeons p ON p.id = r.pigeon_id
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN appeals a ON a.result_id = r.id
       WHERE r.race_id = ?
       ORDER BY CASE WHEN r.rank IS NULL THEN 1 ELSE 0 END, r.rank ASC, r.id ASC`
    )
    .all(raceId);
  const history = db
    .prepare(
      `SELECT h.*, p.ring_no, a.id AS appeal_ref
       FROM ranking_history h JOIN pigeons p ON p.id = h.pigeon_id LEFT JOIN appeals a ON a.id = h.appeal_id
       WHERE h.race_id = ? ORDER BY h.id DESC`
    )
    .all(raceId);
  return { race, results, history };
}

export function listMyResults(db, ownerId) {
  return db
    .prepare(
      `SELECT r.id AS result_id, r.score, r.rank, r.original_rank, p.ring_no, p.frozen,
              race.id AS race_id, race.name AS race_name, race.status AS race_status,
              race.published_at, race.appeal_deadline,
              a.id AS appeal_id, a.status AS appeal_status
       FROM results r
       JOIN pigeons p ON p.id = r.pigeon_id
       JOIN races race ON race.id = r.race_id
       LEFT JOIN appeals a ON a.result_id = r.id
       WHERE p.owner_id = ?
       ORDER BY race.id DESC, r.rank ASC`
    )
    .all(ownerId);
}

// ---------------------------------------------------------------------------
// 申诉
// ---------------------------------------------------------------------------
function getAppeal(db, appealId) {
  return db.prepare("SELECT * FROM appeals WHERE id = ?").get(appealId);
}

function insertEvent(db, { appealId, actorId, action, fromStatus, toStatus, note }, now) {
  db.prepare(
    "INSERT INTO appeal_events (appeal_id, actor_id, action, from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(appealId, actorId ?? null, action, fromStatus ?? null, toStatus ?? null, note?.trim() || "", nowIso(now));
}

/**
 * 状态迁移：带 status+version 条件更新，并发下只有一方能改写成功，
 * 失败方 changes=0 → concurrent_modification，不会产生半条状态记录。
 */
function transitionAppeal(db, appeal, action, { actorId, note, supplementDeadline, decided }, now) {
  const spec = TRANSITIONS[action];
  if (!spec) throw badRequest(`未知操作 ${action}`);
  if (TERMINAL_STATUSES.includes(appeal.status)) {
    throw conflict("appeal_closed", `申诉已终结（${STATUS_LABELS[appeal.status]}），不能再操作`);
  }
  if (!spec.from.includes(appeal.status)) {
    throw conflict("invalid_state", `当前状态为「${STATUS_LABELS[appeal.status]}」，不允许该操作`);
  }
  const ts = nowIso(now);
  const result = db
    .prepare(
      `UPDATE appeals
       SET status = ?, version = version + 1, updated_at = ?,
           supplement_deadline = ?, decided_by = ?, decided_at = ?
       WHERE id = ? AND status = ? AND version = ?`
    )
    .run(
      spec.to,
      ts,
      supplementDeadline ?? appeal.supplement_deadline ?? null,
      decided ? actorId : appeal.decided_by ?? null,
      decided ? ts : appeal.decided_at ?? null,
      appeal.id,
      appeal.status,
      appeal.version
    );
  if (result.changes === 0) throw conflict("concurrent_modification", "该申诉刚被其他人处理，请刷新后重试");
  insertEvent(db, { appealId: appeal.id, actorId, action, fromStatus: appeal.status, toStatus: spec.to, note }, now);
  return spec.to;
}

/** 冻结标志 = 是否存在「已受理」的申诉；受理置 1，终态解除。 */
function refreshPigeonFreeze(db, pigeonId) {
  db.prepare(
    `UPDATE pigeons
     SET frozen = EXISTS(SELECT 1 FROM appeals WHERE pigeon_id = ? AND status = 'ACCEPTED')
     WHERE id = ?`
  ).run(pigeonId, pigeonId);
}

export const submitAppeal = (db, { resultId, ownerId, reason, evidence }, now) =>
  db.transaction(() => {
    const result = db
      .prepare(
        `SELECT r.*, race.status AS race_status, race.appeal_deadline, race.name AS race_name, p.owner_id AS pigeon_owner
         FROM results r
         JOIN races race ON race.id = r.race_id
         JOIN pigeons p ON p.id = r.pigeon_id
         WHERE r.id = ?`
      )
      .get(resultId);
    if (!result) throw notFound("成绩不存在，无法申诉");
    if (result.race_status !== "published") throw conflict("race_not_published", "该赛事成绩尚未公布，不能申诉");
    const ts = nowIso(now);
    if (isAfter(ts, result.appeal_deadline)) throw conflict("appeal_window_closed", "已过申诉期，无法提交申诉");
    if (result.pigeon_owner !== ownerId) throw forbidden("只能申诉归属自己鸽只的成绩");
    if (!reason?.trim()) throw badRequest("请填写申诉理由");
    if (!evidence?.trim()) throw badRequest("请提交证据材料");
    const existing = db.prepare("SELECT id FROM appeals WHERE result_id = ?").get(resultId);
    if (existing) throw conflict("duplicate_appeal", "该成绩已提交过申诉，不能重复申诉");
    let appealId;
    try {
      const info = db
        .prepare(
          `INSERT INTO appeals (result_id, race_id, pigeon_id, owner_id, reason, status, version, created_at, updated_at)
           VALUES (?,?,?,?,?, 'PENDING', 1, ?, ?)`
        )
        .run(resultId, result.race_id, result.pigeon_id, ownerId, reason.trim(), ts, ts);
      appealId = info.lastInsertRowid;
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw conflict("duplicate_appeal", "该成绩已提交过申诉，不能重复申诉");
      throw error;
    }
    db.prepare("INSERT INTO appeal_evidences (appeal_id, owner_id, kind, content, created_at) VALUES (?,?, 'initial', ?, ?)").run(
      appealId,
      ownerId,
      evidence.trim(),
      ts
    );
    insertEvent(db, { appealId, actorId: ownerId, action: "submit", fromStatus: null, toStatus: "PENDING", note: reason }, now);
    return { appealId };
  })();

export function listAppeals(db, user, { status } = {}) {
  const where = [];
  const params = {};
  if (user.role === "owner") {
    where.push("a.owner_id = @ownerId");
    params.ownerId = user.id;
  }
  if (status) {
    where.push("a.status = @status");
    params.status = status;
  }
  return db
    .prepare(
      `SELECT a.*, p.ring_no, p.frozen AS pigeon_frozen, u.display_name AS owner_name,
              race.name AS race_name, r.score, r.rank, r.original_rank
       FROM appeals a
       JOIN pigeons p ON p.id = a.pigeon_id
       JOIN users u ON u.id = a.owner_id
       JOIN races race ON race.id = a.race_id
       JOIN results r ON r.id = a.result_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY CASE a.status WHEN 'PENDING' THEN 0 WHEN 'SUPPLEMENT_REQUIRED' THEN 1 WHEN 'ACCEPTED' THEN 2 ELSE 3 END, a.id DESC`
    )
    .all(params);
}

export function getAppealDetail(db, user, appealId) {
  const appeal = db
    .prepare(
      `SELECT a.*, p.ring_no, p.frozen AS pigeon_frozen, u.display_name AS owner_name, u.username AS owner_username,
              race.name AS race_name, race.appeal_deadline AS race_appeal_deadline,
              r.score, r.rank, r.original_rank, decider.display_name AS decided_by_name
       FROM appeals a
       JOIN pigeons p ON p.id = a.pigeon_id
       JOIN users u ON u.id = a.owner_id
       JOIN races race ON race.id = a.race_id
       JOIN results r ON r.id = a.result_id
       LEFT JOIN users decider ON decider.id = a.decided_by
       WHERE a.id = ?`
    )
    .get(appealId);
  if (!appeal) throw notFound("申诉不存在");
  if (user.role === "owner" && appeal.owner_id !== user.id) throw forbidden("只能查看自己的申诉");
  const evidences = db
    .prepare(
      `SELECT e.*, u.display_name AS owner_name FROM appeal_evidences e JOIN users u ON u.id = e.owner_id
       WHERE e.appeal_id = ? ORDER BY e.id`
    )
    .all(appealId);
  const events = db
    .prepare(
      `SELECT ev.*, u.display_name AS actor_name, u.role AS actor_role
       FROM appeal_events ev LEFT JOIN users u ON u.id = ev.actor_id
       WHERE ev.appeal_id = ? ORDER BY ev.id`
    )
    .all(appealId);
  return { appeal, evidences, events };
}

export const acceptAppeal = (db, { appealId, reviewerId, note, _injectFault }, now) =>
  db.transaction(() => {
    const appeal = getAppeal(db, appealId);
    if (!appeal) throw notFound("申诉不存在");
    transitionAppeal(db, appeal, "accept", { actorId: reviewerId, note }, now);
    refreshPigeonFreeze(db, appeal.pigeon_id);
    if (_injectFault === "after_freeze") throw new Error("injected fault after freeze");
    return { appealId, status: "ACCEPTED" };
  })();

export const requestSupplement = (db, { appealId, reviewerId, note, deadlineMinutes }, now) =>
  db.transaction(() => {
    const appeal = getAppeal(db, appealId);
    if (!appeal) throw notFound("申诉不存在");
    const minutes = Number(deadlineMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw badRequest("补证期限必须大于 0 分钟");
    if (!note?.trim()) throw badRequest("请说明需要补充的证据");
    const ts = nowIso(now);
    const deadline = addMinutes(ts, minutes);
    transitionAppeal(db, appeal, "request_supplement", { actorId: reviewerId, note, supplementDeadline: deadline }, now);
    return { appealId, status: "SUPPLEMENT_REQUIRED", supplementDeadline: deadline };
  })();

export const submitSupplement = (db, { appealId, ownerId, evidence }, now) =>
  db.transaction(() => {
    const appeal = getAppeal(db, appealId);
    if (!appeal) throw notFound("申诉不存在");
    if (appeal.owner_id !== ownerId) throw forbidden("只能补充自己的申诉");
    if (!evidence?.trim()) throw badRequest("请填写补充证据内容");
    const ts = nowIso(now);
    if (appeal.status === "SUPPLEMENT_REQUIRED" && appeal.supplement_deadline && isAfter(ts, appeal.supplement_deadline)) {
      throw conflict("supplement_overdue", "已超过补证期限，补证被拒绝");
    }
    transitionAppeal(db, appeal, "supplement", { actorId: ownerId, note: "鸽主补充证据" }, now);
    db.prepare("INSERT INTO appeal_evidences (appeal_id, owner_id, kind, content, created_at) VALUES (?,?, 'supplement', ?, ?)").run(
      appealId,
      ownerId,
      evidence.trim(),
      ts
    );
    return { appealId, status: "PENDING" };
  })();

export const rejectAppeal = (db, { appealId, reviewerId, note }, now) =>
  db.transaction(() => {
    const appeal = getAppeal(db, appealId);
    if (!appeal) throw notFound("申诉不存在");
    if (!note?.trim()) throw badRequest("驳回必须填写理由");
    transitionAppeal(db, appeal, "reject", { actorId: reviewerId, note, decided: true }, now);
    refreshPigeonFreeze(db, appeal.pigeon_id);
    return { appealId, status: "REJECTED" };
  })();

export const rejudgeAppeal = (db, { appealId, reviewerId, newScore, note, _injectFault }, now) =>
  db.transaction(() => {
    const appeal = getAppeal(db, appealId);
    if (!appeal) throw notFound("申诉不存在");
    const scoreNum = Number(newScore);
    if (!Number.isFinite(scoreNum) || scoreNum < 0) throw badRequest("改判分速必须是不小于 0 的数字");
    if (!note?.trim()) throw badRequest("改判必须填写理由");
    transitionAppeal(db, appeal, "rejudge", { actorId: reviewerId, note, decided: true }, now);
    if (_injectFault === "after_status") throw new Error("injected fault after status update");
    const result = db.prepare("SELECT * FROM results WHERE id = ?").get(appeal.result_id);
    const ts = nowIso(now);
    db.prepare("UPDATE results SET score = ?, updated_at = ? WHERE id = ?").run(scoreNum, ts, result.id);
    if (_injectFault === "after_score") throw new Error("injected fault after score update");
    const rankChanges = recalcRanks(
      db,
      appeal.race_id,
      {
        appealId: appeal.id,
        reason: "rejudge",
        scoreChanges: new Map([[result.id, { oldScore: result.score, newScore: scoreNum }]]),
      },
      now
    );
    refreshPigeonFreeze(db, appeal.pigeon_id);
    return { appealId, status: "REJUDGED", rankChanges };
  })();

export { STATUS_LABELS, TERMINAL_STATUSES };
