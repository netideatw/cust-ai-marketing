// 寄信函式（經 Gmail SMTP）
//  - type=registration：由資料庫觸發器呼叫，寄「已收到報名資料（一天內通知基本審查結果）」給報名者、「新報名」給有開啟通知的管理員。
//    只接受 id，資料一律從資料庫讀取，且每筆只寄一次（notified_at），外人呼叫也無法利用。
//    通過基本審查信與補件提醒由 reg-remind 排程寄出。
//  - type=interview：管理員在後台寄「面試通知」（日期、時間、地點、備註）。需管理員登入。
//  - type=admit：管理員在後台寄「錄取／候補通知」（開課前 3 天）。需管理員登入。
//  - type=forgot：登入頁「忘記密碼／第一次登入」，只對管理員名單或已通過審核的推廣者 Email 寄出設定密碼連結；
//    名單內但尚未有帳號者，會先建立帳號（無密碼），由本人透過信中連結設定密碼。
//  - type=promoter_signup：推廣者在登入頁自行註冊，建立帳號並送出申請，通知管理員審核。
//  - type=promoter_review：管理員核准（建立推廣人、指定代碼）或拒絕申請，並寄信通知申請人。需管理員登入。
//  - type=promoter_add：管理員直接新增推廣者（或替既有推廣人加上登入 Email），免審核；
//    寄「設定密碼」信給對方，由本人設定密碼後登入。需管理員登入。
// 需要的 Secrets：GMAIL_USER、GMAIL_APP_PASSWORD（Gmail 應用程式密碼）
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
const GMAIL_PASS = (Deno.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
const FROM_NAME = "中華科技大學 AI行銷自動化實戰班";
const SITE = "https://netideatw.github.io/cust-ai-marketing/";
// 重設密碼連結只能指回這些後台網址，避免被拿來做釣魚連結
const ADMIN_PAGES = ["https://netideatw.github.io/cust-ai-marketing/admin.html", "http://localhost:8765/admin.html"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^[A-Za-z0-9_-]{1,20}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
// 各梯次上課期間（錄取通知用）
const BATCH_DATES: Record<string, string> = {
  "實戰班（一）": "115/12/07（一）至 116/01/22（四）",
  "實戰班（二）": "116/03/02（一）至 116/04/19（日）",
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
function mailer() {
  if (!GMAIL_USER || !GMAIL_PASS) throw new Error("尚未設定 GMAIL_USER / GMAIL_APP_PASSWORD");
  // Supabase 函式封鎖 25/587 port，使用 465（SSL）
  transport ??= nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  return transport;
}
function send(to: string | string[], subject: string, html: string) {
  return mailer().sendMail({ from: { name: FROM_NAME, address: GMAIL_USER }, to, subject, html });
}
// 寄信失敗不影響主要動作（註冊、審核），只記錄
async function trySend(to: string | string[], subject: string, html: string) {
  try { await send(to, subject, html); return "sent"; } catch (e) { console.log("mail error", (e as Error).message); return "error"; }
}
// 給學員的信附上系統信提醒與聯絡人；給管理員的信不附
const FOOTER = `
  <div style="margin-top:28px;padding:14px 16px;background:#F6F5FB;border-radius:10px;font-size:13px;line-height:1.8;color:#625E83">
    <b style="color:#16123A">※ 本信由系統自動寄出，請勿直接回覆；回覆此信將無法收到。</b><br>
    如有任何問題，歡迎洽中華科技大學 就服組聯絡人：<br>
    林小姐　(02) 2782-1862 轉 202　<a href="mailto:ci1847@gm.cust.edu.tw" style="color:#4B3BFF">ci1847@gm.cust.edu.tw</a><br>
    鄭小姐　(02) 2782-1862 轉 155　<a href="mailto:huichuan@gm.cust.edu.tw" style="color:#4B3BFF">huichuan@gm.cust.edu.tw</a><br>
    地址：台北市南港區研究院路三段 245 號
  </div>`;
const wrap = (inner: string, footer = false) =>
  `<div style="font-family:'Microsoft JhengHei','PingFang TC',sans-serif;font-size:15px;line-height:1.7;color:#16123A;max-width:560px">${inner}${footer ? FOOTER : ""}</div>`;
const table = (rows: [string, unknown][]) =>
  `<table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#625E83;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;white-space:pre-line">${esc(v)}</td></tr>`).join("")}</table>`;
const button = (href: string, text: string) =>
  `<p style="margin:22px 0"><a href="${href}" style="background:#4B3BFF;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700">${text}</a></p>`;
const A = (href: string, text: string) => `<a href="${href}" style="color:#4B3BFF;font-weight:700">${text}</a>`;
const hl = (inner: string) =>
  `<div style="margin:20px 0;padding:18px 20px;border:2px solid #FF6B3D;border-radius:12px;background:#FFF6F2">${inner}</div>`;

// 甄選流程（已收到報名信用）
function stepsBlock() {
  const li = (t: string) => `<li style="margin:0 0 8px">${t}</li>`;
  return `
  <p style="margin:18px 0 6px"><b>甄選流程</b></p>
  <ol style="margin:0;padding-left:22px">
    ${li("<b>線上填寫表單資格審查</b>：年齡、學歷、身分與報名課程班級。（您已完成）")}
    ${li("<b>通過初選後提供基本資料</b>：一天內以 Email 通知基本審查結果，並附資料上傳網址，請於 5 天內上網上傳身分證、畢業證書等資料。")}
    ${li("<b>面談評估</b>：學習態度、溝通合作與投入意願，面試日期另行通知（資料補齊後以電話通知）；面試當天請帶齊申請表、成績單、個資同意書，並現場填寫基本資料。")}
    ${li("<b>公告錄取</b>：公告錄取與候補名單，開課前 3 天寄送錄取通知。")}
  </ol>`;
}

async function findUser(email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find((x) => (x.email || "").toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) return null;
  }
  return null;
}
async function notifyAdmins() {
  const { data } = await db.from("admins").select("email").eq("notify", true);
  return (data || []).map((a) => a.email);
}
// 確認呼叫者是已登入的管理員，回傳其 Email；不是則回傳空字串
async function adminEmail(req: Request) {
  const caller = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: me } = await caller.auth.getUser();
  const { data: isAdmin } = await caller.rpc("am_i_admin");
  return me?.user && isAdmin === true ? (me.user.email || "").toLowerCase() : "";
}
// 建立「設定密碼」連結（沒有帳號時先建立無密碼帳號）
async function passwordLink(email: string, page: string) {
  if (!ADMIN_PAGES.includes(page)) page = ADMIN_PAGES[0];
  let created = false;
  if (!(await findUser(email))) {
    const { error } = await db.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw new Error("建立帳號失敗：" + error.message);
    created = true;
  }
  const { data, error } = await db.auth.admin.generateLink({ type: "recovery", email });
  if (error || !data?.properties?.hashed_token) throw new Error("產生設定密碼連結失敗");
  return { link: `${page}?type=recovery&token_hash=${encodeURIComponent(data.properties.hashed_token)}`, created };
}

async function onRegistration(id: string) {
  // 先搬佔 notified_at，確保每筆只寄一次
  const { data: r } = await db.from("registrations").update({ notified_at: new Date().toISOString() })
    .eq("id", id).is("notified_at", null).select("*").maybeSingle();
  if (!r) return { skipped: true };

  let promoter = "（直接報名）";
  if (r.ref) {
    const { data: p } = await db.from("promoters").select("name").eq("code", r.ref).maybeSingle();
    promoter = p ? `${p.name}（${r.ref}）` : `${r.ref}（未登記）`;
  }
  const results: Record<string, string> = {};

  // 給報名者：已收到報名資料，一天內通知基本審查結果（實際由 reg-remind 於報名滿 3 小時寄出，對外不寫）
  try {
    await send(r.email, "【已收到報名資料】一天內通知基本審查結果｜AI行銷自動化與服務創新實戰班", wrap(
      `<p>${esc(r.name)} 您好：</p>
      <p>感謝您報名「AI行銷自動化與服務創新實戰班」！系統已收到您的線上報名資料。</p>
      ${hl(`<p style="margin:0 0 6px;font-size:17px"><b>下一步：請留意 Email</b></p>
        <p style="margin:0">我們會在 <b>一天內</b>寄信通知基本審查結果。通過後信中會附上您的<b>專屬補件網址</b>，請再上網上傳身分證、畢業證書等資料。</p>
        <p style="margin:10px 0 0;font-size:13px;color:#625E83">沒收到信請查看「垃圾郵件」或「促銷內容」資料夾，並將寄件者設為「非垃圾郵件」。</p>`)}
      ${stepsBlock()}
      <p style="margin-top:22px"><b>您填寫的報名資料</b></p>
      ${table([["報名班別", r.batch], ["姓名", r.name], ["出生日期", r.birth_date || "—"], ["聯絡電話", r.phone], ["Email", r.email], ["LINE ID", r.line],
        ["最高學歷／學校", r.school], ["畢業科系", r.dept], ["畢業（預計）日期", r.grad_date || "—"]])}
      <p style="margin-top:18px">課程資訊：<a href="${SITE}">${SITE}</a></p>`, true));
    results.applicant = "sent";
  } catch (e) { results.applicant = "error: " + (e as Error).message; }

  // 給有開啟「接收通知信」的管理員
  try {
    const to = await notifyAdmins();
    if (to.length) {
      const rows: [string, unknown][] = [["報名時間", new Date(r.created_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })], ["報名班別", r.batch],
        ["姓名", r.name], ["出生日期", r.birth_date || "—"], ["聯絡電話", r.phone], ["Email", r.email], ["LINE ID", r.line], ["最高學歷／學校", r.school],
        ["畢業科系", r.dept], ["畢業（預計）日期", r.grad_date || "—"], ["可配合時程", (r.consents || []).join("、") || "—"],
        ["得知管道", (r.channels || []).join("、")], ["推廣人", promoter]];
      if (r.note) rows.push(["留言", r.note]);
      await send(to, `新報名：${r.name}（${r.batch}）`, wrap(
        `<p>收到一筆新報名：</p>
        ${table(rows)}
        <p style="margin-top:18px">系統會在一天內寄出「通過基本審查」信與補件網址，補件狀態可在後台報名名單查看。</p>
        <p><a href="${SITE}admin.html">前往報名後台</a></p>`));
      results.admins = "sent to " + to.length;
    } else results.admins = "none subscribed";
  } catch (e) { results.admins = "error: " + (e as Error).message; }

  console.log("registration", id, JSON.stringify(results));
  return results;
}

// 管理員寄面試通知／錄取通知
type Notice = { id?: string; date?: string; time?: string; place?: string; note?: string; result?: string };
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
async function onInterview(req: Request, b: Notice) {
  if (!(await adminEmail(req))) return json({ error: "沒有管理員權限" }, 403);
  if (!UUID_RE.test(String(b.id))) return json({ error: "找不到這筆報名" }, 400);
  const date = clip(b.date, 40), time = clip(b.time, 40), place = clip(b.place, 120), note = clip(b.note, 500);
  if (!date || !time || !place) return json({ error: "請填寫面試日期、時間與地點" }, 400);
  const { data: r } = await db.from("registrations").select("id,name,email,batch").eq("id", String(b.id)).maybeSingle();
  if (!r) return json({ error: "找不到這筆報名" }, 404);
  const mail = await trySend(r.email, `【面試通知】${date} ${time}｜AI行銷自動化與服務創新實戰班`, wrap(
    `<p>${esc(r.name)} 您好：</p>
    <p>感謝您補齊報名資料！您報名的「AI行銷自動化與服務創新實戰班」（${esc(r.batch)}）已進入<b>面談評估</b>，面試資訊如下：</p>
    ${hl(table([["面試日期", date], ["面試時間", time], ["面試地點", place], ...(note ? [["注意事項", note] as [string, unknown]] : [])]))}
    <p style="margin:18px 0 6px"><b>面試當天請攜帶並補交：</b></p>
    <ol style="margin:0;padding-left:22px">
      <li style="margin:0 0 6px">培訓學員申請表（填寫後親筆簽名）：${A(SITE + "assets/apply-form.docx", "下載 Word 檔")}</li>
      <li style="margin:0 0 6px">最高學歷學校成績單影本</li>
      <li style="margin:0 0 6px">蒐集個人資料告知事項暨個人資料提供同意書（填寫日期並親簽或蓋章）：${A(SITE + "assets/personal-data-consent.docx", "下載 Word 檔")}</li>
    </ol>
    <p>另外會請您在現場填寫基本資料（兵役狀況、工作經驗、申請動機、AI 工具使用經驗）。</p>
    <p>面談將評估學習態度、溝通合作與投入意願，請準時出席。如無法出席，請儘早來電告知。</p>`, true));
  if (mail !== "sent") return json({ error: "寄信失敗，請稍後再試" }, 500);
  const info = `${date} ${time}／${place}${note ? `／${note}` : ""}`;
  const at = new Date().toISOString();
  await db.from("registrations").update({ interview_sent_at: at, interview_info: info }).eq("id", r.id);
  return json({ ok: true, interview_sent_at: at, interview_info: info });
}
async function onAdmit(req: Request, b: Notice) {
  if (!(await adminEmail(req))) return json({ error: "沒有管理員權限" }, 403);
  if (!UUID_RE.test(String(b.id))) return json({ error: "找不到這筆報名" }, 400);
  const result = b.result === "候補" ? "候補" : "錄取";
  const place = clip(b.place, 120), time = clip(b.time, 60), note = clip(b.note, 500);
  const { data: r } = await db.from("registrations").select("id,name,email,batch").eq("id", String(b.id)).maybeSingle();
  if (!r) return json({ error: "找不到這筆報名" }, 404);
  const period = BATCH_DATES[r.batch] || "";
  const rows: [string, unknown][] = [["班別", r.batch]];
  if (period) rows.push(["上課期間", period]);
  if (time) rows.push(["報到時間", time]);
  if (place) rows.push(["上課地點", place]);
  if (note) rows.push(["注意事項", note]);
  const html = result === "錄取"
    ? `<p>${esc(r.name)} 您好：</p>
      <p>恭喜您！您已<b>正式錄取</b>「AI行銷自動化與服務創新實戰班」。開課資訊如下：</p>
      ${hl(table(rows))}
      <p>本課程須全程參加，出席達 90% 才算完訓並可領取獎勵金，請準時報到。如確定無法參加，請儘早來電告知，以便通知候補學員。</p>`
    : `<p>${esc(r.name)} 您好：</p>
      <p>感謝您參加「AI行銷自動化與服務創新實戰班」甄選。您目前列為<b>候補</b>，如有錄取學員放棄，我們會依候補順序以電話與 Email 通知您遞補。</p>
      ${hl(table(rows))}`;
  const mail = await trySend(r.email, result === "錄取"
    ? `【錄取通知】恭喜錄取 ${r.batch}｜AI行銷自動化與服務創新實戰班`
    : `【候補通知】${r.batch}｜AI行銷自動化與服務創新實戰班`, wrap(html, true));
  if (mail !== "sent") return json({ error: "寄信失敗，請稍後再試" }, 500);
  const at = new Date().toISOString();
  await db.from("registrations").update({ admit_sent_at: at, admit_result: result }).eq("id", r.id);
  return json({ ok: true, admit_sent_at: at, admit_result: result });
}

async function onForgot(email: string, page: string) {
  email = email.trim().toLowerCase();
  const { data: row } = await db.from("admins").select("email").eq("email", email).maybeSingle();
  const { data: prow } = await db.from("promoters").select("code").eq("email", email).maybeSingle();
  if (!row && !prow) return; // 不是管理員也不是推廣者：不寄信，也不透露結果

  let res;
  try { res = await passwordLink(email, page); } catch (e) { console.log("forgot:", (e as Error).message); return; }
  const role = row ? "管理員" : "推廣者";
  const intro = res.created
    ? `您已開通「AI行銷自動化實戰班 報名後台」的${role}帳號。請在 1 小時內點下方按鈕，設定您的登入密碼：`
    : "我們收到您重設「AI行銷自動化實戰班 報名後台」密碼的申請。請在 1 小時內點下方按鈕設定新密碼：";
  await send(email, res.created ? `【報名後台】設定您的${role}密碼` : "【報名後台】重設密碼", wrap(
    `<p>您好：</p><p>${intro}</p>${button(res.link, "設定密碼")}
    <p style="font-size:13px;color:#625E83">連結過期時，請到後台登入頁按「忘記密碼／第一次登入？」重新申請。如果不是您本人申請，請忽略這封信。</p>`));
  console.log("forgot: sent to", role, res.created ? "(first time)" : "");
}

// 推廣者自行註冊：建立登入帳號＋申請紀錄（待審核），審核通過前登入不到任何資料
type Signup = { name?: string; email?: string; phone?: string; note?: string; password?: string };
async function onPromoterSignup(b: Signup) {
  const email = String(b.email || "").trim().toLowerCase();
  const name = String(b.name || "").trim();
  const phone = String(b.phone || "").replace(/[\s()-]/g, "");
  const note = String(b.note || "").trim();
  const password = String(b.password || "");
  if (!name || name.length > 30) return json({ error: "請填寫姓名或單位名稱（30 字內）" }, 400);
  if (!EMAIL_RE.test(email) || email.length > 80) return json({ error: "Email 格式不正確" }, 400);
  if (!/^0\d{8,9}$/.test(phone)) return json({ error: "請填寫正確的聯絡電話" }, 400);
  if (note.length > 300) return json({ error: "推廣方式說明請在 300 字內" }, 400);
  if (password.length < 8 || password.length > 72) return json({ error: "密碼需 8～72 個字元" }, 400);

  const { data: p } = await db.from("promoters").select("code").eq("email", email).maybeSingle();
  if (p) return json({ error: "這個 Email 已經是推廣者，請直接登入。" }, 400);
  const { data: a } = await db.from("admins").select("email").eq("email", email).maybeSingle();
  if (a) return json({ error: "這個 Email 已有後台帳號，請直接登入。" }, 400);
  const { data: app } = await db.from("promoter_applications").select("status").eq("email", email).maybeSingle();
  if (app?.status === "pending") return json({ error: "這個 Email 已送出申請，正在等候管理員審核。" }, 400);

  const { error: cErr } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (cErr) {
    if (cErr.status === 422 || /already/i.test(cErr.message)) return json({ error: "這個 Email 已經註冊過，請直接登入。" }, 400);
    return json({ error: "註冊失敗，請稍後再試。" }, 500);
  }
  const { error: iErr } = await db.from("promoter_applications").upsert({
    email, name, phone, note, status: "pending", created_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null, code: null,
  }, { onConflict: "email" });
  if (iErr) {
    const u = await findUser(email);
    if (u) await db.auth.admin.deleteUser(u.id);
    return json({ error: "註冊失敗，請稍後再試。" }, 500);
  }

  await trySend(email, "【推廣者註冊】已收到您的申請", wrap(
    `<p>${esc(name)} 您好：</p><p>我們已收到您的「AI行銷自動化實戰班」推廣者註冊申請。管理員審核通過後會再寄信通知您，屆時即可用註冊的 Email 與密碼登入後台，取得專屬推廣連結。</p>`, true));
  const to = await notifyAdmins();
  if (to.length) await trySend(to, `新推廣者申請：${name}`, wrap(
    `<p>有一位新的推廣者申請，請到後台「推廣人成效」審核：</p>
    ${table([["姓名／單位", name], ["Email", email], ["聯絡電話", phone], ["推廣方式", note || "—"]])}
    <p style="margin-top:18px"><a href="${SITE}admin.html">前往後台審核</a></p>`));
  return json({ ok: true });
}

// 管理員審核推廣者申請
type Review = { id?: string; decision?: string; code?: string; name?: string };
async function onPromoterReview(req: Request, b: Review) {
  const reviewer = await adminEmail(req);
  if (!reviewer) return json({ error: "沒有管理員權限" }, 403);

  const { data: app } = await db.from("promoter_applications").select("*").eq("id", String(b.id || "")).maybeSingle();
  if (!app) return json({ error: "找不到這筆申請" }, 404);
  if (app.status !== "pending") return json({ error: "這筆申請已經審核過了" }, 400);
  const now = new Date().toISOString();

  if (b.decision === "approve") {
    const code = String(b.code || "").trim();
    const name = String(b.name || app.name).trim();
    if (!CODE_RE.test(code)) return json({ error: "代碼只能用英數字、_ 或 -（20 字內）" }, 400);
    if (!name || name.length > 30) return json({ error: "請填寫推廣人名稱（30 字內）" }, 400);
    const { data: dup } = await db.from("promoters").select("code").eq("code", code).maybeSingle();
    if (dup) return json({ error: `代碼「${code}」已有人使用，請換一個` }, 400);
    const { error: pErr } = await db.from("promoters").insert({ code, name, email: app.email });
    if (pErr) return json({ error: "建立推廣人失敗：" + pErr.message }, 500);
    await db.from("promoter_applications").update({ status: "approved", code, reviewed_at: now, reviewed_by: reviewer }).eq("id", app.id);
    const link = `${SITE}?ref=${encodeURIComponent(code)}`;
    await trySend(app.email, "【推廣者審核通過】可以開始推廣了", wrap(
      `<p>${esc(name)} 您好：</p><p>您的推廣者申請已通過審核！請用註冊的 Email 與密碼登入後台，即可隨時查看推廣成效。</p>
      ${table([["您的專屬推廣連結", link], ["推廣代碼", code]])}
      ${button(SITE + "admin.html", "登入推廣者後台")}`, true));
    return json({ ok: true });
  }

  if (b.decision === "reject") {
    await db.from("promoter_applications").update({ status: "rejected", reviewed_at: now, reviewed_by: reviewer }).eq("id", app.id);
    // 刪除登入帳號，對方之後可以再重新申請（管理員或其他推廣人的帳號不動）
    const { data: a } = await db.from("admins").select("email").eq("email", app.email).maybeSingle();
    const { data: p } = await db.from("promoters").select("code").eq("email", app.email).maybeSingle();
    if (!a && !p) { const u = await findUser(app.email); if (u) await db.auth.admin.deleteUser(u.id); }
    await trySend(app.email, "【推廣者申請】審核結果通知", wrap(
      `<p>${esc(app.name)} 您好：</p><p>感謝您申請成為「AI行銷自動化實戰班」推廣者。很抱歉，這次的申請未能通過審核。如有疑問，歡迎與我們聯繫。</p>`, true));
    return json({ ok: true });
  }
  return json({ error: "未知的動作" }, 400);
}

// 管理員直接新增推廣者：新代碼→建立推廣人；既有代碼且尚無帳號→加上登入 Email。免審核，寄設定密碼信。
type Add = { code?: string; name?: string; email?: string; page?: string };
async function onPromoterAdd(req: Request, b: Add) {
  const by = await adminEmail(req);
  if (!by) return json({ error: "沒有管理員權限" }, 403);
  const code = String(b.code || "").trim();
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  if (!CODE_RE.test(code)) return json({ error: "代碼只能用英數字、_ 或 -（20 字內）" }, 400);
  if (!EMAIL_RE.test(email) || email.length > 80) return json({ error: "Email 格式不正確" }, 400);

  const { data: other } = await db.from("promoters").select("code").eq("email", email).maybeSingle();
  if (other) return json({ error: `這個 Email 已經是推廣人「${other.code}」的登入帳號` }, 400);
  const { data: p } = await db.from("promoters").select("code,name,email").eq("code", code).maybeSingle();
  let finalName = name;
  if (p) {
    if (p.email) return json({ error: `代碼「${code}」已有人使用，請換一個` }, 400);
    finalName = p.name;
    const { error } = await db.from("promoters").update({ email }).eq("code", code);
    if (error) return json({ error: "加入帳號失敗：" + error.message }, 500);
  } else {
    if (!name || name.length > 30) return json({ error: "請填寫推廣人名稱（30 字內）" }, 400);
    const { error } = await db.from("promoters").insert({ code, name, email });
    if (error) return json({ error: "新增推廣人失敗：" + error.message }, 500);
  }
  // 同一個 Email 若有待審核的申請，一併標為通過
  await db.from("promoter_applications").update({ status: "approved", code, reviewed_at: new Date().toISOString(), reviewed_by: by })
    .eq("email", email).eq("status", "pending");

  const link = `${SITE}?ref=${encodeURIComponent(code)}`;
  const hadAccount = !!(await findUser(email));
  let mail: string;
  if (hadAccount) {
    mail = await trySend(email, "【推廣者帳號】您已加入推廣者", wrap(
      `<p>${esc(finalName)} 您好：</p><p>管理員已將您加入「AI行銷自動化實戰班」推廣者。請用原本的 Email 與密碼登入後台，即可查看推廣成效。</p>
      ${table([["您的專屬推廣連結", link], ["推廣代碼", code]])}
      ${button(SITE + "admin.html", "登入推廣者後台")}`, true));
  } else {
    let pl;
    try { pl = await passwordLink(email, String(b.page || "")); } catch (e) { return json({ ok: true, mail: "error", detail: (e as Error).message }); }
    mail = await trySend(email, "【推廣者帳號】請設定您的登入密碼", wrap(
      `<p>${esc(finalName)} 您好：</p><p>管理員已為您開通「AI行銷自動化實戰班」推廣者帳號。請在 1 小時內點下方按鈕設定密碼，之後就能登入後台查看推廣成效。</p>
      ${table([["登入帳號", email], ["您的專屬推廣連結", link], ["推廣代碼", code]])}
      ${button(pl.link, "設定密碼")}
      <p style="font-size:13px;color:#625E83">連結過期時，請到後台登入頁按「忘記密碼／第一次登入？」重新申請。</p>`, true));
  }
  return json({ ok: true, existed: hadAccount, mail });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: { type?: string; id?: string; email?: string; page?: string } & Signup & Review & Add & Notice;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  try {
    if (body.type === "registration" && UUID_RE.test(String(body.id))) {
      return json(await onRegistration(String(body.id)));
    }
    if (body.type === "interview") return await onInterview(req, body);
    if (body.type === "admit") return await onAdmit(req, body);
    if (body.type === "forgot" && typeof body.email === "string" && body.email.length <= 80) {
      await onForgot(body.email, String(body.page || ""));
      return json({ ok: true }); // 無論是否為名單內帳號都回傳相同結果
    }
    if (body.type === "promoter_signup") return await onPromoterSignup(body);
    if (body.type === "promoter_review") return await onPromoterReview(req, body);
    if (body.type === "promoter_add") return await onPromoterAdd(req, body);
  } catch (e) {
    console.log("notify error", (e as Error).message);
    return json({ ok: false, error: "系統忙碌，請稍後再試" }, 500);
  }
  return json({ error: "bad request" }, 400);
});
