(() => {
  "use strict";

  const DB_NAME = "small-ledger-local-v1";
  const DB_VERSION = 1;
  const STORE = "transactions";
  const categories = {
    expense: ["餐饮", "交通", "购物", "居家", "娱乐", "医疗", "订阅", "其他"],
    income: ["工资", "奖金", "报销", "理财", "其他"],
    refund: ["购物退款", "订单退款", "其他退款"]
  };
  const sourceNames = { manual: "手动", wechat: "微信", alipay: "支付宝", shopping: "购物 App", other: "通知" };
  const typeNames = { expense: "支出", income: "收入", refund: "退款" };
  const typeIcons = { expense: "↗", income: "↙", refund: "↩" };
  let db;
  let selectedType = "expense";
  let activeFilter = "all";
  let draft = null;
  let toastTimer;

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const money = value => `¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const localDateKey = value => {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function allEntries() {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
      request.onerror = () => reject(request.error);
    });
  }
  function saveEntry(entry) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(entry);
      request.onsuccess = () => resolve(entry);
      request.onerror = () => reject(request.error);
    });
  }
  function deleteEntry(id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  }

  function updateDateLabels() {
    const now = new Date();
    $("#today-label").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(now);
    $("#month-label").textContent = `${now.getMonth() + 1} 月净支出`;
  }
  function dateInputValue(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  function signedAmount(entry) {
    if (entry.type === "income") return Number(entry.amount);
    return -Number(entry.amount);
  }
  async function render() {
    const entries = await allEntries();
    const now = new Date();
    const todayKey = localDateKey(now);
    const monthPrefix = todayKey.slice(0, 7);
    const todays = entries.filter(entry => localDateKey(entry.createdAt) === todayKey);
    const thisMonth = entries.filter(entry => localDateKey(entry.createdAt).startsWith(monthPrefix));
    const expensesToday = todays.filter(entry => entry.type === "expense").reduce((sum, entry) => sum + Number(entry.amount), 0);
    const refundsToday = todays.filter(entry => entry.type === "refund").reduce((sum, entry) => sum + Number(entry.amount), 0);
    const linkedRefundsToday = todays.filter(entry => entry.type === "refund" && entry.refundForId).reduce((sum, entry) => sum + Number(entry.amount), 0);
    const expensesMonth = thisMonth.filter(entry => entry.type === "expense").reduce((sum, entry) => sum + Number(entry.amount), 0);
    const refundsMonth = thisMonth.filter(entry => entry.type === "refund").reduce((sum, entry) => sum + Number(entry.amount), 0);
    $("#today-net").textContent = money(Math.max(0, expensesToday - linkedRefundsToday));
    $("#today-out").textContent = money(expensesToday);
    $("#today-refund").textContent = `− ${money(refundsToday)}`;
    $("#month-net").textContent = money(Math.max(0, expensesMonth - thisMonth.filter(entry => entry.type === "refund" && entry.refundForId).reduce((sum, entry) => sum + Number(entry.amount), 0)));

    const visible = activeFilter === "all" ? entries : entries.filter(entry => entry.type === activeFilter);
    $("#ledger-list").innerHTML = visible.map((entry, index) => {
      const previous = visible[index - 1];
      const group = localDateKey(entry.createdAt);
      const header = !previous || localDateKey(previous.createdAt) !== group ? `<div class="ledger-day">${formatDay(entry.createdAt)}</div>` : "";
      const isExpense = entry.type === "expense";
      const amountText = isExpense ? `− ${money(entry.amount)}` : `+ ${money(entry.amount)}`;
      const linkedTarget = entry.type === "refund" && entry.refundForId ? entries.find(item => item.id === entry.refundForId) : null;
      const subtitle = [entry.category, formatTime(entry.createdAt), sourceNames[entry.source] || "其他来源", linkedTarget ? `冲回：${linkedTarget.merchant}` : ""].filter(Boolean).join(" · ");
      return `${header}<article class="ledger-item">
        <div class="item-icon ${entry.type}">${typeIcons[entry.type]}</div>
        <div class="item-main"><div class="item-title">${escapeHTML(entry.merchant || typeNames[entry.type])}</div><div class="item-meta"><i class="source-dot"></i>${escapeHTML(subtitle)}</div></div>
        <div class="item-amount ${entry.type}">${amountText}</div>
        <div class="item-actions"><button class="tiny-action" data-edit="${escapeHTML(entry.id)}" aria-label="编辑账单">···</button></div>
      </article>`;
    }).join("");
    $("#empty-state").hidden = visible.length > 0;
    $("#ledger-list").hidden = visible.length === 0;
  }
  function formatTime(value) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }
  function formatDay(value) {
    const date = new Date(value);
    const today = new Date();
    if (localDateKey(date) === localDateKey(today)) return "今天";
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (localDateKey(date) === localDateKey(yesterday)) return "昨天";
    return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(date);
  }
  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }
  function openSheet(id) {
    $("#" + id).hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSheet(id) {
    $("#" + id).hidden = true;
    if ($$(".overlay:not([hidden])").length === 0) document.body.style.overflow = "";
  }
  function populateCategories(type, selected = "") {
    const select = $("#entry-category");
    select.innerHTML = (categories[type] || categories.expense).map(category => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("");
    if (selected && [...select.options].some(option => option.value === selected)) select.value = selected;
  }
  async function populateRefundLinks(selected = "") {
    const expenses = (await allEntries()).filter(entry => entry.type === "expense");
    $("#entry-refund-link").innerHTML = `<option value="">不关联（不冲减净支出）</option>` + expenses.map(entry => `<option value="${escapeHTML(entry.id)}">${escapeHTML(entry.merchant)} · ${money(entry.amount)} · ${formatDay(entry.createdAt)}</option>`).join("");
    if (selected) $("#entry-refund-link").value = selected;
    $("#refund-link-field").hidden = selectedType !== "refund";
  }
  function chooseType(type) {
    selectedType = type;
    $$("#type-switch button").forEach(button => button.classList.toggle("selected", button.dataset.type === type));
    $("#entry-title").textContent = draft ? "核对待入账" : type === "refund" ? "记录退款" : type === "income" ? "记录收入" : "记一笔";
    $("#entry-kicker").textContent = draft ? "REVIEW CAPTURE" : "NEW ENTRY";
    $("#refund-link-field").hidden = type !== "refund";
    populateCategories(type, $("#entry-category").value);
    if (type === "refund") populateRefundLinks(draft?.refundForId || "");
    $("#save-entry").textContent = type === "refund" ? "确认退款" : "确认入账";
  }
  async function openNewEntry(entryDraft = null) {
    draft = entryDraft;
    selectedType = entryDraft?.type || "expense";
    $("#entry-amount").value = entryDraft?.amount ?? "";
    $("#entry-merchant").value = entryDraft?.merchant ?? "";
    $("#entry-date").value = dateInputValue(entryDraft?.createdAt ? new Date(entryDraft.createdAt) : new Date());
    $("#entry-note").value = entryDraft?.note ?? "";
    $("#entry-source").value = entryDraft?.source ?? "manual";
    populateCategories(selectedType, entryDraft?.category);
    await populateRefundLinks(entryDraft?.refundForId || "");
    chooseType(selectedType);
    $("#form-error").hidden = true;
    openSheet("entry-overlay");
    setTimeout(() => $("#entry-amount").focus(), 120);
  }
  function normalizeSource(value = "") {
    const source = value.toLowerCase();
    if (/wechat|weixin|微信/.test(source)) return "wechat";
    if (/alipay|支付宝/.test(source)) return "alipay";
    if (/taobao|tmall|京东|美团|拼多多|douyin|得物|购物/.test(source)) return "shopping";
    return "other";
  }
  function parseAmount(text) {
    const patterns = [
      /(?:实付|付款|支付|扣款|消费|退款|退回|到账|收款|金额|共计|合计)[^\d¥￥]{0,12}[¥￥]?\s*(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)/i,
      /[¥￥]\s*(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)/,
      /(\d{1,7}(?:,\d{3})*\.\d{2})\s*(?:元|人民币)/,
      /(\d{1,7}(?:,\d{3})*\.\d{2})/
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const amount = Number(match[1].replace(/,/g, ""));
        if (Number.isFinite(amount) && amount > 0 && amount < 100000000) return amount.toFixed(2);
      }
    }
    return "";
  }
  function parseMerchant(text, source) {
    const cleaned = text.split(/[\r\n]/).map(line => line.trim()).filter(Boolean);
    const ignored = /微信支付|支付宝|支付成功|付款成功|交易成功|扣款成功|支付通知|服务通知|账单详情|立即查看|已支付|已付款|退款成功|退款到账|退回成功|人民币|余额|银行卡|信用卡|付款金额|实付金额|交易金额/;
    const candidate = cleaned.find(line => line.length <= 50 && !ignored.test(line) && !/[¥￥]?\s*\d+[,.]?\d*\s*(元|人民币)?/.test(line));
    if (candidate) return candidate.replace(/^[【[]|[】]]$/g, "").slice(0, 60);
    if (source === "wechat") return "微信消费";
    if (source === "alipay") return "支付宝消费";
    if (source === "shopping") return "购物消费";
    return "通知账单";
  }
  function parseNotification(payload) {
    const title = String(payload.title || "");
    const body = String(payload.text || payload.body || payload.message || "");
    const fullText = `${title}\n${body}`.trim();
    const source = normalizeSource(`${payload.source || ""} ${title}`);
    const isRefund = /退款|退回|撤销|原路返回/.test(fullText);
    const isIncome = /收款成功|到账收入|收到转账/.test(fullText);
    const amount = parseAmount(fullText);
    return {
      type: isRefund ? "refund" : isIncome ? "income" : "expense",
      amount,
      merchant: parseMerchant(body || title, source),
      source,
      note: "",
      createdAt: new Date().toISOString(),
      refundForId: ""
    };
  }
  function readCaptureFromUrl() {
    if (!location.hash) return null;
    const hash = location.hash.slice(1);
    let payload = null;
    try {
      if (hash.startsWith("capture?")) {
        const params = new URLSearchParams(hash.slice("capture?".length));
        payload = { source: params.get("source"), title: params.get("title"), text: params.get("text") || params.get("body") };
      } else if (hash.startsWith("capture=")) {
        payload = JSON.parse(decodeURIComponent(hash.slice("capture=".length)));
      } else if (hash.startsWith("capture/")) {
        payload = JSON.parse(decodeURIComponent(hash.slice("capture/".length)));
      }
    } catch (error) {
      showToast("通知链接格式不正确");
      return null;
    } finally {
      if (/^#capture(?:[=?/]|$)/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    }
    return payload;
  }
  function findLikelyRefundTarget(refund) {
    return allEntries().then(entries => {
      const candidates = entries.filter(entry => entry.type === "expense" && Math.abs(Number(entry.amount) - Number(refund.amount)) < 0.005);
      const sameMerchant = candidates.find(entry => refund.merchant && entry.merchant.toLowerCase() === refund.merchant.toLowerCase());
      return sameMerchant || candidates[0] || null;
    });
  }
  async function openCapture(payload) {
    const parsed = parseNotification(payload);
    const refundTarget = parsed.type === "refund" && parsed.amount ? await findLikelyRefundTarget(parsed) : null;
    if (refundTarget) parsed.refundForId = refundTarget.id;
    $("#capture-description").textContent = [parsed.merchant, parsed.amount ? money(parsed.amount) : "未识别金额"].join(" · ");
    $("#capture-banner").hidden = false;
    await openNewEntry(parsed);
  }
  async function submitEntry() {
    const amount = Number($("#entry-amount").value.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      $("#form-error").textContent = "请输入大于 0 的金额。";
      $("#form-error").hidden = false;
      return;
    }
    const timestamp = new Date($("#entry-date").value).toISOString();
    const entry = {
      id: draft?.id || crypto.randomUUID(),
      type: selectedType,
      amount: Number(amount.toFixed(2)),
      merchant: $("#entry-merchant").value.trim() || typeNames[selectedType],
      category: $("#entry-category").value,
      source: $("#entry-source").value,
      note: $("#entry-note").value.trim(),
      createdAt: timestamp,
      refundForId: selectedType === "refund" ? $("#entry-refund-link").value : "",
      captureFingerprint: draft?.captureFingerprint || ""
    };
    await saveEntry(entry);
    closeSheet("entry-overlay");
    draft = null;
    $("#capture-banner").hidden = true;
    await render();
    showToast(selectedType === "refund" ? (entry.refundForId ? "退款已关联，净支出已更新" : "退款已记录（未关联，不冲减净支出）") : "账单已入账");
  }
  async function editEntry(id) {
    const entry = (await allEntries()).find(item => item.id === id);
    if (!entry) return;
    await openNewEntry(entry);
  }
  async function handleItemAction(event) {
    const button = event.target.closest("[data-edit]");
    if (!button) return;
    const id = button.dataset.edit;
    const entries = await allEntries();
    const entry = entries.find(item => item.id === id);
    if (!entry) return;
    const action = window.prompt(`输入 E 编辑，D 删除账单\n${entry.merchant} · ${money(entry.amount)}`, "E");
    if (action?.toLowerCase() === "e") editEntry(id);
    if (action?.toLowerCase() === "d" && window.confirm("确定删除这条记录？若有退款关联，退款记录不会自动删除。")) {
      await deleteEntry(id);
      await render();
      showToast("已删除");
    }
  }
  async function exportBackup() {
    const entries = await allEntries();
    const data = { format: "small-ledger-backup", version: 1, exportedAt: new Date().toISOString(), transactions: entries };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `小账本备份-${localDateKey(new Date())}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("备份文件已生成");
  }
  async function restoreBackup(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const entries = parsed.transactions;
      if (!Array.isArray(entries) || entries.some(entry => !entry.id || !["expense", "income", "refund"].includes(entry.type))) throw new Error("format");
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      entries.forEach(entry => store.put(entry));
      tx.oncomplete = async () => { await render(); showToast(`已恢复 ${entries.length} 条记录`); };
    } catch {
      showToast("无法读取这个备份文件");
    }
  }
  function bindEvents() {
    $("#add-button").addEventListener("click", () => openNewEntry());
    $("#settings-open").addEventListener("click", () => openSheet("settings-overlay"));
    $$("[data-close]").forEach(button => button.addEventListener("click", () => closeSheet(button.dataset.close)));
    $$(".overlay").forEach(overlay => overlay.addEventListener("click", event => { if (event.target === overlay) closeSheet(overlay.id); }));
    $$("#type-switch button").forEach(button => button.addEventListener("click", () => chooseType(button.dataset.type)));
    $$(".filter").forEach(button => button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      $$(".filter").forEach(item => item.classList.toggle("active", item === button));
      render();
    }));
    $("#save-entry").addEventListener("click", submitEntry);
    $("#ledger-list").addEventListener("click", handleItemAction);
    $("#capture-review").addEventListener("click", () => { if (draft) openNewEntry(draft); });
    $("#try-capture").addEventListener("click", () => openCapture({ source: "wechat", title: "微信支付", text: "星巴克咖啡\n支付成功 ¥28.00" }));
    $("#export-button").addEventListener("click", exportBackup);
    $("#show-shortcut-guide").addEventListener("click", () => openSheet("guide-overlay"));
    $("#privacy-info").addEventListener("click", () => openSheet("settings-overlay"));
    $("#clear-data").addEventListener("click", async () => {
      if (!window.confirm("确定清空此设备上的全部账单？建议先备份。")) return;
      await new Promise((resolve, reject) => {
        const request = db.transaction(STORE, "readwrite").objectStore(STORE).clear();
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
      closeSheet("settings-overlay");
      await render();
      showToast("本机账单已清空");
    });
    $("#restore-button").addEventListener("click", () => $("#restore-file").click());
    $("#restore-file").addEventListener("change", event => { if (event.target.files?.[0]) restoreBackup(event.target.files[0]); event.target.value = ""; });
    document.addEventListener("keydown", event => { if (event.key === "Escape") $$(".overlay:not([hidden])").forEach(item => closeSheet(item.id)); });
  }
  async function init() {
    try {
      db = await openDatabase();
    } catch {
      document.body.innerHTML = "<main style='padding:2rem;font-family:sans-serif'>浏览器无法创建本地账本存储，请使用最新版 Safari 或 Chrome，并确认未处于无痕模式。</main>";
      return;
    }
    updateDateLabels();
    bindEvents();
    await render();
    const capture = readCaptureFromUrl();
    if (capture) await openCapture(capture);
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  init();
})();

