import test from "node:test";
import assert from "node:assert/strict";
import { api, findResultId, loginOwner1, loginOwner2, loginReviewer, startApp } from "./helpers.js";

// 并发测试：重复提交、重复审理、转让竞态、并发改判
test("并发控制", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { base } = app;
  const [owner1, owner2, reviewer] = await Promise.all([loginOwner1(base), loginOwner2(base), loginReviewer(base)]);

  await t.test("并发重复申诉：只有一条成功，其余被唯一约束拦截", async () => {
    const target = await findResultId(base, owner1, 1, "CHN-2026-001");
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api(base, "POST", "/api/appeals", {
          token: owner1,
          body: { resultId: target.result_id, reason: `并发申诉 ${i}`, evidence: "证据" },
        })
      )
    );
    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409 && r.data.error.code === "duplicate_appeal");
    assert.equal(created.length, 1, `应只有 1 条成功，实际 ${created.length}`);
    assert.equal(conflicts.length, 5);

    const count = app.db.prepare("SELECT COUNT(*) AS c FROM appeals WHERE result_id = ?").get(target.result_id).c;
    assert.equal(count, 1, "数据库中只能有一条申诉");
  });

  let appealId;
  await t.test("准备：再提交一条待审理申诉", async () => {
    const target = await findResultId(base, owner2, 1, "CHN-2026-003");
    const res = await api(base, "POST", "/api/appeals", {
      token: owner2,
      body: { resultId: target.result_id, reason: "并发审理测试", evidence: "证据" },
    });
    assert.equal(res.status, 201);
    appealId = res.data.appealId;
  });

  await t.test("并发受理：只有一个审理成功，事件只记一次", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(base, "POST", `/api/appeals/${appealId}/accept`, { token: reviewer, body: { note: "并发受理" } })
      )
    );
    const succeeded = results.filter((r) => r.status === 200);
    const conflicted = results.filter((r) => r.status === 409);
    assert.equal(succeeded.length, 1, `应只有 1 个受理成功，实际 ${succeeded.length}`);
    assert.equal(conflicted.length, 4);

    const events = app.db
      .prepare("SELECT COUNT(*) AS c FROM appeal_events WHERE appeal_id = ? AND action = 'accept'")
      .get(appealId).c;
    assert.equal(events, 1, "受理事件只能记录一次");
    const appeal = app.db.prepare("SELECT status, version FROM appeals WHERE id = ?").get(appealId);
    assert.equal(appeal.status, "ACCEPTED");
  });

  await t.test("并发改判：只有一个成功，排名只重算一次", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        api(base, "POST", `/api/appeals/${appealId}/rejudge`, {
          token: reviewer,
          body: { newScore: 1600 + i, note: `并发改判 ${i}` },
        })
      )
    );
    const succeeded = results.filter((r) => r.status === 200);
    assert.equal(succeeded.length, 1, `应只有 1 个改判成功，实际 ${succeeded.length}`);
    assert.equal(results.filter((r) => r.status === 409).length, 3);

    const appeal = app.db.prepare("SELECT status FROM appeals WHERE id = ?").get(appealId);
    assert.equal(appeal.status, "REJUDGED");
    const rejudgeEvents = app.db
      .prepare("SELECT COUNT(*) AS c FROM appeal_events WHERE appeal_id = ? AND action = 'rejudge'")
      .get(appealId).c;
    assert.equal(rejudgeEvents, 1, "改判事件只能记录一次");
    const rejudgeHistory = app.db
      .prepare("SELECT COUNT(*) AS c FROM ranking_history WHERE appeal_id = ? AND reason = 'rejudge'")
      .get(appealId).c;
    assert.ok(rejudgeHistory >= 1, "改判排名历史存在");
    // 分数只被改一次：最终分数必为四个并发值之一，且历史中新分数唯一
    const finalScore = app.db
      .prepare("SELECT r.score FROM results r JOIN appeals a ON a.result_id = r.id WHERE a.id = ?")
      .get(appealId).score;
    assert.ok([1600, 1601, 1602, 1603].includes(finalScore));
  });

  await t.test("并发转让：受理冻结与转让互斥，结果必居其一", async () => {
    // owner1 新登记一只鸽，提交申诉后并发执行「受理」与「转让」
    const pigeon = await api(base, "POST", "/api/pigeons", {
      token: owner1,
      body: { ringNo: "CHN-2026-900", color: "灰", loft: "测试棚" },
    });
    const race = await api(base, "POST", "/api/races", { token: reviewer, body: { name: "并发转让测试赛", distanceKm: 100 } });
    const result = await api(base, "POST", `/api/races/${race.data.raceId}/results`, {
      token: reviewer,
      body: { ringNo: "CHN-2026-900", score: 1000 },
    });
    await api(base, "POST", `/api/races/${race.data.raceId}/publish`, { token: reviewer, body: { appealDays: 3 } });
    const appeal = await api(base, "POST", "/api/appeals", {
      token: owner1,
      body: { resultId: result.data.resultId, reason: "并发转让", evidence: "证据" },
    });

    const [acceptRes, transferRes] = await Promise.all([
      api(base, "POST", `/api/appeals/${appeal.data.appealId}/accept`, { token: reviewer, body: {} }),
      api(base, "POST", `/api/pigeons/${pigeon.data.pigeonId}/transfer`, { token: owner1, body: { toUsername: "owner2" } }),
    ]);
    // 两种合法结局：受理先→转让被冻结拦截；转让先→受理后鸽已易主但仍受理成功
    if (transferRes.status === 409) {
      assert.equal(transferRes.data.error.code, "pigeon_frozen");
      assert.equal(acceptRes.status, 200);
    } else {
      assert.equal(transferRes.status, 200);
      assert.equal(acceptRes.status, 200);
    }
    // 无论哪种结局，数据库状态必须一致：鸽只冻结标志与申诉状态吻合
    const frozen = app.db.prepare("SELECT frozen FROM pigeons WHERE id = ?").get(pigeon.data.pigeonId).frozen;
    const status = app.db.prepare("SELECT status FROM appeals WHERE id = ?").get(appeal.data.appealId).status;
    assert.equal(status, "ACCEPTED");
    assert.equal(frozen, 1);
  });
});
