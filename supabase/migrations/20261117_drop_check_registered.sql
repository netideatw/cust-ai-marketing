-- 移除公開的「查詢 Email／電話是否已報名」函式：
-- 任何人都能用 anon key 呼叫 /rest/v1/rpc/check_registered 查某人有沒有報名，屬於個資洩漏。
-- 重複報名改由 registrations_no_duplicate 觸發器在新增時阻擋（回傳 DUPLICATE_REGISTRATION）。
drop function if exists public.check_registered(text, text);
