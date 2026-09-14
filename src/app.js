import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { seedIfEmpty, migrateDisplayNames } from "./seed.js";
import { ApiError, badRequest, forbidden, unauthorized } from "./errors.js";
import { createSession, getSessionUser, verifyPassword } from "./auth.js";
import * as svc from "./services.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

/** 把 /api/appeals/:id/accept 形式的路由编译成正则。 */
function compile(pattern) {
  const keys = [];
  const regex = pattern.replace(/:[^/]+/g, (match) => {
    keys.push(match.slice(1));
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${regex}$`), keys };
}

const routes = [];
function route(method, pattern, { roles = null, auth = false, status = 200 }, handler) {
  routes.push({ method, ...compile(pattern), roles, auth, status, handler });
}

// ---------------- 认证 ----------------
route("POST", "/api/login", {}, async ({ db, body }) => {
  const { username, password } = body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim());
  if (!user || !verifyPassword(password ?? "", user.password_hash)) throw unauthorized("用户名或密码错误");
  const token = createSession(db, user.id);
  return { token, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role } };
});

route("POST", "/api/logout", { auth: true }, async ({ db, req }) => {
  const token = (req.headers.authorization || "").slice(7);
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  return { ok: true };
});

route("GET", "/api/me", { auth: true }, async ({ user }) => ({
  user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
}));

// ---------------- 鸽只与转让 ----------------
route("GET", "/api/pigeons", { auth: true }, async ({ db, user }) => ({ pigeons: svc.listPigeons(db, user) }));

route("POST", "/api/pigeons", { roles: ["owner"], status: 201 }, async ({ db, body, user }) => ({
  pigeonId: svc.createPigeon(db, { ringNo: body.ringNo, color: body.color, loft: body.loft, ownerId: user.id }),
}));

route("GET", "/api/pigeons/:id/transfers", { auth: true }, async ({ db, params, user }) => {
  const pigeon = db.prepare("SELECT * FROM pigeons WHERE id = ?").get(Number(params.id));
  if (!pigeon) throw new ApiError(404, "not_found", "鸽只不存在");
  if (user.role === "owner" && pigeon.owner_id !== user.id) throw forbidden("只能查看自己的鸽只");
  return { transfers: svc.listTransfers(db, pigeon.id) };
});

route("POST", "/api/pigeons/:id/transfer", { roles: ["owner"] }, async ({ db, body, params, user }) =>
  svc.transferPigeon(db, { pigeonId: Number(params.id), toUsername: body.toUsername, actorId: user.id })
);

// ---------------- 赛事与成绩 ----------------
route("GET", "/api/races", { auth: true }, async ({ db }) => ({ races: svc.listRaces(db) }));

route("POST", "/api/races", { roles: ["reviewer"], status: 201 }, async ({ db, body }) => ({
  raceId: svc.createRace(db, { name: body.name, distanceKm: body.distanceKm }),
}));

route("POST", "/api/races/:id/results", { roles: ["reviewer"], status: 201 }, async ({ db, body, params }) => ({
  resultId: svc.addResult(db, { raceId: Number(params.id), ringNo: body.ringNo, score: body.score }),
}));

route("POST", "/api/races/:id/publish", { roles: ["reviewer"] }, async ({ db, body, params }) =>
  svc.publishRace(db, { raceId: Number(params.id), appealDays: body.appealDays })
);

route("GET", "/api/races/:id/standings", { auth: true }, async ({ db, params }) =>
  svc.getStandings(db, Number(params.id))
);

route("PATCH", "/api/results/:id", { roles: ["reviewer"] }, async ({ db, body, params }) =>
  svc.adjustResultScore(db, { resultId: Number(params.id), newScore: body.score, reason: body.reason })
);

route("GET", "/api/my/results", { roles: ["owner"] }, async ({ db, user }) => ({
  results: svc.listMyResults(db, user.id),
}));

// ---------------- 申诉 ----------------
route("POST", "/api/appeals", { roles: ["owner"], status: 201 }, async ({ db, body, user }) =>
  svc.submitAppeal(db, { resultId: Number(body.resultId), ownerId: user.id, reason: body.reason, evidence: body.evidence })
);

route("GET", "/api/appeals", { auth: true }, async ({ db, user, query }) => ({
  appeals: svc.listAppeals(db, user, { status: query.get("status") || undefined }),
}));

route("GET", "/api/appeals/:id", { auth: true }, async ({ db, user, params }) =>
  svc.getAppealDetail(db, user, Number(params.id))
);

route("POST", "/api/appeals/:id/accept", { roles: ["reviewer"] }, async ({ db, body, params, user }) =>
  svc.acceptAppeal(db, { appealId: Number(params.id), reviewerId: user.id, note: body.note })
);

route("POST", "/api/appeals/:id/request-supplement", { roles: ["reviewer"] }, async ({ db, body, params, user }) =>
  svc.requestSupplement(db, {
    appealId: Number(params.id),
    reviewerId: user.id,
    note: body.note,
    deadlineMinutes: body.deadlineMinutes,
  })
);

route("POST", "/api/appeals/:id/supplement", { roles: ["owner"] }, async ({ db, body, params, user }) =>
  svc.submitSupplement(db, { appealId: Number(params.id), ownerId: user.id, evidence: body.evidence })
);

route("POST", "/api/appeals/:id/reject", { roles: ["reviewer"] }, async ({ db, body, params, user }) =>
  svc.rejectAppeal(db, { appealId: Number(params.id), reviewerId: user.id, note: body.note })
);

route("POST", "/api/appeals/:id/rejudge", { roles: ["reviewer"] }, async ({ db, body, params, user }) =>
  svc.rejudgeAppeal(db, { appealId: Number(params.id), reviewerId: user.id, newScore: body.newScore, note: body.note })
);

// ---------------- 应用装配 ----------------
export function createApp({ dbPath }) {
  const db = openDb(dbPath);
  seedIfEmpty(db);
  migrateDisplayNames(db);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && STATIC_FILES[url.pathname]) {
        const [file, contentType] = STATIC_FILES[url.pathname];
        const content = await readFile(join(publicDir, normalize(file)));
        res.writeHead(200, { "Content-Type": contentType });
        return res.end(content);
      }

      const matched = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
      if (!matched) throw new ApiError(404, "not_found", "接口不存在");

      const params = {};
      const values = url.pathname.match(matched.regex).slice(1);
      matched.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(values[i]);
      });

      let user = null;
      {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;
        user = getSessionUser(db, token);
        if (matched.roles || matched.auth) {
          if (!user) throw unauthorized();
          if (matched.roles && !matched.roles.includes(user.role)) throw forbidden("当前角色无权执行此操作");
        }
      }

      const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : {};
      const result = await matched.handler({ db, req, res, params, query: url.searchParams, body, user });
      sendJson(res, matched.status, result ?? { ok: true });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      } else {
        console.error("[server error]", error);
        sendJson(res, 500, { error: { code: "internal_error", message: "服务器内部错误" } });
      }
    }
  });

  return {
    server,
    db,
    close() {
      server.close();
      db.close();
    },
  };
}
