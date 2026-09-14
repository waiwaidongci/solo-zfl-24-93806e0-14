/* 赛鸽登记站 · 成绩申诉复核 —— 前端单页应用 */
"use strict";

const STATUS_LABELS = {
  PENDING: "待审理",
  ACCEPTED: "已受理",
  SUPPLEMENT_REQUIRED: "待补证",
  REJECTED: "已驳回",
  REJUDGED: "已改判",
};
const ACTION_LABELS = {
  submit: "提交申诉",
  accept: "受理",
  request_supplement: "要求补证",
  supplement: "补充证据",
  reject: "驳回",
  rejudge: "改判",
};
const REASON_LABELS = { publish: "成绩公布", rejudge: "改判重排", manual_adjust: "人工调整" };

let token = localStorage.getItem("token") || "";
let me = null;
let currentTab = "";
let cache = { races: [] };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");
const pill = (status) => `<span class="pill ${status}">${STATUS_LABELS[status] || status}</span>`;

function showBanner(message, ok = false) {
  const banner = $("#banner");
  banner.textContent = message;
  banner.className = `banner${ok ? " success" : ""}`;
  clearTimeout(showBanner.timer);
  showBanner.timer = setTimeout(() => banner.classList.add("hidden"), 6000);
}
const showError = (error) => showBanner(error.message || String(error));
const showOk = (message) => showBanner(message, true);

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error?.message || `请求失败（${res.status}）`);
    error.code = data?.error?.code;
    error.status = res.status;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------- 登录/框架
async function boot() {
  $("#login-form").onsubmit = onLogin;
  $("#logout").onclick = onLogout;
  if (token) {
    try {
      me = (await api("/api/me")).user;
    } catch {
      token = "";
      localStorage.removeItem("token");
    }
  }
  render();
}

async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: { username: form.get("username"), password: form.get("password") },
    });
    token = data.token;
    me = data.user;
    localStorage.setItem("token", token);
    render();
  } catch (error) {
    showError(error);
  }
}

async function onLogout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch { /* 忽略 */ }
  token = "";
  me = null;
  localStorage.removeItem("token");
  render();
}

const TABS = {
  owner: [
    ["my-results", "我的成绩"],
    ["my-appeals", "我的申诉"],
    ["my-pigeons", "我的鸽只"],
    ["standings", "赛事成绩榜"],
  ],
  reviewer: [
    ["review-queue", "申诉处理"],
    ["race-admin", "赛事管理"],
    ["standings", "赛事成绩榜"],
  ],
};

function render() {
  $("#view-login").classList.toggle("hidden", !!me);
  $("#view-app").classList.toggle("hidden", !me);
  $("#userbar").classList.toggle("hidden", !me);
  if (!me) return;
  $("#whoami").textContent = `${me.displayName}（${me.role === "owner" ? "鸽主" : "审理人"}）`;
  const tabs = TABS[me.role];
  if (!tabs.some(([key]) => key === currentTab)) currentTab = tabs[0][0];
  $("#tabs").innerHTML = tabs
    .map(([key, label]) => `<button data-tab="${key}" class="${key === currentTab ? "active" : ""}">${label}</button>`)
    .join("");
  document.querySelectorAll("#tabs button").forEach((btn) => {
    btn.onclick = () => {
      currentTab = btn.dataset.tab;
      render();
    };
  });
  renderTab().catch(showError);
}

async function renderTab() {
  const content = $("#tab-content");
  content.innerHTML = "<p class='muted'>加载中…</p>";
  const renderers = {
    "my-results": renderMyResults,
    "my-appeals": renderMyAppeals,
    "my-pigeons": renderMyPigeons,
    standings: renderStandings,
    "review-queue": renderReviewQueue,
    "race-admin": renderRaceAdmin,
  };
  await renderers[currentTab](content);
}

