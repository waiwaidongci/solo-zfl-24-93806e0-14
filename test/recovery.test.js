import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { api, findResultId, loginOwner1, loginReviewer, startApp } from "./helpers.js";
import { acceptAppeal, rejudgeAppeal, submitAppeal } from "../src/services.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

// 失败恢复：事务必须整体回滚，不留半条记录
test("失败恢复：注入故障后事务整体回滚", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { base, db } = app;
  const [owner1, reviewer] = [await loginOwner1(base), await loginReviewer(base)];

  const snapshot = () => ({
    appeals: db.prepare("SELECT * FROM appeals ORDER BY id").all(),
    events: db.prepare("SELECT * FROM appeal_events ORDER BY id").all(),
    results: db.prepare("SELECT id, score, rank, original_rank FROM results ORDER BY id").all(),
    history: db.prepare("SELECT * FROM ranking_history ORDER BY id").all(),
    pigeons: db.prepare("SELECT id, frozen FROM pigeons ORDER BY id").all(),
  });

  let appealId;
  await t.test("准备一条申诉", async () => {
    const target = await findResultId(base, owner1, 1, "CHN-2026-001");
    const res = await api(base, "POST", "/api/appeals", {
      token: owner1,
      body: { resultId: target.result_id, reason: "回滚测试", evidence: "证据" },
    });
    appealId = res.data.appealId;
  });

  await t.test("受理事务在冻结后失败：状态、冻结、事件全部回滚", async () => {
    const before = snapshot();
    const reviewerId = db.prepare("SELECT id FROM users WHERE username = 'reviewer'").get().id;
    assert.throws(
      () => acceptAppeal(db, { appealId, reviewerId, note: "x", _injectFault: "after_freeze" }),
      /injected fault/
    );
    assert.deepEqual(snapshot(), before, "受理失败后数据库必须保持原样");
    const appeal = db.prepare("SELECT status FROM appeals WHERE id = ?").get(appealId);
    assert.equal(appeal.status, "PENDING");
  });

  await t.test("改判事务在状态更新后失败：分数、排名、历史全部回滚", async () => {
    // 先正常受理
    const ok = await api(base, "POST", `/api/appeals/${appealId}/accept`, { token: reviewer, body: {} });
    assert.equal(ok.status, 200);
    const before = snapshot();
    const reviewerId = db.prepare("SELECT id FROM users WHERE username = 'reviewer'").get().id;

    assert.throws(
      () => rejudgeAppeal(db, { appealId, reviewerId, newScore: 1999, note: "x", _injectFault: "after_status" }),
      /injected fault/
    );
    assert.deepEqual(snapshot(), before, "after_status 故障后必须整体回滚");

    assert.throws(
      () => rejudgeAppeal(db, { appealId, reviewerId, newScore: 1999, note: "x", _injectFault: "after_score" }),
      /injected fault/
    );
    assert.deepEqual(snapshot(), before, "after_score 故障后必须整体回滚");

    const appeal = db.prepare("SELECT status FROM appeals WHERE id = ?").get(appealId);
    assert.equal(appeal.status, "ACCEPTED", "申诉应仍处于已受理");
    const score = db.prepare("SELECT r.score FROM results r JOIN appeals a ON a.result_id = r.id WHERE a.id = ?").get(appealId).score;
    assert.equal(score, 1520.5, "分数不得被改写");
  });

  await t.test("故障恢复后同一申诉可正常改判", async () => {
    const res = await api(base, "POST", `/api/appeals/${appealId}/rejudge`, {
      token: reviewer,
      body: { newScore: 1600, note: "恢复后改判" },
    });
    assert.equal(res.status, 200);
    const appeal = db.prepare("SELECT status FROM appeals WHERE id = ?").get(appealId);
    assert.equal(appeal.status, "REJUDGED");
  });
});

// 重启持久化：杀掉进程重起后数据仍可查询
test("服务重启后数据仍可查询", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-restart-"));
  const dbPath = join(dir, "restart.db");
  const port = 3400 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const start = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(rootDir, "server.js")], {
        env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("已启动")) resolve(child);
      });
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("exit", (code) => reject(new Error(`服务提前退出 code=${code}: ${out}`)));
      setTimeout(() => reject(new Error(`服务启动超时: ${out}`)), 8000);
    });

  const waitDown = (child) =>
    new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
    });

  // 第一次启动：登录、提交申诉
  let child = await start();
  const [owner1, reviewer] = [await loginOwner1(base), await loginReviewer(base)];
  const target = await findResultId(base, owner1, 1, "CHN-2026-002");
  const created = await api(base, "POST", "/api/appeals", {
    token: owner1,
    body: { resultId: target.result_id, reason: "重启持久化验证", evidence: "证据" },
  });
  assert.equal(created.status, 201);
  const appealId = created.data.appealId;
  await api(base, "POST", `/api/appeals/${appealId}/accept`, { token: reviewer, body: { note: "受理" } });
  await waitDown(child);

  // 第二次启动：同一数据库文件，数据必须还在
  child = await start();
  t.after(() => child.kill("SIGKILL"));
  const reviewer2 = await loginReviewer(base);
  const detail = await api(base, "GET", `/api/appeals/${appealId}`, { token: reviewer2 });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.appeal.status, "ACCEPTED");
  assert.equal(detail.data.appeal.reason, "重启持久化验证");
  assert.equal(detail.data.events.length, 2, "提交与受理两条事件都应保留");

  const standings = await api(base, "GET", "/api/races/1/standings", { token: reviewer2 });
  assert.equal(standings.data.results.length, 4, "成绩榜重启后完整");
  const pigeons = await api(base, "GET", "/api/pigeons", { token: reviewer2 });
  assert.equal(pigeons.data.pigeons.find((p) => p.ring_no === "CHN-2026-002").frozen, 1, "冻结状态重启后保留");
  await waitDown(child);
});
