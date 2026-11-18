-- 報名學歷檢查：從網站（匿名）新增報名時，最高學歷看起來是高中職以下就拒絕。
-- 判斷字詞與報名表、後台一致：高中、高職、國中、國小、中學、高商、高工、高農、職業學校。
-- 只擋網站匿名送出；管理員從垃圾桶還原舊資料不受影響。既有報名不會被改動。
create or replace function private.block_low_education()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if coalesce((select auth.role()), '') = 'anon'
     and coalesce(new.school, '') ~ '(高中|高職|國中|國小|中學|高商|高工|高農|職業學校)' then
    raise exception 'EDU_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.block_low_education() from public, anon, authenticated;

drop trigger if exists registrations_low_education on public.registrations;
create trigger registrations_low_education
  before insert on public.registrations
  for each row execute function private.block_low_education();