// ---------------------------------------------------------------- 鸽主：我的成绩
async function renderMyResults(content) {
  const { results } = await api("/api/my/results");
  const now = Date.now();
  content.innerHTML = `
    <div class="panel section">
      <h2>我的成绩</h2>
      <p class="muted">申诉期内的已公布成绩可提交申诉；每条成绩只能申诉一次。申诉被受理后，该鸽将冻结转让与成绩修改。</p>
      ${results.length === 0 ? "<p class='muted'>暂无成绩记录。</p>" : ""}
      ${results.length ? `<table class="responsive"><thead><tr>
        <th>赛事</th><th>足环号</th><th>分速</th><th>当前名次</th><th>原始名次</th><th>申诉期</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>
        ${results.map((r) => {
          const windowOpen = r.race_status === "published" && Date.parse(r.appeal_deadline) >= now;
          const frozen = r.frozen ? `<span class="pill frozen">已冻结</span>` : "";
          const appeal = r.appeal_id ? pill(r.appeal_status) : "";
          const action = r.appeal_id
            ? `<button class="small ghost" data-appeal="${r.appeal_id}">查看申诉</button>`
            : windowOpen
              ? `<button class="small" data-new-appeal="${r.result_id}">提交申诉</button>`
              : `<span class="muted">${r.race_status === "published" ? "已过申诉期" : "未公布"}</span>`;
          return `<tr class="${r.frozen ? "frozen-row" : ""}">
            <td data-label="赛事">${esc(r.race_name)}</td><td data-label="足环号">${esc(r.ring_no)} ${frozen}</td><td data-label="分速">${r.score}</td>
            <td data-label="当前名次">${r.rank ?? "—"}</td><td data-label="原始名次">${r.original_rank ?? "—"}</td>
            <td data-label="申诉期" class="muted">${r.race_status === "published" ? `截止 ${fmtTime(r.appeal_deadline)}` : "未公布"}</td>
            <td data-label="状态">${appeal}</td><td data-label="操作">${action}</td></tr>`;
        }).join("")}
      </tbody></table>` : ""}
    </div>
    <div id="appeal-form-slot"></div>`;

  content.querySelectorAll("[data-new-appeal]").forEach((btn) => {
    btn.onclick = () => showAppealForm(Number(btn.dataset.newAppeal), results);
  });
  content.querySelectorAll("[data-appeal]").forEach((btn) => {
    btn.onclick = () => {
      currentTab = "my-appeals";
      render();
    };
  });
}

function showAppealForm(resultId, results) {
  const result = results.find((r) => r.result_id === resultId);
  const slot = $("#appeal-form-slot");
  slot.innerHTML = `
    <form class="panel" id="appeal-form">
      <h2>提交申诉 — ${esc(result.race_name)} / ${esc(result.ring_no)}</h2>
      <p class="muted">当前分速 ${result.score}，名次第 ${result.rank} 名。申诉截止：${fmtTime(result.appeal_deadline)}</p>
      <label>申诉理由</label>
      <textarea name="reason" required placeholder="说明成绩异议的具体原因"></textarea>
      <label>证据材料</label>
      <textarea name="evidence" required placeholder="足环扫描记录、鸽钟数据、现场照片说明等"></textarea>
      <div class="actions">
        <button type="submit">提交申诉</button>
        <button type="button" class="ghost" id="appeal-cancel">取消</button>
      </div>
    </form>`;
  $("#appeal-cancel").onclick = () => (slot.innerHTML = "");
  $("#appeal-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/api/appeals", {
        method: "POST",
        body: { resultId, reason: form.get("reason"), evidence: form.get("evidence") },
      });
      showOk("申诉已提交，等待审理");
      await renderTab();
    } catch (error) {
      showError(error);
    }
  };
}

// ---------------------------------------------------------------- 鸽主：我的申诉
async function renderMyAppeals(content) {
  const { appeals } = await api("/api/appeals");
  content.innerHTML = `
    <div class="section"><h2>我的申诉</h2>
    ${appeals.length === 0 ? "<p class='muted'>暂无申诉记录。</p>" : ""}
    <div class="grid">
      ${appeals.map((a) => `
        <div class="card">
          <h3>${esc(a.race_name)} · ${esc(a.ring_no)} ${pill(a.status)}</h3>
          <div class="muted">提交于 ${fmtTime(a.created_at)}${a.supplement_deadline && a.status === "SUPPLEMENT_REQUIRED" ? ` · 补证截止 ${fmtTime(a.supplement_deadline)}` : ""}</div>
          <div>理由：${esc(a.reason)}</div>
          <div class="actions"><button class="small ghost" data-detail="${a.id}">详情与证据链</button></div>
          <div data-slot="${a.id}"></div>
        </div>`).join("")}
    </div></div>`;
  content.querySelectorAll("[data-detail]").forEach((btn) => {
    btn.onclick = () => showAppealDetail(Number(btn.dataset.detail), content);
  });
}

