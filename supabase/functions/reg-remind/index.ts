// 報名後續自動通知：由資料庫排程每 10 分鐘呼叫一次（POST {"run":true}）。
//  1. 通過基本審查：報名滿 3 小時，寄「通過基本審查＋專屬補件網址」，補件期限 5 天（網站對外說「一天內」通知）
//  2. 補件提醒：寄出通過信後第 3 天、第 5 天，資料仍未補齊各寄一次提醒
//     （管理員延長期限後，會在新期限截止當天早上再寄一次提醒）
// 每封信都先在資料庫登記再寄出，重複呼叫不會重複寄信；已補齊、已過期的不寄。
// 只處理「上傳制」上線後的報名（CUTOFF 之後）。
// POST {"dry":true} 只回傳「哪些報名該寄哪一封、信件主旨」，不登記也不寄信（測試用，不含個資）。
// 需要的 Secrets：GMAIL_USER、GMAIL_APP_PASSWORD
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const SITE = "https://netideatw.github.io/cust-ai-marketing/";
const CUTOFF = "2026-10-28T00:00:00+08:00";
const H = 36e5, D = 24 * H;
const PASS_AFTER = 3 * H;     // 報名後 3 小時寄通過基本審查信
const UPLOAD_DAYS = 5;        // 補件期限：通過信寄出後 5 天
const TYPES: Record<string, string> = {
  profile: "補件基本資料（兵役、學經歷、申請動機、AI 使用經驗）",
  apply: "培訓學員申請表", id_card: "身分證正反面影本", diploma: "最高學歷畢業證書影本",
  transcript: "最高學歷學校成績單影本", consent: "蒐集個人資料告知事項暨個人資料提供同意書",
};
// 目前線上只需上傳身分證與畢業證書；申請表、成績單、同意書與基本資料改為面試時補交
const REQUIRED_DOCS = ["id_card", "diploma"];
const PROFILE_REQUIRED = false;
const AT_INTERVIEW = "<b>以下資料請於面試當天補交，現在不用上傳：</b>培訓學員申請表（親簽）、最高學歷學校成績單影本、蒐集個人資料告知事項暨個人資料提供同意書（親簽）；基本資料（兵役、工作經驗、申請動機、AI 使用經驗）於面試時現場填寫。";
const FORMS: Record<string, [string, string]> = {
  apply: [SITE + "assets/apply-form.docx", "https://docs.google.com/document/d/13A2HUMK96Dju0EVPpYTAFk_MixmDxw50/edit"],
  consent: [SITE + "assets/personal-data-consent.docx", "https://docs.google.com/document/d/190yYhbrJzegnpUmVRbxTZqecghTatAkZ/edit?usp=sharing&ouid=107156929840842688192&rtpof=true&sd=true"],
};

const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
const GMAIL_PASS = (Deno.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
function send(to: string, subject: string, html: string) {
  if (!GMAIL_USER || !GMAIL_PASS) throw new Error("尚未設定 GMAIL_USER / GMAIL_APP_PASSWORD");
  transport ??= nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  return transport.sendMail({ from: { name: "中華科技大學 AI行銷自動化實戰班", address: GMAIL_USER }, to, subject, html });
}
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const A = (href: string, text: string) => `<a href="${href}" style="color:#4B3BFF;font-weight:700">${text}</a>`;

// 台灣時間各欄位
function tw(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: p.month, d: p.day, hh: p.hour, mm: p.minute };
}
const twText = (d: Date) => { const t = tw(d); return `${t.y - 1911}/${t.m}/${t.d} ${t.hh}:${t.mm}`; };
// 截止當天台灣時間 09:00；截止在 10:00 前則提前 12 小時（延長期限後的提醒用）
function finalAt(deadline: Date) {
  const t = tw(deadline);
  const nine = new Date(`${t.y}-${t.m}-${t.d}T09:00:00+08:00`);
  return deadline.getTime() - nine.getTime() >= H ? nine : new Date(deadline.getTime() - 12 * H);
}

const FOOTER = `
    <div style="margin-top:24px;padding:14px 16px;background:#F6F5FB;border-radius:10px;font-size:13px;line-height:1.8;color:#625E83">
      <b style="color:#16123A">※ 本信由系統自動寄出，請勿直接回覆。</b><br>
      如有任何問題，歡迎洽中華科技大學 就服組：林小姐 (02) 2782-1862 轉 202、鄭小姐 轉 155<br>
      <a href="mailto:ci1847@gm.cust.edu.tw" style="color:#4B3BFF">ci1847@gm.cust.edu.tw</a>、<a href="mailto:huichuan@gm.cust.edu.tw" style="color:#4B3BFF">huichuan@gm.cust.edu.tw</a>
    </div>`;
