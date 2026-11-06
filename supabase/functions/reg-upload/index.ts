// 報名補件：報名者通過基本審查後，用專屬連結（報名 id＋上傳 token）在期限內補齊資料。
//  - info：取得報名者姓名、期限、已填的補件基本資料與已上傳檔案
//  - profile：儲存補件基本資料（兵役、工作經驗、申請動機、AI 使用經驗）
//  - sign：取得一次性的上傳網址（檔案直接傳到私人檔案空間）
//  - confirm：上傳完成後登記
//  - delete：期限內可刪除傳錯的檔案
// 補件基本資料＋必備文件第一次全部齊全時，寄信通知報名者與管理員。
// 需要的 Secrets：GMAIL_USER、GMAIL_APP_PASSWORD
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const BUCKET = "reg-docs";
const SITE = "https://netideatw.github.io/cust-ai-marketing/";
const MAX = 10 * 1024 * 1024;
const MAX_PER_TYPE = 6;
const EXT = ["pdf", "jpg", "jpeg", "png", "heic", "heif", "webp", "doc", "docx"];
// 必備資料（labor 為有工作經驗者才需要）
const TYPES: Record<string, string> = {
  apply: "培訓學員申請表", id_card: "身分證正反面影本", diploma: "最高學歷畢業證書影本",
  transcript: "最高學歷成績單影本", consent: "個人資料提供同意書", labor: "勞工保險異動紀錄",
};
// 目前線上只需上傳身分證與畢業證書；申請表、成績單、同意書與基本資料改為面試時補交（PROFILE_REQUIRED 改 true、加回項目即可恢復）
const REQUIRED = ["id_card", "diploma"];
const PROFILE_REQUIRED = false;
const MILITARY = ["已服役", "尚未服役", "免役", "不適用"];
const UUID = /^[0-9a-f-]{36}$/i;

const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
const GMAIL_PASS = (Deno.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
async function trySend(to: string | string[], subject: string, html: string) {
  if (!GMAIL_USER || !GMAIL_PASS) return;
  try {
    await nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_PASS } })
      .sendMail({ from: { name: "中華科技大學 AI行銷自動化實戰班", address: GMAIL_USER }, to, subject,
        html: `<div style="font-family:'Microsoft JhengHei','PingFang TC',sans-serif;font-size:15px;line-height:1.7;color:#16123A;max-width:560px">${html}</div>` });
  } catch (e) { console.log("mail error", (e as Error).message); }
}

type Reg = {
  id: string; name: string; email: string; phone: string; batch: string; upload_deadline: string; docs_complete_at: string | null;
  pass_at: string | null; profile_at: string | null; military: string | null; work_exp: string; motivation: string; ai_exp: string;
};
// 以 id＋token 確認是報名者本人的連結
async function findReg(id: unknown, t: unknown): Promise<Reg | null> {
  if (!UUID.test(String(id)) || !UUID.test(String(t))) return null;
  const { data } = await db.from("registrations")
    .select("id,name,email,phone,batch,upload_deadline,docs_complete_at,pass_at,profile_at,military,work_exp,motivation,ai_exp")
    .eq("id", String(id)).eq("upload_token", String(t)).maybeSingle();
  return data as Reg | null;
}
const expired = (r: Reg) => Date.now() > new Date(r.upload_deadline).getTime();
async function docs(id: string) {
  const { data } = await db.from("reg_documents").select("id,doc_type,file_name,size,created_at")
    .eq("registration_id", id).order("created_at");
  return data || [];
}
const missing = (r: Reg, list: { doc_type: string }[]) =>
  [...(r.profile_at || !PROFILE_REQUIRED ? [] : ["profile"]), ...REQUIRED.filter((k) => !list.some((d) => d.doc_type === k))];
const profile = (r: Reg) => ({ military: r.military || "", work_exp: r.work_exp || "", motivation: r.motivation || "", ai_exp: r.ai_exp || "", saved_at: r.profile_at });
function state(r: Reg, list: Awaited<ReturnType<typeof docs>>, complete: boolean) {
  return { ok: true, docs: list, missing: missing(r, list), complete, profile: profile(r) };
}