async function showAppealDetail(appealId, content) {
  const slot = content.querySelector(`[data-slot="${appealId}"]`);
  try {
    const { appeal, evidences, events } = await api(`/api/appeals/${appealId}`);
    const canSupplement = appeal.status === "SUPPLEMENT_REQUIRED";
    slot.innerHTML = `
      <div class="inline-form">
        <h3>证据材料</h3>
        ${evidences.map((e) => `<div class="muted">[${e.kind === "initial" ? "初始" : "补证"}] ${fmtTime(e.created_at)}：${esc(e.content)}</div>`).join("")}
        <h3>处理轨迹</h3>
        <ul class="timeline">
          ${events.map((ev) => `<li><b>${ACTION_LABELS[ev.action] || ev.action}</b>
            ${ev.from_status ? `${STATUS_LABELS[ev.from_status]} → ` : ""}${STATUS_LABELS[ev.to_status] || ""}
            <span class="muted">${esc(ev.actor_name || "系统")} · ${fmtTime(ev.created_at)}</span>
            ${ev.note ? `<div class="muted">${esc(ev.note)}</div>` : ""}</li>`).join("")}
        </ul>
        ${canSupplement ? `
          <form data-supplement="${appealId}">
            <label>补充证据（截止 ${fmtTime(appeal.supplement_deadline)}，逾期将被拒绝）</label>
            <textarea name="evidence" required></textarea>
            <div class="actions"><button class="small" type="submit">提交补证</button></div>
          </form>` : ""}
      </div>`;
    const form = slot.querySelector("[data-supplement]");
    if (form) {
      form.onsubmit = async (event) => {
        event.preventDefault();
        try {
          await api(`/api/appeals/${appealId}/supplement`, {
            method: "POST",
            body: { evidence: new FormData(form).get("evidence") },
          });
          showOk("补证已提交，申诉回到待审理队列");
          await renderTab();
        } catch (error) {
          showError(error);
        }
      };
    }
  } catch (error) {
    showError(error);
  }
}

// ---------------------------------------------------------------- 鸽主：我的鸽只
async function renderMyPigeons(content) {
  const { pigeons } = await api("/api/pigeons");
  content.innerHTML = `
    <div class="section">
      <div class="panel section">
        <h2>登记新鸽</h2>
        <form id="pigeon-form" class="two-col">
          <div><label>足环号</label><input name="ringNo" required placeholder="CHN-2026-XXX"></div>
          <div><label>羽色</label><input name="color" placeholder="灰"></div>
          <div><label>棚号</label><input name="loft" placeholder="北岸A棚"></div>
          <div style="align-self:end"><button type="submit">登记</button></div>
        </form>
      </div>
      <div class="grid">
        ${pigeons.map((p) => `
          <div class="card">
            <h3>${esc(p.ring_no)} ${p.frozen ? '<span class="pill frozen">申诉复核中 · 已冻结</span>' : ""}</h3>
            <div class="muted">${esc(p.color || "—")} · ${esc(p.loft || "—")} · 鸽主 ${esc(p.owner_name)}</div>
            <div data-transfers="${p.id}" class="muted">转让记录加载中…</div>
            ${p.frozen
              ? `<div class="muted">该鸽有已受理的申诉，复核期间禁止转让、成绩锁定。</div>`
              : `<form data-transfer-form="${p.id}" class="inline-form">
                   <label>转让给（输入对方用户名）</label>
                   <input name="toUsername" required placeholder="如 owner2">
                   <div class="actions"><button class="small" type="submit">确认转让</button></div>
                 </form>`}
          </div>`).join("")}
      </div>
    </div>`;

  $("#pigeon-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/api/pigeons", {
        method: "POST",
        body: { ringNo: form.get("ringNo"), color: form.get("color"), loft: form.get("loft") },
      });
      showOk("鸽只已登记");
      await renderTab();
    } catch (error) {
      showError(error);
    }
  };

  for (const p of pigeons) {
    const slot = content.querySelector(`[data-transfers="${p.id}"]`);
    try {
      const { transfers } = await api(`/api/pigeons/${p.id}/transfers`);
      slot.textContent = transfers.length
        ? `转让记录：${transfers.map((t) => `${t.from_name} → ${t.to_name}（${fmtTime(t.created_at)}）`).join("；")}`
        : "暂无转让记录";
    } catch { /* 忽略单项失败 */ }
  }

  content.querySelectorAll("[data-transfer-form]").forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const pigeonId = Number(form.dataset.transferForm);
      try {
        await api(`/api/pigeons/${pigeonId}/transfer`, {
          method: "POST",
          body: { toUsername: new FormData(form).get("toUsername") },
        });
        showOk("转让完成");
        await renderTab();
      } catch (error) {
        showError(error);
      }
    };
  });
}

