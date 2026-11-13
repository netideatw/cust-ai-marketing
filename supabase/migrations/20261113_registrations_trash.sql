-- 報名資料垃圾桶：後台刪除報名時，整筆資料與已上傳檔案的紀錄先移到垃圾桶，
-- 管理員可在後台查看、還原或永久刪除。檔案本身留在檔案空間，永久刪除時才移除。
create table if not exists public.registrations_trash (
  id uuid primary key,                       -- 原報名編號
  deleted_at timestamptz not null default now(),
  deleted_by text,                           -- 刪除的管理員 Email
  data jsonb not null,                       -- 刪除當下的整筆報名資料
  docs jsonb not null default '[]'::jsonb    -- 刪除當下的上傳檔案紀錄
);
alter table public.registrations_trash enable row level security;
revoke all on public.registrations_trash from anon, authenticated;
grant select, delete on public.registrations_trash to authenticated;
create policy "admins read trash" on public.registrations_trash for select to authenticated using ((select private.is_admin()));
create policy "admins purge trash" on public.registrations_trash for delete to authenticated using ((select private.is_admin()));

-- 刪除報名前先備份到垃圾桶（檔案紀錄要在連帶刪除前取得，所以用 before delete）
create or replace function private.archive_registration()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  insert into public.registrations_trash (id, deleted_by, data, docs)
  values (old.id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''), to_jsonb(old),
          coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.reg_documents d where d.registration_id = old.id), '[]'::jsonb))
  on conflict (id) do update set deleted_at = now(), deleted_by = excluded.deleted_by, data = excluded.data, docs = excluded.docs;
  return old;
end;
$$;
drop trigger if exists registrations_to_trash on public.registrations;
create trigger registrations_to_trash before delete on public.registrations
  for each row execute function private.archive_registration();

-- 還原：把報名與檔案紀錄放回去（同 Email／電話已重新報名時會被擋下）
create or replace function public.restore_registration(p_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare t public.registrations_trash;
begin
  if not private.is_admin() then raise exception 'no permission' using errcode = '42501'; end if;
  select * into t from public.registrations_trash where id = p_id;
  if not found then raise exception 'NOT_IN_TRASH' using errcode = 'P0002'; end if;
  insert into public.registrations select (jsonb_populate_record(null::public.registrations, t.data)).*;
  insert into public.reg_documents select (jsonb_populate_record(null::public.reg_documents, x)).*
    from jsonb_array_elements(t.docs) x
    on conflict do nothing;
  delete from public.registrations_trash where id = p_id;
end;
$$;
revoke execute on function public.restore_registration(uuid) from public, anon;
grant execute on function public.restore_registration(uuid) to authenticated;
