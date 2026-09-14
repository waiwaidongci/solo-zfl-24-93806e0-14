import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

/** 启动一个使用临时数据库的应用实例，返回 base URL 与关闭函数。 */
export async function startApp() {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-test-"));
  const dbPath = join(dir, "test.db");
  const app = createApp({ dbPath });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    db: app.db,
    dbPath,
    async close() {
      await new Promise((resolve) => app.server.close(resolve));
      app.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function api(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function login(base, username, password) {
  const { status, data } = await api(base, "POST", "/api/login", { body: { username, password } });
  if (status !== 200) throw new Error(`登录失败: ${username} -> ${status}`);
  return data.token;
}

export const loginOwner1 = (base) => login(base, "owner1", "owner123");
export const loginOwner2 = (base) => login(base, "owner2", "owner123");
export const loginReviewer = (base) => login(base, "reviewer", "review123");

/** 从 owner 视角取某场赛事某足环的成绩 id。 */
export async function findResultId(base, token, raceId, ringNo) {
  const { data } = await api(base, "GET", "/api/my/results", { token });
  const row = data.results.find((r) => r.race_id === raceId && r.ring_no === ringNo);
  if (!row) throw new Error(`成绩不存在: race=${raceId} ring=${ringNo}`);
  return row;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
