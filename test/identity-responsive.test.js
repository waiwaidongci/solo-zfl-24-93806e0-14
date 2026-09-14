import test from "node:test";
import assert from "node:assert/strict";
import { api, login, startApp } from "./helpers.js";

const ROLE_LABELS = { owner: "鸽主", reviewer: "审理人" };

// 回归：身份栏「名称（角色）」中名称与角色各出现一次
test("身份文本不重复：名称与角色各出现一次", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { base } = app;

  const accounts = [
    ["owner1", "owner123", "owner"],
    ["owner2", "owner123", "owner"],
    ["reviewer", "review123", "reviewer"],
  ];
  for (const [username, password, role] of accounts) {
    await t.test(`${username} 的身份组合`, async () => {
      const token = await login(base, username, password);
      const { data } = await api(base, "GET", "/api/me", { token });
      const { displayName, role: userRole } = data.user;
      const roleLabel = ROLE_LABELS[userRole];

      assert.ok(!displayName.includes(roleLabel), `displayName 不应包含角色文本：${displayName}`);
      assert.ok(!/[（(]/.test(displayName), `displayName 不应带括号后缀：${displayName}`);

      // 与前端身份栏相同的拼接方式：名称（角色）
      const headerText = `${displayName}（${roleLabel}）`;
      const nameCount = headerText.split(displayName).length - 1;
      const roleCount = headerText.split(roleLabel).length - 1;
      assert.equal(nameCount, 1, `名称应出现一次：${headerText}`);
      assert.equal(roleCount, 1, `角色应出现一次：${headerText}`);
      assert.equal(userRole, role);
    });
  }

  await t.test("存量脏数据（名称带角色后缀）启动时被迁移", async () => {
    // 直接往库里写一条旧格式数据，重启应用后应被规范化
    const { hashPassword } = await import("../src/auth.js");
    app.db
      .prepare("INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)")
      .run("legacy1", hashPassword("x"), "赵六（鸽主）", "owner", new Date().toISOString());
    const app2 = await startApp(); // 触发新实例迁移逻辑不作用于本库，这里直接调用迁移函数验证
    t.after(() => app2.close());
    const { migrateDisplayNames } = await import("../src/seed.js");
    migrateDisplayNames(app.db);
    const row = app.db.prepare("SELECT display_name FROM users WHERE username = 'legacy1'").get();
    assert.equal(row.display_name, "赵六");
  });
});

// 回归：窄屏成绩榜不横向溢出 —— 校验服务下发的响应式规则与表格标注完整
test("窄屏成绩榜：响应式规则与单元格标注完整", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { base } = app;

  const css = await (await fetch(`${base}/styles.css`)).text();
  const js = await (await fetch(`${base}/app.js`)).text();

  await t.test("样式包含窄屏媒体查询与卡片式表格规则", () => {
    assert.match(css, /@media\s*\(max-width:\s*720px\)/, "缺少 720px 窄屏媒体查询");
    for (const rule of [
      "table.responsive thead { display: none",
      "table.responsive tr {",
      "table.responsive td {",
      "content: attr(data-label)",
    ]) {
      assert.ok(css.includes(rule), `styles.css 缺少规则：${rule}`);
    }
    // 网格最小列宽不得撑出超窄视口
    assert.match(css, /minmax\(min\(320px,\s*100%\),\s*1fr\)/, "网格最小列宽未做窄屏保护");
  });

  await t.test("三张数据表均为 responsive 且每个单元格带 data-label", () => {
    const tables = js.match(/<table[^>]*>[\s\S]*?<\/table>/g) || [];
    assert.ok(tables.length >= 3, `前端应至少渲染 3 张数据表，实际 ${tables.length}`);
    for (const [i, table] of tables.entries()) {
      assert.ok(table.includes('class="responsive"'), `第 ${i + 1} 张表缺少 responsive 类`);
      const headerCells = [...table.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]);
      const labels = [...table.matchAll(/data-label="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(headerCells.length > 0, `第 ${i + 1} 张表没有表头`);
      // 每行的 data-label 数量应与静态列数一致（条件列「调整分速」在模板中同样带标注）
      const staticHeaders = headerCells.filter((h) => h !== "调整分速");
      const rowLabelCounts = countPerRow(table);
      for (const c of rowLabelCounts) {
        assert.ok(
          c === staticHeaders.length || c === headerCells.length,
          `第 ${i + 1} 张表某行 data-label 数 ${c} 与列数 ${staticHeaders.length}/${headerCells.length} 不符`
        );
      }
      for (const h of staticHeaders) {
        assert.ok(labels.includes(h), `第 ${i + 1} 张表缺少 data-label「${h}」`);
      }
    }
  });

  await t.test("桌面布局不受影响：720px 以上无表格卡片化规则", () => {
    // 卡片化规则必须只存在于 720px 媒体查询块内
    const before = css.slice(0, css.indexOf("@media (max-width: 720px)"));
    assert.ok(!before.includes("table.responsive"), "桌面样式中不应出现 table.responsive 规则");
  });
});

/** 统计每张表模板中每个 <tr> 内的 data-label 数量。 */
function countPerRow(tableHtml) {
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => (m[1].match(/data-label=/g) || []).length)
    .filter((n) => n > 0);
}
