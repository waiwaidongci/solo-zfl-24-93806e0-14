import test from "node:test";
import assert from "node:assert/strict";
import { api, findResultId, loginOwner1, loginOwner2, loginReviewer, sleep, startApp } from "./helpers.js";

// 业务规则测试：申诉窗口、归属校验、重复拦截、状态机、冻结、改判重排、追溯
test("成绩申诉复核业务规则", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { base } = app;
  const [owner1, owner2, reviewer] = await Promise.all([loginOwner1(base), loginOwner2(base), loginReviewer(base)]);

  // 种子数据：赛事一（id=1）申诉期内，赛事二（id=2）申诉期已过
  const ownResult = await findResultId(base, owner1, 1, "CHN-2026-002");
  const expiredResult = await findResultId(base, owner1, 2, "CHN-2026-002");

  await t.test("未登录访问被拒绝", async () => {
    const res = await api(base, "GET", "/api/appeals");
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, "unauthenticated");
  });

  await t.test("逾期申诉被拦截", async () => {
    const res = await api(base, "POST", "/api/appeals", {
      token: owner1,
      body: { resultId: expiredResult.result_id, reason: "过期", evidence: "证据" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, "appeal_window_closed");
  });

  await t.test("只能申诉归属自己的成绩", async () => {
    const res = await api(base, "POST", "/api/appeals", {
      token: owner2,
      body: { resultId: ownResult.result_id, reason: "别人的", evidence: "证据" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "forbidden");
  });

  await t.test("未公布赛事不能申诉", async () => {
    const race = await api(base, "POST", "/api/races", { token: reviewer, body: { name: "测试未公布赛", distanceKm: 100 } });
    const draft = await api(base, "POST", `/api/races/${race.data.raceId}/results`, {
      token: reviewer,
      body: { ringNo: "CHN-2026-001", score: 1200 },
    });
    const res = await api(base, "POST", "/api/appeals", {
      token: owner1,
      body: { resultId: draft.data.resultId, reason: "未公布", evidence: "证据" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, "race_not_published");
  });

  await t.test("缺少理由或证据被拦截", async () => {
    const res = await api(base, "POST", "/api/appeals", {
      token: owner1,
      body: { resultId: ownResult.result_id, reason: "", evidence: "证据" },
    });
    assert.equal(res.status, 400);
  });

  let appealId;
  await t.test("正常提交申诉", async () => {
    const res = await api(base, "POST", "/api/appeals", {
      token: owner1,
      body: { resultId: ownResult.result_id, reason: "鸽钟时间误录", evidence: "鸽钟导出记录" },
    });
    assert.equal(res.status, 201);
    appealId = res.data.appealId;
    assert.ok(appealId > 0);
  });

  await t.test("重复申诉被拦截", async () => {
    const res = await api(base, "POST", "/api/appeals", {
      token: owner1,
      body: { resultId: ownResult.result_id, reason: "再来一次", evidence: "证据" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, "duplicate_appeal");
  });

  await t.test("鸽主越权调用审理接口被拦截", async () => {
    for (const [path, body] of [
      [`/api/appeals/${appealId}/accept`, {}],
      [`/api/appeals/${appealId}/reject`, { note: "x" }],
      [`/api/appeals/${appealId}/rejudge`, { newScore: 1, note: "x" }],
      [`/api/appeals/${appealId}/request-supplement`, { note: "x", deadlineMinutes: 10 }],
    ]) {
      const res = await api(base, "POST", path, { token: owner1, body });
      assert.equal(res.status, 403, path);
      assert.equal(res.data.error.code, "forbidden");
    }
  });

  await t.test("审理人不能代替鸽主补证", async () => {
    const res = await api(base, "POST", `/api/appeals/${appealId}/supplement`, {
      token: reviewer,
      body: { evidence: "越权补证" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("受理后冻结转让与成绩修改", async () => {
    const accept = await api(base, "POST", `/api/appeals/${appealId}/accept`, { token: reviewer, body: { note: "受理" } });
    assert.equal(accept.status, 200);

    const pigeons = await api(base, "GET", "/api/pigeons", { token: owner1 });
    const frozen = pigeons.data.pigeons.find((p) => p.ring_no === "CHN-2026-002");
    assert.equal(frozen.frozen, 1);

    const transfer = await api(base, "POST", `/api/pigeons/${frozen.id}/transfer`, {
      token: owner1,
      body: { toUsername: "owner2" },
    });
    assert.equal(transfer.status, 409);
    assert.equal(transfer.data.error.code, "pigeon_frozen");

    const adjust = await api(base, "PATCH", `/api/results/${ownResult.result_id}`, {
      token: reviewer,
      body: { score: 1600, reason: "人工改分" },
    });
    assert.equal(adjust.status, 409);
    assert.equal(adjust.data.error.code, "score_locked");
  });

  await t.test("待受理状态不能改判", async () => {
    const other = await findResultId(base, owner2, 1, "CHN-2026-003");
    const created = await api(base, "POST", "/api/appeals", {
      token: owner2,
      body: { resultId: other.result_id, reason: "测试状态机", evidence: "证据" },
    });
    const res = await api(base, "POST", `/api/appeals/${created.data.appealId}/rejudge`, {
      token: reviewer,
      body: { newScore: 1500, note: "非法改判" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, "invalid_state");
    // 清理：驳回该申诉
    await api(base, "POST", `/api/appeals/${created.data.appealId}/reject`, { token: reviewer, body: { note: "清理" } });
  });

  await t.test("改判重算同场排名并保留原名次", async () => {
    const before = await api(base, "GET", "/api/races/1/standings", { token: reviewer });
    const beforeRanks = Object.fromEntries(before.data.results.map((r) => [r.ring_no, r.rank]));
    assert.deepEqual(beforeRanks, { "CHN-2026-001": 1, "CHN-2026-003": 2, "CHN-2026-002": 3, "CHN-2026-004": 4 });

    const rejudge = await api(base, "POST", `/api/appeals/${appealId}/rejudge`, {
      token: reviewer,
      body: { newScore: 1530.0, note: "鸽钟记录属实" },
    });
    assert.equal(rejudge.status, 200);

    const after = await api(base, "GET", "/api/races/1/standings", { token: reviewer });
    const ranks = Object.fromEntries(after.data.results.map((r) => [r.ring_no, r.rank]));
    assert.deepEqual(ranks, { "CHN-2026-002": 1, "CHN-2026-001": 2, "CHN-2026-003": 3, "CHN-2026-004": 4 });

    // 原名次保留
    const originals = Object.fromEntries(after.data.results.map((r) => [r.ring_no, r.original_rank]));
    assert.deepEqual(originals, { "CHN-2026-001": 1, "CHN-2026-003": 2, "CHN-2026-002": 3, "CHN-2026-004": 4 });

    // 排名调整记录可追溯：被改判鸽分数变化 + 两只鸽名次变化
    const rejudgeHistory = after.data.history.filter((h) => h.reason === "rejudge" && h.appeal_id === appealId);
    assert.ok(rejudgeHistory.length >= 2, `改判历史应至少 2 条，实际 ${rejudgeHistory.length}`);
    const appealed = rejudgeHistory.find((h) => h.ring_no === "CHN-2026-002");
    assert.equal(appealed.old_score, 1461);
    assert.equal(appealed.new_score, 1530);
    assert.equal(appealed.old_rank, 3);
    assert.equal(appealed.new_rank, 1);

    // 终结后解冻
    const pigeons = await api(base, "GET", "/api/pigeons", { token: owner1 });
    assert.equal(pigeons.data.pigeons.find((p) => p.ring_no === "CHN-2026-002").frozen, 0);
  });

  await t.test("终态后再操作被拦截", async () => {
    for (const [path, body] of [
      [`/api/appeals/${appealId}/accept`, {}],
      [`/api/appeals/${appealId}/reject`, { note: "x" }],
      [`/api/appeals/${appealId}/rejudge`, { newScore: 1, note: "x" }],
      [`/api/appeals/${appealId}/request-supplement`, { note: "x", deadlineMinutes: 10 }],
    ]) {
      const res = await api(base, "POST", path, { token: reviewer, body });
      assert.equal(res.status, 409, path);
      assert.equal(res.data.error.code, "appeal_closed");
    }
    const supplement = await api(base, "POST", `/api/appeals/${appealId}/supplement`, {
      token: owner1,
      body: { evidence: "终态补证" },
    });
    assert.equal(supplement.status, 409);
    assert.equal(supplement.data.error.code, "appeal_closed");
  });

  await t.test("申诉事件链完整可追溯", async () => {
    const detail = await api(base, "GET", `/api/appeals/${appealId}`, { token: owner1 });
    const actions = detail.data.events.map((e) => `${e.from_status ?? "-"}->${e.to_status}:${e.action}`);
    assert.deepEqual(actions, ["-->PENDING:submit", "PENDING->ACCEPTED:accept", "ACCEPTED->REJUDGED:rejudge"]);
    assert.equal(detail.data.appeal.decided_by_name, "王五（审理人）");
  });

  await t.test("补证流程：要求补证 → 期限内补证 → 驳回", async () => {
    const target = await findResultId(base, owner2, 1, "CHN-2026-004");
    const created = await api(base, "POST", "/api/appeals", {
      token: owner2,
      body: { resultId: target.result_id, reason: "串鸽疑点", evidence: "初始证据" },
    });
    const id = created.data.appealId;

    const req1 = await api(base, "POST", `/api/appeals/${id}/request-supplement`, {
      token: reviewer,
      body: { note: "补鸽钟原始数据", deadlineMinutes: 60 },
    });
    assert.equal(req1.data.status, "SUPPLEMENT_REQUIRED");

    const sup = await api(base, "POST", `/api/appeals/${id}/supplement`, {
      token: owner2,
      body: { evidence: "补充的鸽钟数据" },
    });
    assert.equal(sup.data.status, "PENDING");

    const detail = await api(base, "GET", `/api/appeals/${id}`, { token: owner2 });
    assert.equal(detail.data.evidences.length, 2);
    assert.equal(detail.data.evidences[1].kind, "supplement");

    const rej = await api(base, "POST", `/api/appeals/${id}/reject`, { token: reviewer, body: { note: "证据不足" } });
    assert.equal(rej.data.status, "REJECTED");
  });

  await t.test("超期补证被拒绝", async () => {
    // 用新赛事构造一个申诉，避免与已有申诉冲突
    const race = await api(base, "POST", "/api/races", { token: reviewer, body: { name: "补证超期测试赛", distanceKm: 150 } });
    const created = await api(base, "POST", `/api/races/${race.data.raceId}/results`, {
      token: reviewer,
      body: { ringNo: "CHN-2026-001", score: 1100 },
    });
    await api(base, "POST", `/api/races/${race.data.raceId}/publish`, { token: reviewer, body: { appealDays: 3 } });
    const appeal = await api(base, "POST", "/api/appeals", {
      token: owner1,
      body: { resultId: created.data.resultId, reason: "测试超期", evidence: "证据" },
    });
    const id = appeal.data.appealId;
    await api(base, "POST", `/api/appeals/${id}/request-supplement`, {
      token: reviewer,
      body: { note: "限 0.6 秒内补证", deadlineMinutes: 0.01 },
    });
    await sleep(1200);
    const res = await api(base, "POST", `/api/appeals/${id}/supplement`, { token: owner1, body: { evidence: "迟到" } });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, "supplement_overdue");
  });

  await t.test("他人不能查看/补充我的申诉", async () => {
    const detail = await api(base, "GET", `/api/appeals/${appealId}`, { token: owner2 });
    assert.equal(detail.status, 403);
  });
});