const wrap = (inner: string) =>
  `<div style="font-family:'Microsoft JhengHei','PingFang TC',sans-serif;font-size:15px;line-height:1.7;color:#16123A;max-width:560px">${inner}${FOOTER}</div>`;
const itemLi = (k: string) =>
  `<li style="margin:0 0 6px">${TYPES[k]}${FORMS[k] ? `：${A(FORMS[k][0], "下載 Word 檔")}　${A(FORMS[k][1], "Google 文件")}` : ""}</li>`;
const uploadUrl = (r: Reg) => `${SITE}upload.html?id=${encodeURIComponent(r.id)}&t=${encodeURIComponent(r.upload_token)}`;
const box = (title: string, items: string[], url: string, btn: string) => `
    <div style="margin:18px 0;padding:16px 20px;border:2px solid #FF6B3D;border-radius:12px;background:#FFF6F2">
      <p style="margin:0 0 8px"><b>${title}</b></p>
      <ul style="margin:0;padding-left:22px">${items.map(itemLi).join("")}</ul>
      <p style="margin:22px 0 6px"><a href="${url}" style="background:#4B3BFF;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700">${btn}</a></p>
      <p style="margin:12px 0 0;font-size:13px;color:#625E83">※ 此網址為您專屬，請勿轉寄給他人。按鈕無法點選時，請複製這個網址到瀏覽器開啟：<br>${esc(url)}</p>
    </div>`;

// 通過基本審查信
function passMail(r: Reg, deadline: Date) {
  const subject = "【通過基本審查】請於 5 天內上網補齊報名資料｜AI行銷自動化與服務創新實戰班";
  const html = wrap(`
    <p>${esc(r.name)} 您好：</p>
    <p>恭喜您！您報名「AI行銷自動化與服務創新實戰班」（${esc(r.batch)}）的線上資格審查<b>已通過基本審查</b>。</p>
    <p>下一步請點下方按鈕進入您的專屬補件頁，於 <b>${twText(deadline)}</b> 前補齊下列資料，資料補齊後我們會以<b>電話通知面試</b>。</p>
    ${box("請上傳以下資料：", [...(PROFILE_REQUIRED ? ["profile"] : []), ...REQUIRED_DOCS], uploadUrl(r), "上網補齊報名資料")}
    <p style="font-size:14px;margin:0 0 14px;padding:12px 14px;background:#F6F5FB;border-radius:10px">${AT_INTERVIEW}</p>
    <p style="font-size:14px;color:#625E83">文件可掃描或用手機拍照上傳（PDF、JPG、PNG 或 Word 檔，每個檔案 10MB 以內），可以分次上傳。有工作經驗者請另附勞工保險異動紀錄。</p>
    <p style="margin:18px 0 6px"><b>接下來的流程</b></p>
    <ol style="margin:0;padding-left:22px">
      <li style="margin:0 0 6px"><b>補齊資料</b>：上網上傳身分證、畢業證書等資料。</li>
      <li style="margin:0 0 6px"><b>面談評估</b>：資料補齊後以電話通知面試時間，面試當天請帶齊申請表、成績單、個資同意書。</li>
      <li style="margin:0 0 6px"><b>公告錄取</b>：開課前 3 天寄送錄取通知。</li>
    </ol>`);
  return { subject, html };
}

// 補件提醒信（第 3 天、第 5 天、延長期限後）
function remindMail(kind: 1 | 2, r: Reg, missing: string[]) {
  const deadline = new Date(r.upload_deadline);
  const subject = kind === 1
    ? `【提醒】報名資料還缺 ${missing.length} 項尚未補齊，請於 ${twText(deadline)} 前上網補齊｜AI行銷實戰班`
    : `【再次提醒】報名資料還缺 ${missing.length} 項，${tw(deadline).m}/${tw(deadline).d} ${tw(deadline).hh}:${tw(deadline).mm} 截止｜AI行銷實戰班`;
  const days = Math.max(1, Math.ceil((deadline.getTime() - Date.now()) / D));
  const lead = kind === 1
    ? `您已通過「AI行銷自動化與服務創新實戰班」基本審查，但報名資料<b>還沒有補齊</b>。補件期限是 <b>${twText(deadline)}</b>（剩不到 ${days} 天）。`
    : `您的報名資料<b>仍未補齊</b>，補件期限 <b>${twText(deadline)}</b> 就快到了，逾期將無法補件，也無法安排面試。`;
  const html = wrap(`
    <p>${esc(r.name)} 您好：</p>
    <p>${lead}</p>
    ${box("目前還缺：", missing, uploadUrl(r), "上網補齊報名資料")}
    <p>已經填寫或上傳的項目不用重做，只要補上缺少的部分即可。如果您已決定不報名，請忽略這封信。</p>`);
  return { subject, html };
}

