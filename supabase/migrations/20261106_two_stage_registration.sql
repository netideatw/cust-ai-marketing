-- 兩階段報名：先線上填表資格審查 → 3 小時後通知通過基本審查並寄補件網址 → 補齊資料 → 面談 → 錄取
alter table public.registrations
  add column if not exists motivation text not null default '',   -- 申請動機（補件頁填寫）
  add column if not exists ai_exp text not null default '',       -- AI 工具使用經驗（補件頁填寫）
  add column if not exists profile_at timestamptz,                -- 補件頁基本資料送出時間
  add column if not exists pass_at timestamptz,                   -- 「通過基本審查＋補件網址」信寄出時間
  add column if not exists interview_sent_at timestamptz,         -- 管理員寄出面試通知的時間
  add column if not exists interview_info text not null default '', -- 面試通知內容（日期、時間、地點）
  add column if not exists admit_sent_at timestamptz,             -- 管理員寄出錄取／候補通知的時間
  add column if not exists admit_result text;                     -- 錄取 或 候補

-- 兵役、工作經驗改到補件頁填寫，第一階段報名不再送出
alter table public.registrations alter column military drop not null;
alter table public.registrations add constraint registrations_motivation_len check (char_length(motivation) <= 800);
alter table public.registrations add constraint registrations_ai_exp_len check (char_length(ai_exp) <= 800);

-- 既有報名已收過舊版「報名成功＋上傳連結」信，視同已通過基本審查，不再寄通過信
update public.registrations set pass_at = coalesce(notified_at, created_at) where pass_at is null;

-- 每 10 分鐘檢查一次（3 小時通過信、第 3／5 天補件提醒）
select cron.alter_job((select jobid from cron.job where jobname = 'reg-upload-reminders'), schedule := '*/10 * * * *');