// ---------------------------------------------------------------- 审理人：申诉处理
async function renderReviewQueue(content, filter = "open") {
  const { appeals } = await api("/api/appeals");
  const open = appeals.filter((a) => !["REJECTED", "REJUDGED"].includes(a.status));
  const shown = filter === "open" ? open : appeals;
  content.innerHTML = `
    <div class="section">
      <div class="actions" style="margin:0 0 12px">
        <button class="small ${filter === "open" ? "" : "ghost"}" data-filter="open">待处理（${open.length}）</button>
        <button class="small ${filter === "all" ? "" : "ghost"}" data-filter="all">全部（${appeals.length}）</button>
      </div>
      ${shown.length === 0 ? "<p class='muted'>暂无申诉。</p>" : ""}
      <div class="grid">
        ${shown.map((a) => `
          <div class="card">
            <h3>#${a.id} ${esc(a.race_name)} · ${esc(a.ring_no)} ${pill(a.status)}</h3>
            <div class="muted">申诉人 ${esc(a.owner_name)} · ${fmtTime(a.created_at)} · 当前第 ${a.rank ?? "—"} 名（原第 ${a.original_rank ?? "—"} 名）</div>
            <div>理由：${esc(a.reason)}</div>
            <div class="actions"><button class="small" data-open="${a.id}">审理</button></div>
            <div data-case="${a.id}"></div>
          </div>`).join("")}
      </div>
    </div>`;
  content.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.onclick = () => renderReviewQueue(content, btn.dataset.filter).catch(showError);
  });
  content.querySelectorAll("[data-open]").forEach((btn) => {
    btn.onclick = () => showReviewCase(Number(btn.dataset.open), content).catch(showError);
  });
}

async function showReviewCase(appealId, content) {
  const slot = content.querySelector(`[data-case="${appealId}"]`);
  const { appeal, evidences, events } = await api(`/api/appeals/${appealId}`);
  const terminal = ["REJECTED", "REJUDGED"].includes(appeal.status);
  slot.innerHTML = `
    <div class="inline-form">
      <h3>证据材料</h3>
      ${evidences.map((e) => `<div class="muted">[${e.kind === "initial" ? "初始" : "补证"}] ${fmtTime(e.created_at)}：${esc(e.content)}</div>`).join("")}
      <h3>处理轨迹</h3>
      <ul class="timeline">
        ${events.map((ev) => `<li><b>${ACTION_LABELS[ev.action] || ev.action}</b>
          ${ev.from_status ? `${STATUS_LABELS[ev.from_status]} → ` : ""}${STATUS_LABELS[ev.to_status] || ""}
          <span class="muted">${esc(ev.actor_name || "系统")} · ${fmtTime(ev.created_at)}</span>
          ${ev.note ? `<div class="muted">${esc(ev.note)}</div>` : ""}</li>`).join("")}
      </ul>
      ${terminal ? `<div class="muted">申诉已终结（${STATUS_LABELS[appeal.status]}），不可再操作。</div>` : `
        <h3>审理操作</h3>
        <label>处理意见 / 备注</label>
        <textarea name="note" placeholder="受理意见、驳回理由或补证要求说明"></textarea>
        ${appeal.status === "PENDING" ? `
          <label>补证期限（分钟，要求补证时使用）</label>
          <input name="deadlineMinutes" type="number" min="1" value="1440">` : ""}
        ${appeal.status === "ACCEPTED" ? `
          <label>改判分速（当前 ${appeal.score}）</label>
          <input name="newScore" type="number" step="0.01" min="0" placeholder="改判后的分速">` : ""}
        <div class="actions">
          ${appeal.status === "PENDING" ? `<button class="small ok" data-act="accept">受理</button>
            <button class="small warn" data-act="request-supplement">要求补证</button>` : ""}
          ${["PENDING", "SUPPLEMENT_REQUIRED", "ACCEPTED"].includes(appeal.status) ? `<button class="small danger" data-act="reject">驳回</button>` : ""}
          ${appeal.status === "ACCEPTED" ? `<button class="small" data-act="rejudge">改判并重算排名</button>` : ""}
        </div>`}
    </div>`;

  slot.querySelectorAll("[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const note = slot.querySelector('[name="note"]').value;
      const act = btn.dataset.act;
      const bodies = {
        accept: { note },
        "request-supplement": { note, deadlineMinutes: Number(slot.querySelector('[name="deadlineMinutes"]')?.value) },
        reject: { note },
        rejudge: { note, newScore: Number(slot.querySelector('[name="newScore"]')?.value) },
      };
      try {
        await api(`/api/appeals/${appealId}/${act}`, { method: "POST", body: bodies[act] });
        showOk({ accept: "已受理，该鸽已冻结", "request-supplement": "已要求补证", reject: "已驳回", rejudge: "已改判，排名已重算" }[act]);
        await renderTab();
      } catch (error) {
        showError(error);
      }
    };
  });
}