type Reg = {
  id: string; name: string; email: string; batch: string; upload_token: string; created_at: string; upload_deadline: string;
  pass_at: string | null; profile_at: string | null; remind1_at: string | null; remind2_at: string | null; remind2_deadline: string | null;
};
const COLS = "id,name,email,batch,upload_token,created_at,upload_deadline,pass_at,profile_at,remind1_at,remind2_at,remind2_deadline";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: { run?: boolean; dry?: boolean } = {};
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const dry = body?.dry === true;
  if (!dry && body?.run !== true) return json({ error: "bad request" }, 400);

  const now = Date.now();
  const out: { id: string; kind: string; result: string; subject?: string }[] = [];

  // ── 1. 報名滿 3 小時：寄「通過基本審查」＋補件網址 ──
  const { data: fresh, error: e1 } = await db.from("registrations").select(COLS)
    .is("pass_at", null).not("notified_at", "is", null)
    .lte("created_at", new Date(now - PASS_AFTER).toISOString()).gte("created_at", CUTOFF).limit(100);
  if (e1) return json({ error: e1.message }, 500);
  for (const r of (fresh || []) as Reg[]) {
    const deadline = new Date(now + UPLOAD_DAYS * D);
    if (dry) { out.push({ id: r.id, kind: "pass", result: "due", subject: passMail(r, deadline).subject }); continue; }
    const { data: got } = await db.from("registrations")
      .update({ pass_at: new Date(now).toISOString(), upload_deadline: deadline.toISOString() })
      .eq("id", r.id).is("pass_at", null).select("id").maybeSingle();
    if (!got) continue;
    try {
      const m = passMail(r, deadline);
      await send(r.email, m.subject, m.html);
      out.push({ id: r.id, kind: "pass", result: "sent" });
    } catch (e) {
      await db.from("registrations").update({ pass_at: null }).eq("id", r.id);
      out.push({ id: r.id, kind: "pass", result: "error" });
      console.log("pass error", r.id, (e as Error).message);
    }
  }

  // ── 2. 補件提醒：通過信後第 3 天、第 5 天 ──
  const { data: regs, error } = await db.from("registrations").select(COLS)
    .is("docs_complete_at", null).not("pass_at", "is", null).gt("upload_deadline", new Date(now).toISOString())
    .gte("created_at", CUTOFF).limit(300);
  if (error) return json({ error: error.message }, 500);
  const list = (regs || []) as Reg[];
  const { data: docs } = list.length
    ? await db.from("reg_documents").select("registration_id,doc_type").in("registration_id", list.map((r) => r.id))
    : { data: [] };

  for (const r of list) {
    const missing = [
      ...(r.profile_at || !PROFILE_REQUIRED ? [] : ["profile"]),
      ...REQUIRED_DOCS.filter((k) => !(docs || []).some((d) => d.registration_id === r.id && d.doc_type === k)),
    ];
    if (!missing.length) continue;
    const pass = new Date(r.pass_at!).getTime();
    const deadline = new Date(r.upload_deadline);
    // 第 5 天提醒：這個期限還沒寄過才寄；寄過後若管理員延長期限，於新期限截止當天早上再寄
    const finalSent = !!r.remind2_deadline && new Date(r.remind2_deadline).getTime() === deadline.getTime();
    const finalDue = r.remind2_at ? finalAt(deadline).getTime() : Math.min(pass + 5 * D, finalAt(deadline).getTime());
    let kind: 1 | 2 | 0 = 0;
    if (!finalSent && now >= finalDue) kind = 2;
    else if (!r.remind1_at && now >= pass + 3 * D) kind = 1;
    if (!kind) continue;
    if (dry) { out.push({ id: r.id, kind: "remind" + kind, result: "due", subject: remindMail(kind, r, missing).subject }); continue; }

    const claim = kind === 1
      ? db.from("registrations").update({ remind1_at: new Date().toISOString() }).eq("id", r.id).is("remind1_at", null)
      : db.from("registrations").update({ remind2_at: new Date().toISOString(), remind2_deadline: r.upload_deadline, remind1_at: r.remind1_at || new Date().toISOString() })
        .eq("id", r.id).eq("upload_deadline", r.upload_deadline);
    const { data: got } = await claim.select("id").maybeSingle();
    if (!got) continue;
    try {
      const m = remindMail(kind, r, missing);
      await send(r.email, m.subject, m.html);
      out.push({ id: r.id, kind: "remind" + kind, result: "sent" });
    } catch (e) {
      await db.from("registrations").update(kind === 1 ? { remind1_at: null } : { remind2_at: r.remind2_at, remind2_deadline: r.remind2_deadline, remind1_at: r.remind1_at }).eq("id", r.id);
      out.push({ id: r.id, kind: "remind" + kind, result: "error" });
      console.log("remind error", r.id, (e as Error).message);
    }
  }
  console.log("reg-remind", JSON.stringify(out));
  return json({ fresh: (fresh || []).length, checked: list.length, results: out });
});
