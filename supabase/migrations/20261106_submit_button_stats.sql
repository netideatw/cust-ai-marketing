-- 數據分析：「送出報名」按鈕另外統計（按下次數、按的人數，每日與合計），與成功送出的報名數比較
create or replace function public.site_stats(p_from date, p_to date, p_ref text default null::text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_admin boolean := private.is_admin();
  v_ref text := p_ref;
  v_all boolean;
  t0 timestamptz;
  t1 timestamptz;
  res jsonb;
begin
  if not v_admin then
    v_ref := private.my_promoter_code();
    if v_ref is null then raise exception 'no permission' using errcode = '42501'; end if;
  end if;
  v_all := v_ref is null;
  t0 := (p_from::timestamp) at time zone 'Asia/Taipei';
  t1 := ((p_to + 1)::timestamp) at time zone 'Asia/Taipei';

  with ev as (
    select e.*, (e.created_at at time zone 'Asia/Taipei')::date d from public.site_events e
    where e.created_at >= t0 and e.created_at < t1
      and (v_all or coalesce(e.ref,'') = v_ref)
  ), rg as (
    select r.ref, (r.created_at at time zone 'Asia/Taipei')::date d from public.registrations r
    where r.created_at >= t0 and r.created_at < t1
      and (v_all or coalesce(r.ref,'') = v_ref)
  ), dc as (
    -- 資料都交齊：身分證與畢業證書都有上傳（與後台名單「已補齊」同一標準；申請表、成績單、同意書改面試時補交），日期算最後一項首次上傳的時間
    select r.ref, (c.done_at at time zone 'Asia/Taipei')::date d
    from public.registrations r
    join lateral (
      select max(x.first_at) done_at, count(*) n from (
        select rd.doc_type, min(rd.created_at) first_at from public.reg_documents rd
        where rd.registration_id = r.id and rd.doc_type in ('id_card','diploma')
        group by rd.doc_type
      ) x
    ) c on c.n = 2
    where c.done_at >= t0 and c.done_at < t1
      and (v_all or coalesce(r.ref,'') = v_ref)
  ), sb as (
    -- 按下「送出報名」按鈕（不論欄位是否填對都算）
    select * from ev where type = 'click' and target = '送出報名'
  ), days as (
    select generate_series(p_from, p_to, interval '1 day')::date d
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'views', (select count(*) from ev where type='view'),
      'visitors', (select count(distinct vid) from ev where type='view'),
      'clicks', (select count(*) from ev where type='click'),
      'click_visitors', (select count(distinct vid) from ev where type='click'),
      'form_starts', (select count(distinct vid) from ev where type='form_start'),
      'apply_clicks', (select count(distinct vid) from ev where type='click' and target like '報名按鈕%' and target <> '報名按鈕・資格檢測'),
      'submit_clicks', (select count(*) from sb),
      'submit_visitors', (select count(distinct vid) from sb),
      'regs', (select count(*) from rg),
      'docs_done', (select count(*) from dc)),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('d', days.d,
        'views', (select count(*) from ev where ev.d=days.d and type='view'),
        'visitors', (select count(distinct vid) from ev where ev.d=days.d and type='view'),
        'clicks', (select count(*) from ev where ev.d=days.d and type='click'),
        'submit_clicks', (select count(*) from sb where sb.d=days.d),
        'submit_visitors', (select count(distinct vid) from sb where sb.d=days.d),
        'regs', (select count(*) from rg where rg.d=days.d),
        'docs_done', (select count(*) from dc where dc.d=days.d)) order by days.d), '[]'::jsonb) from days),
    'targets', (select coalesce(jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc), '[]'::jsonb)
        from (select coalesce(target,'其他') k, count(*) n from ev where type='click' group by 1) x),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc), '[]'::jsonb)
        from (select coalesce(nullif(src,''),'直接開啟') k, count(*) n from ev where type='view' group by 1 limit 15) x),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc), '[]'::jsonb)
        from (select coalesce(device,'desktop') k, count(*) n from ev where type='view' group by 1) x),
    'by_ref', case when v_admin and v_all then (select coalesce(jsonb_agg(jsonb_build_object('ref', ref, 'views', views, 'visitors', visitors, 'clicks', clicks, 'regs', regs, 'docs_done', docs_done) order by regs desc, views desc), '[]'::jsonb)
        from (select y.ref, sum(y.views)::bigint views, sum(y.visitors)::bigint visitors, sum(y.clicks)::bigint clicks, sum(y.regs)::bigint regs, sum(y.docs_done)::bigint docs_done
              from (
                select coalesce(ref,'') ref, count(*) filter (where type='view') views, count(distinct vid) filter (where type='view') visitors, count(*) filter (where type='click') clicks, 0::bigint regs, 0::bigint docs_done from ev group by 1
                union all select coalesce(ref,''), 0, 0, 0, count(*), 0 from rg group by 1
                union all select coalesce(ref,''), 0, 0, 0, 0, count(*) from dc group by 1
              ) y group by y.ref) x) end
  ) into res;
  return res;
end;
$function$;