// ---------------------------------------------------------------- 审理人：赛事管理
async function renderRaceAdmin(content) {
  const { races } = await api("/api/races");
  content.innerHTML = `
    <div class="panel section">
      <h2>创建赛事</h2>
      <form id="race-form" class="two-col">
        <div><label>赛事名称</label><input name="name" required></div>
        <div><label>距离（公里）</label><input name="distanceKm" type="number" min="0" value="300"></div>
        <div style="align-self:end"><button type="submit">创建</button></div>
      </form>
    </div>
    ${races.map((race) => `
      <div class="panel section">
        <h3>#${race.id} ${esc(race.name)}
          <span class="pill ${race.status === "published" ? "ACCEPTED" : "PENDING"}">${race.status === "published" ? "已公布" : "登记中"}</span>
        </h3>
        <div class="muted">${race.distance_km} 公里 · 成绩 ${race.result_count} 条 · 申诉 ${race.appeal_count} 条
          ${race.status === "published" ? ` · 公布于 ${fmtTime(race.published_at)} · 申诉截止 ${fmtTime(race.appeal_deadline)}` : ""}</div>
        <div data-race-slot="${race.id}"></div>
        <div class="actions">
          <button class="small ghost" data-standings-link="${race.id}">查看成绩榜</button>
          ${race.status === "draft" ? `<button class="small ghost" data-add-result="${race.id}">登记成绩</button>
            <button class="small" data-publish="${race.id}">公布成绩</button>` : ""}
        </div>
      </div>`).join("")}`;

  $("#race-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/api/races", { method: "POST", body: { name: form.get("name"), distanceKm: Number(form.get("distanceKm")) } });
      showOk("赛事已创建");
      await renderTab();
    } catch (error) {
      showError(error);
    }
  };

  content.querySelectorAll("[data-standings-link]").forEach((btn) => {
    btn.onclick = () => {
      sessionStorage.setItem("standings-race", btn.dataset.standingsLink);
      currentTab = "standings";
      render();
    };
  });

  content.querySelectorAll("[data-add-result]").forEach((btn) => {
    btn.onclick = () => {
      const raceId = Number(btn.dataset.addResult);
      const slot = content.querySelector(`[data-race-slot="${raceId}"]`);
      slot.innerHTML = `
        <form class="inline-form" data-result-form="${raceId}">
          <label>足环号</label><input name="ringNo" required placeholder="CHN-2026-001">
          <label>分速（米/分）</label><input name="score" type="number" step="0.01" min="0" required>
          <div class="actions"><button class="small" type="submit">保存成绩</button></div>
        </form>`;
      slot.querySelector("form").onsubmit = async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        try {
          await api(`/api/races/${raceId}/results`, {
            method: "POST",
            body: { ringNo: form.get("ringNo"), score: Number(form.get("score")) },
          });
          showOk("成绩已登记");
          await renderTab();
        } catch (error) {
          showError(error);
        }
      };
    };
  });

  content.querySelectorAll("[data-publish]").forEach((btn) => {
    btn.onclick = async () => {
      const days = Number(prompt("申诉期天数（成绩公布后可申诉的天数）", "3"));
      if (!days) return;
      try {
        await api(`/api/races/${btn.dataset.publish}/publish`, { method: "POST", body: { appealDays: days } });
        showOk("成绩已公布，名次已生成");
        await renderTab();
      } catch (error) {
        showError(error);
      }
    };
  });
}

