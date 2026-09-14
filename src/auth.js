import crypto from "node:crypto";
import { nowIso } from "./util.js";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function createSession(db, userId, now) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)").run(token, userId, nowIso(now));
  return token;
}

export function getSessionUser(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  return row || null;
}
