-- Run after the migration, with a database management connection.
-- Every test write is rolled back. Existing dates are never overwritten.
begin;
do $$
declare
  sid integer;
  other_sid integer;
  d date := date '1900-01-10';
  baseline jsonb := '{"beef":{"closing":10,"thaw":20,"extra":0,"waste":0,"target":null},"pork":{"closing":10,"thaw":20,"extra":0,"waste":0,"target":null},"chicken":{"closing":10,"thaw":20,"extra":0,"waste":0,"target":null}}';
  nightly jsonb := '{"beef":{"closing":8,"thaw":25,"extra":0,"waste":0,"target":null},"pork":{"closing":8,"thaw":25,"extra":0,"waste":0,"target":null},"chicken":{"closing":8,"thaw":25,"extra":0,"waste":0,"target":null}}';
  first_id uuid := gen_random_uuid();
  result jsonb;
  changed jsonb;
  before_count bigint;
  now_count bigint;
  denied boolean;
begin
  select store_id into strict sid from public.stores where store_name = '木崎(C2)';
  select store_id into other_sid from public.stores where store_id <> sid order by store_id limit 1;
  if exists (select 1 from public.meat_inventory_days where store_id = sid and business_date between d - 1 and d + 5) then
    raise exception 'Test dates already have data; choose another unused test window.';
  end if;
  select count(*) into before_count from public.meat_inventory_days;
  assert public.muki_meats_valid(baseline), 'valid portions rejected';
  assert not public.muki_meats_valid(baseline - 'chicken'), 'missing meat accepted';
  assert not public.muki_meats_valid(jsonb_set(baseline, '{beef,closing}', 'null')), 'null closing accepted';
  assert not public.muki_meats_valid(jsonb_set(baseline, '{beef,extra}', '-1')), 'negative extra accepted';
  assert not public.muki_meats_valid(jsonb_set(baseline, '{beef,thaw}', '0.01')), 'excess decimal precision accepted';

  result := public.save_muki_meat_day(sid,d,baseline,'QA rollback',0,first_id);
  assert (result ->> 'version')::integer = 1, 'new row version';
  result := public.save_muki_meat_day(sid,d,baseline,'QA rollback',0,first_id);
  assert (result ->> 'version')::integer = 1, 'retry changed version';
  select count(*) into now_count from public.meat_inventory_days;
  assert now_count = before_count + 1, 'duplicate retry inserted a row';

  denied := false;
  begin
    perform public.save_muki_meat_day(sid,d,nightly,'QA rollback',0,first_id);
  exception when serialization_failure then denied := true;
  end;
  assert denied, 'same request id accepted different content';
  denied := false;
  begin
    perform public.save_muki_meat_day(sid,d,baseline,'QA rollback',0,gen_random_uuid());
  exception when serialization_failure then denied := true;
  end;
  assert denied, 'stale version overwrote a row';

  result := public.save_muki_meat_day(sid,d+1,nightly,'QA rollback',0,gen_random_uuid());
  assert (result ->> 'version')::integer = 1, 'next day not saved';
  assert 10 + 20 - (result -> 'meats' -> 'beef' ->> 'closing')::numeric = 22, 'usage arithmetic';
  changed := jsonb_set(nightly, '{beef,thaw}', '40');
  result := public.save_muki_meat_day(sid,d+1,changed,'QA rollback',1,gen_random_uuid());
  assert (result ->> 'version')::integer = 2, 'edited row version';
  assert 10 + 20 - (result -> 'meats' -> 'beef' ->> 'closing')::numeric = 22, 'tonight thaw affected today usage';
  assert (result -> 'meats' -> 'beef' ->> 'closing')::numeric + (result -> 'meats' -> 'beef' ->> 'thaw')::numeric = 48, 'tomorrow stock';

  denied := false;
  begin
    perform public.save_muki_meat_day(sid,d+1,jsonb_set(changed,'{beef,closing}','31'),'QA rollback',2,gen_random_uuid());
  exception when invalid_parameter_value then denied := true;
  end;
  assert denied, 'negative current usage accepted';
  denied := false;
  begin
    perform public.save_muki_meat_day(sid,d,jsonb_set(jsonb_set(baseline,'{beef,closing}','0'),'{beef,thaw}','0'),'QA rollback',1,gen_random_uuid());
  exception when invalid_parameter_value then denied := true;
  end;
  assert denied, 'historical edit made next usage negative';

  changed := jsonb_set(baseline,'{beef,closing}','100');
  perform public.save_muki_meat_day(sid,d+3,changed,'QA rollback',0,gen_random_uuid());
  -- No previous day: a new baseline is accepted without inventing daily usage.
  denied := false;
  begin
    perform public.save_muki_meat_day(other_sid,d,baseline,'QA rollback',0,gen_random_uuid());
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'another store used the RPC';
  denied := false;
  begin
    perform public.save_muki_meat_day(sid,(now() at time zone 'Asia/Taipei')::date+1,baseline,'QA rollback',0,gen_random_uuid());
  exception when invalid_parameter_value then denied := true;
  end;
  assert denied, 'future date accepted';
  assert not has_table_privilege('anon','public.meat_inventory_days','SELECT'), 'anon can read meat';
  assert not has_function_privilege('anon','public.save_muki_meat_day(integer,date,jsonb,text,integer,uuid)','EXECUTE'), 'anon can invoke save';
  assert not has_column_privilege('anon','public.stores','password','SELECT'), 'anon can read branch passwords';
  assert not has_column_privilege('authenticated','public.stores','password','UPDATE'), 'authenticated can replace branch passwords';
  assert has_column_privilege('anon','public.stores','store_name','SELECT'), 'branch directory no longer readable';
end;
$$;
rollback;
select 'All database assertions passed; test writes rolled back.' as verification;