// 資料第一次全部補齊：記錄時間並寄信；之後刪到不齊則清除
async function syncComplete(r: Reg, list: { doc_type: string }[]) {
  const done = missing(r, list).length === 0;
  if (done && !r.docs_complete_at) {
    const { data } = await db.from("registrations").update({ docs_complete_at: new Date().toISOString() })
      .eq("id", r.id).is("docs_complete_at", null).select("id").maybeSingle();
    if (!data) return true;
    r.docs_complete_at = new Date().toISOString();
    await trySend(r.email, "【資料已補齊】AI行銷自動化與服務創新實戰班",
      `<p>${esc(r.name)} 您好：</p><p>我們已收到您補齊的報名資料，感謝您！接下來將進行<b>面談評估</b>，我們會以電話（${esc(r.phone)}）通知您面試時間，請留意來電。</p>
      <p style="font-size:13px;color:#625E83">※ 本信由系統自動寄出，請勿直接回覆。如有問題請洽就服組 (02) 2782-1862 轉 202／155。</p>`);
    const { data: admins } = await db.from("admins").select("email").eq("notify", true);
    const to = (admins || []).map((a) => a.email);
    if (to.length) await trySend(to, `報名資料已補齊：${r.name}（${r.batch}）`,
      `<p>${esc(r.name)}（${esc(r.batch)}，電話 ${esc(r.phone)}）已補齊報名資料，請電話通知面試，並到後台寄送面試通知：</p><p><a href="${SITE}admin.html">前往報名後台</a></p>`);
  } else if (!done && r.docs_complete_at) {
    await db.from("registrations").update({ docs_complete_at: null }).eq("id", r.id);
    r.docs_complete_at = null;
  }
  return done;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "格式錯誤" }, 400); }

  try {
    const r = await findReg(b.id, b.t);
    if (!r) return json({ error: "補件連結無效，請確認是否完整複製信中的網址。" }, 404);
    if (!r.pass_at) return json({ error: "您的報名正在進行基本審查，通過後會寄出補件網址，請留意 Email。" }, 403);

    if (b.action === "info") {
      const list = await docs(r.id);
      return json({ name: r.name, batch: r.batch, deadline: r.upload_deadline, expired: expired(r), ...state(r, list, !!r.docs_complete_at) });
    }

    if (expired(r)) return json({ error: "已超過補件期限，請聯絡就業服務組 (02) 2782-1862 轉 202／155。" }, 403);

    if (b.action === "profile") {
      const p = (b.profile || {}) as Record<string, unknown>;
      const military = String(p.military || "");
      const work = String(p.work_exp || "").trim(), mot = String(p.motivation || "").trim(), ai = String(p.ai_exp || "").trim();
      if (!MILITARY.includes(military)) return json({ error: "請選擇兵役狀況" }, 400);
      if (work.length > 500) return json({ error: "工作經驗請在 500 字內" }, 400);
      if (mot.length < 10 || mot.length > 800) return json({ error: "申請動機請填寫 10～800 字" }, 400);
      if (!ai || ai.length > 800) return json({ error: "請填寫 AI 工具使用經驗（800 字內，沒有經驗請填「無」）" }, 400);
      const at = new Date().toISOString();
      const { error } = await db.from("registrations").update({ military, work_exp: work, motivation: mot, ai_exp: ai, profile_at: at }).eq("id", r.id);
      if (error) return json({ error: "儲存失敗，請稍後再試" }, 500);
      Object.assign(r, { military, work_exp: work, motivation: mot, ai_exp: ai, profile_at: at });
      const list = await docs(r.id);
      return json(state(r, list, await syncComplete(r, list)));
    }

    if (b.action === "sign") {
      const type = String(b.doc_type || "");
      const name = String(b.file_name || "").slice(0, 200);
      const size = Number(b.size || 0);
      const ext = (name.split(".").pop() || "").toLowerCase();
      if (!TYPES[type]) return json({ error: "未知的資料類別" }, 400);
      if (!EXT.includes(ext)) return json({ error: "只接受 PDF、JPG、PNG、HEIC、Word 檔" }, 400);
      if (!(size > 0) || size > MAX) return json({ error: "每個檔案需小於 10MB" }, 400);
      const { count } = await db.from("reg_documents").select("id", { count: "exact", head: true }).eq("registration_id", r.id).eq("doc_type", type);
      if ((count || 0) >= MAX_PER_TYPE) return json({ error: `「${TYPES[type]}」最多上傳 ${MAX_PER_TYPE} 個檔案` }, 400);
      const path = `${r.id}/${type}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) return json({ error: "無法建立上傳，請稍後再試" }, 500);
      return json({ path, token: data.token });
    }

    if (b.action === "confirm") {
      const path = String(b.path || "");
      const type = path.split("/")[1] || "";
      if (!path.startsWith(r.id + "/") || !TYPES[type]) return json({ error: "檔案路徑錯誤" }, 400);
      const dir = path.slice(0, path.lastIndexOf("/"));
      const file = path.slice(path.lastIndexOf("/") + 1);
      const { data: found } = await db.storage.from(BUCKET).list(dir, { search: file });
      const obj = (found || []).find((o) => o.name === file);
      if (!obj) return json({ error: "找不到上傳的檔案，請重新上傳" }, 400);
      const size = Number((obj.metadata as { size?: number } | null)?.size || 0);
      if (size > MAX) { await db.storage.from(BUCKET).remove([path]); return json({ error: "每個檔案需小於 10MB" }, 400); }
      const { error } = await db.from("reg_documents").upsert({
        registration_id: r.id, doc_type: type, file_path: path, file_name: String(b.file_name || file).slice(0, 200), size,
      }, { onConflict: "file_path" });
      if (error) return json({ error: "登記失敗，請重新上傳" }, 500);
      const list = await docs(r.id);
      return json(state(r, list, await syncComplete(r, list)));
    }

    if (b.action === "delete") {
      const { data: d } = await db.from("reg_documents").select("id,file_path").eq("id", String(b.doc_id || "")).eq("registration_id", r.id).maybeSingle();
      if (!d) return json({ error: "找不到這個檔案" }, 404);
      await db.storage.from(BUCKET).remove([d.file_path]);
      await db.from("reg_documents").delete().eq("id", d.id);
      const list = await docs(r.id);
      return json(state(r, list, await syncComplete(r, list)));
    }
  } catch (e) {
    console.log("reg-upload error", (e as Error).message);
    return json({ error: "系統忙碌，請稍後再試" }, 500);
  }
  return json({ error: "未知的動作" }, 400);
});
