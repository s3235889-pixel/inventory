-- Run after the delivery migration with a database management connection.
-- This script aborts if its historical test month has any existing data.
-- All inserts, updates, deletion markers and temporary objects are ROLLED BACK.
begin;
do $$
declare
  id1 uuid := gen_random_uuid();
  id2 uuid := gen_random_uuid();
  id3 uuid := gen_random_uuid();
  id4 uuid := gen_random_uuid();
  request1 uuid := gen_random_uuid();
  request2 uuid := gen_random_uuid();
  fingerprint1 text := repeat('a', 64);
  fingerprint2 text := repeat('b', 64);
  path1 text;
  path2 text;
  payload jsonb := '{"unit_name":"QA rollback","address":"測試地址","courier":"測試人員","delivered_at":"1900-01-31T16:00:00Z","amount":1200.50,"distance_km":3.25}';
  changed jsonb;
  result jsonb;
  month_result jsonb;
  denied boolean;
  before_count bigint;
begin
  if exists (select 1 from public.delivery_records where delivered_at >= timestamptz '1900-01-01 00:00:00+08'
    and delivered_at < timestamptz '1900-04-01 00:00:00+08') then
    raise exception 'Delivery QA dates already have data; choose an unused test interval.';
  end if;
  select count(*) into before_count from public.delivery_records;
  path1 := '1/' || id1 || '/' || gen_random_uuid() || '-' || repeat('c',64) || '.jpg';
  path2 := '1/' || id1 || '/' || gen_random_uuid() || '-' || repeat('d',64) || '.png';

  result := public.save_delivery_record(1,id1,request1,0,payload,path1,false,fingerprint1);
  assert (result -> 'record' ->> 'version')::integer = 1, 'new record version';
  assert (result -> 'record' ->> 'has_photo')::boolean, 'saved photo indicator';
  assert not (result -> 'record' ? 'photo_path'), 'raw storage path exposed in public record';
  result := public.save_delivery_record(1,id1,request1,0,payload,path2,false,fingerprint1);
  assert (result -> 'record' ->> 'version')::integer = 1, 'identical retry changed version';
  assert result ->> 'photo_path' = path1, 'retry replaced committed photo';
  assert (select count(*) from public.delivery_records) = before_count + 1, 'retry duplicated record';

  denied := false;
  begin
    perform public.save_delivery_record(1,id1,request1,0,payload,path2,false,fingerprint2);
  exception when serialization_failure then denied := true;
  end;
  assert denied, 'same request ID accepted a changed fingerprint';
  denied := false;
  begin
    perform public.save_delivery_record(2,id1,gen_random_uuid(),1,payload,null,false,fingerprint2);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'another store updated this record';
  denied := false;
  begin
    perform public.delete_delivery_record(2,id1,1);
  exception when no_data_found then denied := true;
  end;
  assert denied, 'another store deleted this record';

  changed := jsonb_set(payload, '{amount}', '1500.75');
  result := public.save_delivery_record(1,id1,request2,1,changed,path2,false,fingerprint2);
  assert (result -> 'record' ->> 'version')::integer = 2, 'edit version';
  assert result ->> 'photo_path' = path2, 'replacement photo missing';
  assert result -> 'unused_photo_paths' = jsonb_build_array(path1), 'old photo was not returned for cleanup';
  -- Simulate a lost response to request1, a later successful update, then retry1.
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,request1,0,payload,path1,false,fingerprint1);
  exception when serialization_failure then denied := true;
  end;
  assert denied, 'old ambiguous retry overwrote a later update';
  assert (select photo_path from public.delivery_records where id=id1) = path2, 'old retry changed new photo';
  denied := false;
  begin
    perform public.delete_delivery_record(1,id1,1);
  exception when serialization_failure then denied := true;
  end;
  assert denied, 'stale deletion erased a later update';

  -- Taiwan midnight 2/1 is January 31, 16:00 UTC; 2/28 23:59 is included.
  perform public.save_delivery_record(1,id2,gen_random_uuid(),0,
    jsonb_set(payload,'{delivered_at}','"1900-02-28T15:59:59Z"'),null,false,fingerprint1);
  perform public.save_delivery_record(1,id3,gen_random_uuid(),0,
    jsonb_set(payload,'{delivered_at}','"1900-01-31T15:59:59Z"'),null,false,fingerprint1);
  perform public.save_delivery_record(1,id4,gen_random_uuid(),0,
    jsonb_set(payload,'{delivered_at}','"1900-02-28T16:00:00Z"'),null,false,fingerprint1);
  perform public.save_delivery_record(2,gen_random_uuid(),gen_random_uuid(),0,payload,null,false,fingerprint1);
  month_result := public.load_delivery_records(1,'1900-02',0);
  assert (month_result ->> 'total_count')::integer = 2, 'Taiwan month boundary or store isolation failed';
  assert (month_result ->> 'total_amount')::numeric = 2701.25, 'monthly amount sum';
  assert (month_result ->> 'total_distance_km')::numeric = 6.50, 'monthly distance sum';
  assert jsonb_array_length(month_result -> 'records') = 2, 'record composite serialization failed';
  assert month_result -> 'records' -> 0 ->> 'id' = id2::text, 'descending delivery time';
  assert (public.load_delivery_records(2,'1900-02',0) ->> 'total_count')::integer = 1, 'store2 saw store1 records';

  -- Multiple pages still return whole-month totals; page two is not truncated or duplicated.
  insert into public.delivery_records
    (id, store_id, unit_name, address, courier, delivered_at, amount, distance_km, last_request_id, last_request_fingerprint)
    select gen_random_uuid(),1,'QA page','測試地址','測試人員',timestamptz '1900-02-15 12:00+08'+n*interval '1 minute',
      1,1,gen_random_uuid(),fingerprint1 from generate_series(1,51) n;
  month_result := public.load_delivery_records(1,'1900-02',0);
  assert (month_result ->> 'total_count')::integer = 53, 'monthly count did not include all pages';
  assert jsonb_array_length(month_result -> 'records') = 50, 'first page size';
  assert jsonb_array_length(public.load_delivery_records(1,'1900-02',1) -> 'records') = 3, 'second page size';
  assert (public.load_delivery_records(1,'1900-02',1) ->> 'total_amount')::numeric = 2752.25, 'page2 total is not whole-month total';

  result := public.delete_delivery_record(1,id1,2);
  assert (result ->> 'ok')::boolean, 'delete not acknowledged';
  assert result ->> 'photo_path' = path2, 'deleted photo not scheduled for cleanup';
  result := public.delete_delivery_record(1,id1,2);
  assert (result ->> 'ok')::boolean, 'delete retry is not idempotent';
  assert (public.load_delivery_records(1,'1900-02',0) ->> 'total_count')::integer = 52, 'deleted record still visible';
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,request2,1,changed,path2,false,fingerprint2);
  exception when serialization_failure then denied := true;
  end;
  assert denied, 'retry resurrected a deleted record';

  denied := false;
  begin
    perform public.save_delivery_record(1,gen_random_uuid(),gen_random_uuid(),0,jsonb_set(payload,'{amount}','-1'),null,false,fingerprint1);
  exception when check_violation then denied := true;
  end;
  assert denied, 'negative amount accepted';
  denied := false;
  begin
    perform public.save_delivery_record(1,gen_random_uuid(),gen_random_uuid(),0,jsonb_set(payload,'{distance_km}','1.001'),null,false,fingerprint1);
  exception when check_violation then denied := true;
  end;
  assert denied, 'excess distance precision accepted';
  denied := false;
  begin
    perform public.save_delivery_record(1,gen_random_uuid(),gen_random_uuid(),0,jsonb_set(payload,'{unit_name}','" "'),null,false,fingerprint1);
  exception when check_violation then denied := true;
  end;
  assert denied, 'blank unit accepted';
  denied := false;
  begin
    perform public.load_delivery_records(3,'1900-02',0);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'disallowed store loaded data';
  assert not has_table_privilege('anon','public.delivery_records','SELECT'), 'anon can read delivery records';
  assert not has_table_privilege('authenticated','public.delivery_records','INSERT'), 'authenticated can bypass delivery API';
  assert not has_function_privilege('anon','public.load_delivery_records(integer,text,integer)','EXECUTE'), 'anon can invoke load';
  assert not has_function_privilege('authenticated','public.save_delivery_record(integer,uuid,uuid,integer,jsonb,text,boolean,text)','EXECUTE'), 'authenticated can invoke save';
  assert not has_function_privilege('anon','public.delete_delivery_record(integer,uuid,integer)','EXECUTE'), 'anon can invoke delete';
  assert (select relrowsecurity from pg_class where oid='public.delivery_records'::regclass), 'RLS not enabled';
  assert exists(select 1 from storage.buckets where id='delivery-photos' and not public and file_size_limit=8388608), 'private bounded bucket missing';
  assert exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='delivery_photos_private' and permissive='RESTRICTIVE'), 'private bucket defense policy missing';
end;
$$;
rollback;
select 'Delivery database assertions passed; every test write was rolled back.' as verification;
