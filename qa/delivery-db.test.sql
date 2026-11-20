-- Run after both delivery migrations with a database management connection.
-- This script aborts if its historical test month has any existing data.
-- All inserts, attempted edits, deletion markers and role changes are ROLLED BACK.
begin;
do $$
declare
  id1 uuid := gen_random_uuid();
  id2 uuid := gen_random_uuid();
  id3 uuid := gen_random_uuid();
  id4 uuid := gen_random_uuid();
  legacy_id uuid := gen_random_uuid();
  request1 uuid := gen_random_uuid();
  request2 uuid := gen_random_uuid();
  fingerprint1 text := repeat('a', 64);
  fingerprint2 text := repeat('b', 64);
  path1 text;
  retry_path text;
  replacement_path text;
  addition_path text;
  payload jsonb := '{"unit_name":"QA rollback","address":"測試地址","courier":"測試人員","delivered_at":"1900-01-31T16:00:00Z","amount":1200.50,"distance_km":3.25}';
  second_payload jsonb;
  changed jsonb;
  original_row jsonb;
  result jsonb;
  month_result jsonb;
  field_change record;
  assignment text;
  denied boolean;
  before_count bigint;
begin
  if exists (select 1 from public.delivery_records where delivered_at >= timestamptz '1900-01-01 00:00:00+08'
    and delivered_at < timestamptz '1900-04-01 00:00:00+08') then
    raise exception 'Delivery QA dates already have data; choose an unused test interval.';
  end if;
  select count(*) into before_count from public.delivery_records;
  path1 := '1/' || id1 || '/' || gen_random_uuid() || '-' || repeat('c',64) || '.jpg';
  retry_path := '1/' || id1 || '/' || gen_random_uuid() || '-' || repeat('c',64) || '.jpg';
  replacement_path := '1/' || id1 || '/' || gen_random_uuid() || '-' || repeat('d',64) || '.png';
  addition_path := '1/' || id2 || '/' || gen_random_uuid() || '-' || repeat('c',64) || '.jpg';

  result := public.save_delivery_record(1,id1,request1,0,payload,path1,false,fingerprint1);
  assert (result -> 'record' ->> 'version')::integer = 1, 'new record version';
  assert (result -> 'record' ->> 'has_photo')::boolean, 'saved photo indicator';
  assert not (result -> 'record' ? 'photo_path'), 'raw storage path exposed in public record';
  select to_jsonb(r) into original_row from public.delivery_records r where id=id1;
  result := public.save_delivery_record(1,id1,request1,0,payload,retry_path,false,fingerprint1);
  assert (result -> 'record' ->> 'version')::integer = 1, 'identical retry changed version';
  assert result ->> 'photo_path' = path1, 'retry replaced committed photo';
  assert result -> 'unused_photo_paths' = '[]'::jsonb, 'retry scheduled original photo for cleanup';
  assert (select count(*) from public.delivery_records) = before_count + 1, 'retry duplicated record';

  denied := false;
  begin
    perform public.save_delivery_record(1,id1,request1,0,payload,retry_path,false,fingerprint2);
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'same request ID accepted a changed fingerprint';
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,gen_random_uuid(),0,payload,path1,false,fingerprint1);
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'a new request ID reused an existing record';
  denied := false;
  begin
    perform public.save_delivery_record(2,id1,gen_random_uuid(),0,payload,null,false,fingerprint2);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'another store accessed this record';
  denied := false;
  begin
    perform public.delete_delivery_record(2,id1,1);
  exception when no_data_found then denied := true;
  end;
  assert denied, 'another store deleted this record';

  -- Every recorded field is immutable, even if a caller disguises an edit as a new save.
  for field_change in select key, value from jsonb_each(
    '{"unit_name":"修改單位","address":"修改地址","courier":"修改人員","delivered_at":"1900-02-01T16:00:00Z","amount":1500.75,"distance_km":4.5}'::jsonb)
  loop
    changed := jsonb_set(payload, array[field_change.key], field_change.value);
    denied := false;
    begin
      perform public.save_delivery_record(1,id1,gen_random_uuid(),0,changed,null,false,fingerprint2);
    exception when object_not_in_prerequisite_state then denied := true;
    end;
    assert denied, 'an existing business field was editable: ' || field_change.key;
    denied := false;
    begin
      perform public.save_delivery_record(1,id1,request1,0,changed,path1,false,fingerprint1);
    exception when object_not_in_prerequisite_state then denied := true;
    end;
    assert denied, 'changed payload was misclassified as an exact retry: ' || field_change.key;
  end loop;
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,request1,1,payload,path1,false,fingerprint1);
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'cached page expected_version update was accepted';
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,gen_random_uuid(),0,payload,replacement_path,false,fingerprint2);
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'photo could be replaced';
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,request1,0,payload,replacement_path,false,fingerprint1);
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'changed photo hash was misclassified as an exact retry';
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,request1,0,payload,null,false,fingerprint1);
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'missing photo was misclassified as an exact retry';
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,gen_random_uuid(),0,payload,null,true,fingerprint2);
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'photo could be removed';

  -- Direct service-role writes must hit the same guard, including identity,
  -- metadata-only changes, and attempts to combine an edit with a deletion.
  execute 'set local role service_role';
  assert current_user = 'service_role', 'direct update tests did not use service_role';
  foreach assignment in array array[
    'unit_name = ''修改單位''', 'address = ''修改地址''', 'courier = ''修改人員''',
    'delivered_at = delivered_at + interval ''1 minute''', 'amount = amount + 1', 'distance_km = distance_km + 1',
    'photo_path = null', format('photo_path = %L', replacement_path),
    'id = gen_random_uuid()', 'store_id = 2', 'created_at = created_at + interval ''1 minute''',
    'last_request_id = gen_random_uuid()', 'last_request_fingerprint = repeat(''e'',64)',
    'version = version + 1', 'updated_at = updated_at + interval ''1 minute''', 'deleted_at = clock_timestamp()',
    'unit_name = ''修改單位'', deleted_at = clock_timestamp(), version = version + 1',
    'photo_path = null, deleted_at = clock_timestamp(), version = version + 1'
  ] loop
    denied := false;
    begin
      execute 'update public.delivery_records set ' || assignment || ' where id = $1' using id1;
    exception when object_not_in_prerequisite_state then denied := true;
    end;
    assert denied, 'direct service-role update bypassed immutability: ' || assignment;
  end loop;
  execute 'reset role';
  assert (select to_jsonb(r) from public.delivery_records r where id=id1) = original_row,
    'a refused edit changed the original record or photo';

  -- Taiwan midnight 2/1 is January 31, 16:00 UTC; 2/28 23:59 is included.
  second_payload := jsonb_set(payload,'{delivered_at}','"1900-02-28T15:59:59Z"');
  result := public.save_delivery_record(1,id2,request2,0,second_payload,null,false,fingerprint1);
  assert not (result -> 'record' ->> 'has_photo')::boolean, 'new record without a photo failed';
  result := public.save_delivery_record(1,id2,request2,0,second_payload,null,false,fingerprint1);
  assert (result -> 'record' ->> 'version')::integer = 1, 'no-photo exact retry failed';
  denied := false;
  begin
    perform public.save_delivery_record(1,id2,gen_random_uuid(),0,second_payload,addition_path,false,fingerprint2);
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'photo could be added to a previously uploaded record';
  execute 'set local role service_role';
  denied := false;
  begin
    update public.delivery_records set photo_path=addition_path where id=id2;
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'direct service-role update added a photo';
  execute 'reset role';
  assert (select photo_path is null and version=1 from public.delivery_records where id=id2), 'failed photo addition changed the row';
  perform public.save_delivery_record(1,id3,gen_random_uuid(),0,
    jsonb_set(payload,'{delivered_at}','"1900-01-31T15:59:59Z"'),null,false,fingerprint1);
  perform public.save_delivery_record(1,id4,gen_random_uuid(),0,
    jsonb_set(payload,'{delivered_at}','"1900-02-28T16:00:00Z"'),null,false,fingerprint1);
  perform public.save_delivery_record(2,gen_random_uuid(),gen_random_uuid(),0,payload,null,false,fingerprint1);
  month_result := public.load_delivery_records(1,'1900-02',0);
  assert (month_result ->> 'total_count')::integer = 2, 'Taiwan month boundary or store isolation failed';
  assert (month_result ->> 'total_amount')::numeric = 2401.00, 'monthly amount sum';
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
  assert (public.load_delivery_records(1,'1900-02',1) ->> 'total_amount')::numeric = 2452.00, 'page2 total is not whole-month total';

  denied := false;
  begin
    perform public.delete_delivery_record(1,id1,2);
  exception when serialization_failure then denied := true;
  end;
  assert denied, 'wrong-version deletion was accepted';
  result := public.delete_delivery_record(1,id1,1);
  assert (result ->> 'ok')::boolean, 'delete not acknowledged';
  assert result ->> 'photo_path' = path1, 'deleted photo not scheduled for cleanup';
  result := public.delete_delivery_record(1,id1,1);
  assert (result ->> 'ok')::boolean, 'delete retry is not idempotent';
  assert (select version=2 and deleted_at is not null from public.delivery_records where id=id1), 'delete metadata transition failed';
  assert (select to_jsonb(r) - array['deleted_at','version','updated_at'] from public.delivery_records r where id=id1)
    = original_row - array['deleted_at','version','updated_at'], 'deletion changed immutable data';
  assert (public.load_delivery_records(1,'1900-02',0) ->> 'total_count')::integer = 52, 'deleted record still visible';
  denied := false;
  begin
    perform public.save_delivery_record(1,id1,request1,0,payload,path1,false,fingerprint1);
  exception when serialization_failure then denied := true;
  end;
  assert denied, 'exact retry resurrected a deleted record';
  execute 'set local role service_role';
  denied := false;
  begin
    update public.delivery_records set deleted_at=null,version=1 where id=id1;
  exception when object_not_in_prerequisite_state then denied := true;
  end;
  assert denied, 'direct service-role update resurrected a tombstone';
  execute 'reset role';

  -- Rows that predate this rule may already have a larger version. They remain
  -- deletable using the same RPC and their business data stays unchanged.
  insert into public.delivery_records
    (id,store_id,unit_name,address,courier,delivered_at,amount,distance_km,version,last_request_id,last_request_fingerprint)
    values (legacy_id,1,'QA legacy','測試地址','測試人員',timestamptz '1900-03-01 12:00+08',1,1,4,gen_random_uuid(),fingerprint1);
  result := public.delete_delivery_record(1,legacy_id,4);
  assert (result ->> 'ok')::boolean, 'legacy version could not be deleted';
  assert (select version=5 and deleted_at is not null from public.delivery_records where id=legacy_id), 'legacy deletion transition failed';
  result := public.save_delivery_record(1,gen_random_uuid(),gen_random_uuid(),0,payload,null,false,fingerprint1);
  assert (result -> 'record' ->> 'version')::integer = 1, 'new records could not be added after deletion';

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
  denied := false;
  begin
    perform public.save_delivery_record(3,gen_random_uuid(),gen_random_uuid(),0,payload,null,false,fingerprint1);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'disallowed store created data';
  assert not has_table_privilege('anon','public.delivery_records','SELECT'), 'anon can read delivery records';
  assert not has_table_privilege('anon','public.delivery_records','UPDATE'), 'anon can update delivery records';
  assert not has_table_privilege('authenticated','public.delivery_records','INSERT'), 'authenticated can bypass delivery API';
  assert not has_table_privilege('authenticated','public.delivery_records','UPDATE'), 'authenticated can update delivery records';
  assert not has_function_privilege('anon','public.load_delivery_records(integer,text,integer)','EXECUTE'), 'anon can invoke load';
  assert not has_function_privilege('authenticated','public.save_delivery_record(integer,uuid,uuid,integer,jsonb,text,boolean,text)','EXECUTE'), 'authenticated can invoke save';
  assert not has_function_privilege('anon','public.delete_delivery_record(integer,uuid,integer)','EXECUTE'), 'anon can invoke delete';
  assert not has_function_privilege('anon','public.enforce_delivery_record_immutability()','EXECUTE'), 'anon can invoke the trigger function';
  assert (select relrowsecurity from pg_class where oid='public.delivery_records'::regclass), 'RLS not enabled';
  assert exists(select 1 from storage.buckets where id='delivery-photos' and not public and file_size_limit=8388608), 'private bounded bucket missing';
  assert exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='delivery_photos_private' and permissive='RESTRICTIVE'), 'private bucket defense policy missing';
end;
$$;
rollback;
select 'Delivery database assertions passed; every test write was rolled back.' as verification;