// ---------------------------------------------------------------- 公共：成绩榜
async function renderStandings(content) {
  const { races } = await api("/api/races");
  cache.races = races;
  const preset = Number(sessionStorage.getItem("standings-race")) || (races[0] && races[0].id);
  sessionStorage.removeItem("standings-race");
  content.innerHTML = `
    <div class="panel section">
      <h2>赛事成绩榜</h2>
      <label>选择赛事</label>
      <select id="race-select">
        ${races.map((r) => `<option value="${r.id}" ${r.id === preset ? "selected" : ""}>${esc(r.name)}（${r.status === "published" ? "已公布" : "登记中"}）</option>`).join("")}
      </select>
      <div id="standings-slot" style="margin-top:14px"></div>
    </div>`;
  const select = $("#race-select");
  const load = async () => {
    if (!select.value) {
      $("#standings-slot").innerHTML = "<p class='muted'>暂无赛事。</p>";
      return;
    }
    const { race, results, history } = await api(`/api/races/${select.value}/standings`);
    $("#standings-slot").innerHTML = `
      ${race.status === "published" ? `<p class="muted">公布于 ${fmtTime(race.published_at)} · 申诉截止 ${fmtTime(race.appeal_deadline)}</p>` : "<p class='muted'>赛事尚未公布成绩。</p>"}
      <table class="responsive"><thead><tr><th>当前名次</th><th>原始名次</th><th>足环号</th><th>鸽主</th><th>分速</th><th>申诉</th>${me.role === "reviewer" && race.status === "published" ? "<th>调整分速</th>" : ""}</tr></thead>
      <tbody>
        ${results.map((r) => {
          const moved = r.original_rank !== null && r.rank !== r.original_rank;
          const rankCell = moved
            ? `<span class="rank-old">第${r.original_rank}名</span><span class="${r.rank < r.original_rank ? "diff-up" : "diff-down"}">第${r.rank}名</span>`
            : `第${r.rank ?? "—"}名`;
          return `<tr class="${r.frozen ? "frozen-row" : ""}">
            <td data-label="当前名次">${rankCell}</td><td data-label="原始名次">${r.original_rank ?? "—"}</td>
            <td data-label="足环号">${esc(r.ring_no)} ${r.frozen ? '<span class="pill frozen">冻结</span>' : ""}</td>
            <td data-label="鸽主">${esc(r.owner_name)}</td><td data-label="分速">${r.score}</td>
            <td data-label="申诉">${r.appeal_status ? pill(r.appeal_status) : "—"}</td>
            ${me.role === "reviewer" && race.status === "published" ? `<td data-label="调整分速">
              <form data-adjust="${r.result_id}" style="display:flex;gap:6px">
                <input name="score" type="number" step="0.01" min="0" placeholder="新分速" style="flex:1;min-width:80px">
                <button class="small ghost" type="submit">调整</button>
              </form></td>` : ""}
          </tr>`;
        }).join("")}
      </tbody></table>
      <h3 style="margin-top:16px">名次调整记录</h3>
      ${history.length === 0 ? "<p class='muted'>暂无调整记录。</p>" : `
        <table class="responsive"><thead><tr><th>时间</th><th>足环号</th><th>分速变化</th><th>名次变化</th><th>原因</th><th>关联申诉</th></tr></thead>
        <tbody>
          ${history.map((h) => `<tr>
            <td data-label="时间" class="muted">${fmtTime(h.created_at)}</td><td data-label="足环号">${esc(h.ring_no)}</td>
            <td data-label="分速变化">${h.old_score === null ? "—" : `${h.old_score} → ${h.new_score}`}</td>
            <td data-label="名次变化">${h.old_rank === null ? `首次排名 第${h.new_rank}名` : `第${h.old_rank}名 → 第${h.new_rank}名`}</td>
            <td data-label="原因">${REASON_LABELS[h.reason] || esc(h.reason)}</td>
            <td data-label="关联申诉">${h.appeal_id ? `#${h.appeal_id}` : "—"}</td>
          </tr>`).join("")}
        </tbody></table>`}`;

    content.querySelectorAll("[data-adjust]").forEach((form) => {
      form.onsubmit = async (event) => {
        event.preventDefault();
        const score = Number(new FormData(form).get("score"));
        const reason = prompt("调整原因（将记入排名历史）", "成绩勘误");
        if (reason === null) return;
        try {
          await api(`/api/results/${form.dataset.adjust}`, {
            method: "PATCH",
            body: { score, reason },
          });
          showOk("分速已调整，排名已重算");
          await load();
        } catch (error) {
          showError(error);
        }
      };
    });
  };
  select.onchange = () => load().catch(showError);
  await load();
}

boot();
