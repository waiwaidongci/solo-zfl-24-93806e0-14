/* 真实浏览器走查：桌面与窄屏两种宽度下，用页面操作走通
   登录 → 提交申诉 → 受理 → 改判 → 成绩榜，并断言：
   - 任意视图不产生横向溢出（scrollWidth ≤ innerWidth）
   - 身份栏名称与角色各出现一次
   - 窄屏下成绩榜表格卡片化、每行字段带列名标注
   运行：node scripts/browser-walkthrough.mjs */
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLE_LABEL = { owner: "鸽主", reviewer: "审理人" };

let passed = 0;
let failed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✔ ${msg}`); };
const bad = (msg) => { failed += 1; console.log(`  ✘ ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-browser-"));
  const app = createApp({ dbPath: join(dir, "browser.db") });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, close: () => { app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return Math.max(de.scrollWidth, document.body.scrollWidth) - window.innerWidth;
  });
  check(overflow <= 0, `${label}：无横向溢出（超出 ${Math.max(0, overflow)}px）`);
}

async function assertIdentity(page, name, role) {
  const text = (await page.textContent("#whoami")).trim();
  const roleCount = text.split(ROLE_LABEL[role]).length - 1;
  const nameCount = text.split(name).length - 1;
  check(nameCount === 1 && roleCount === 1, `身份栏「${text}」名称与角色各出现一次`);
}

async function login(page, base, username, password) {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="username"]', username);
  await page.fill('#login-form input[name="password"]', password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#tabs button");
}

async function logout(page) {
  await page.click("#logout");
  await page.waitForSelector("#login-form");
}

/** 鸽主提交申诉 → 审理人受理 → 改判 → 成绩榜验证。返回是否全部成功。 */
async function runReviewFlow(page, base, { width, owner, ownerPass, ownerName, ringNo, newScore, expectRank, raceName }) {
  console.log(`\n== ${width} 宽度：${ownerName} 申诉 ${ringNo} 全流程 ==`);
  await login(page, base, owner, ownerPass);
  await assertIdentity(page, ownerName, "owner");
  await assertNoOverflow(page, "登录后-我的成绩");

  // 提交申诉
  await page.click(`tr:has-text("${ringNo}") button[data-new-appeal]`);
  await page.fill('#appeal-form textarea[name="reason"]', "鸽钟回传时间误录，申请复核");
  await page.fill('#appeal-form textarea[name="evidence"]', "鸽钟导出记录与足环扫描照片");
  await page.click('#appeal-form button[type="submit"]');
  await page.waitForSelector(".banner.success");
  ok("提交申诉成功（页面提示）");
  await assertNoOverflow(page, "提交申诉后");

  await logout(page);

  // 审理人受理
  await login(page, base, "reviewer", "review123");
  await assertIdentity(page, "王五", "reviewer");
  await assertNoOverflow(page, "登录后-申诉处理");
  const appealId = await page.locator("[data-open]").first().getAttribute("data-open");
  await page.click(`[data-open="${appealId}"]`);
  await page.fill(`[data-case="${appealId}"] textarea[name="note"]`, "证据成立，受理复核");
  await page.click(`[data-case="${appealId}"] button[data-act="accept"]`);
  await page.waitForSelector(".banner.success");
  ok("受理成功（页面提示）");

  // 改判
  await page.click(`[data-open="${appealId}"]`);
  await page.fill(`[data-case="${appealId}"] textarea[name="note"]`, "鸽钟记录属实，更正分速");
  await page.fill(`[data-case="${appealId}"] input[name="newScore"]`, String(newScore));
  await page.click(`[data-case="${appealId}"] button[data-act="rejudge"]`);
  await page.waitForSelector(".banner.success");
  ok("改判成功（页面提示）");
  await assertNoOverflow(page, "改判后-申诉处理");

  // 成绩榜验证排名（显式切换到被改判的赛事）
  await page.click('#tabs button:has-text("赛事成绩榜")');
  await page.waitForSelector("#standings-slot table");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/standings") && r.status() === 200),
    page.selectOption("#race-select", { label: `${raceName}（已公布）` }),
  ]);
  const firstRow = await page.locator("#standings-slot table tbody tr").first().textContent();
  check(firstRow.includes(ringNo) && firstRow.includes(`第${expectRank}名`), `成绩榜第 1 名为 ${ringNo}（第${expectRank}名）`);
  const historyText = await page.locator("#standings-slot").textContent();
  check(historyText.includes("改判重排"), "名次调整记录包含「改判重排」");
  await assertNoOverflow(page, "成绩榜");
  await logout(page);
}

async function main() {
  const { base, close } = await startServer();
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    // ---------- 桌面 1280px ----------
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await runReviewFlow(desktop, base, {
      width: "桌面 1280px",
      owner: "owner1", ownerPass: "owner123", ownerName: "张三",
      ringNo: "CHN-2026-002", newScore: 1530.0, expectRank: 1,
      raceName: "2026秋季300公里大奖赛",
    });
    // 桌面端表格保持表格布局
    await login(desktop, base, "owner1", "owner123");
    await desktop.click('#tabs button:has-text("赛事成绩榜")');
    await desktop.waitForSelector("#standings-slot table");
    const desktopDisplay = await desktop.evaluate(() => getComputedStyle(document.querySelector("#standings-slot table")).display);
    check(desktopDisplay === "table", `桌面端成绩榜保持表格布局（display=${desktopDisplay}）`);
    await assertNoOverflow(desktop, "桌面-成绩榜");
    await desktop.close();

    // ---------- 窄屏 375px ----------
    const mobile = await browser.newPage({ viewport: { width: 375, height: 700 } });
    await runReviewFlow(mobile, base, {
      width: "窄屏 375px",
      owner: "owner2", ownerPass: "owner123", ownerName: "李四",
      ringNo: "CHN-2026-004", newScore: 1550.0, expectRank: 1,
      raceName: "2026秋季300公里大奖赛",
    });
    // 窄屏下表格卡片化、列名标注可见
    await login(mobile, base, "owner2", "owner123");
    await mobile.click('#tabs button:has-text("赛事成绩榜")');
    await mobile.waitForSelector("#standings-slot table");
    const mobileTableDisplay = await mobile.evaluate(() => getComputedStyle(document.querySelector("#standings-slot table")).display);
    check(mobileTableDisplay === "block", `窄屏成绩榜卡片化（table display=${mobileTableDisplay}）`);
    const labelContent = await mobile.evaluate(() => {
      const td = document.querySelector("#standings-slot table tbody tr td");
      return getComputedStyle(td, "::before").content;
    });
    check(labelContent.includes("当前名次"), `窄屏每行显示列名标注（::before=${labelContent}）`);
    const allRowsVisible = await mobile.evaluate(() => {
      const tds = [...document.querySelectorAll("#standings-slot table tbody tr td")];
      return tds.every((td) => td.getBoundingClientRect().right <= window.innerWidth + 1);
    });
    check(allRowsVisible, "窄屏所有列在视口内可读");
    await assertNoOverflow(mobile, "窄屏-成绩榜");
    await mobile.close();
  } finally {
    await browser.close();
    close();
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("浏览器走查异常：", error);
  process.exit(1);
});
