-- Synthetic vehicle/legacy compatibility QA. Run after all delivery migrations.
-- No existing row is read by identifier or modified; all new rows roll back.
begin;
set local plpgsql.check_asserts = on;
do $$
declare
  personal_id uuid := gen_random_uuid();
  store_id uuid := gen_random_uuid();
  legacy_id uuid := gen_random_uuid();
  personal_request uuid := gen_random_uuid();
  legacy_request uuid := gen_random_uuid();
  photo_request uuid := gen_random_uuid();
  fingerprint text := repeat('a',64);
  photo_hash text := repeat('c',64);
  photo_path text;
  retry_path text;
  payload jsonb := '{"unit_name":"QA vehicle rollback","address":"屏東縣潮州鎮測試路1號","courier":"測試人員","delivered_at":"1902-08-10T04:00:00Z","amount":1200.50,"distance_km":3.25,"vehicle_type":"personal"}';
  result jsonb;
  record_snapshot jsonb;
  legacy_snapshot jsonb;
  candidate jsonb;
  blocked text;
  column_default_value text;
  before_records bigint;
  before_attachments bigint;
  as_service boolean;
begin
  if exists (select 1 from public.delivery_records where delivered_at >= timestamptz '1902-08-01 00:00+08'
    and delivered_at < timestamptz '1902-09-01 00:00+08') then
    raise exception 'Vehicle QA month already has data; choose an unused month.';
  end if;
  select count(*) into before_records from public.delivery_records;
  select count(*) into before_attachments from public.delivery_photo_attachments;
  select column_default into column_default_value from information_schema.columns
    where table_schema='public' and table_name='delivery_records' and column_name='vehicle_type';
  assert column_default_value is null, 'legacy records would receive an invented vehicle default';

  -- A NULL synthetic row models a record saved by the earlier six-field API.
  -- It does not update or assign a vehicle to any preexisting production row.
  insert into public.delivery_records
    (id,store_id,unit_name,address,courier,delivered_at,amount,distance_km,last_request_id,last_request_fingerprint)
    values(legacy_id,1,payload->>'unit_name',payload->>'address',payload->>'courier',
      (payload->>'delivered_at')::timestamptz,1200.50,3.25,legacy_request,fingerprint);
  select to_jsonb(r) into legacy_snapshot from public.delivery_records r where id=legacy_id;
  assert legacy_snapshot->'vehicle_type'='null'::jsonb, 'legacy fixture did not retain NULL';

  execute 'set local role service_role';
  result:=public.save_delivery_record(1,personal_id,personal_request,0,payload,null,false,fingerprint);
  assert result->'record'->>'vehicle_type'='personal', 'personal vehicle missing from save response';
  assert (select vehicle_type from public.delivery_records where id=personal_id)='personal', 'personal vehicle not stored';
  select to_jsonb(r) into record_snapshot from public.delivery_records r where id=personal_id;
  result:=public.save_delivery_record(1,personal_id,personal_request,0,payload,null,false,fingerprint);
  assert result->'record'->>'vehicle_type'='personal' and (result->'record'->>'version')::integer=1,
    'same vehicle exact retry changed data';
  result:=public.save_delivery_record(2,store_id,gen_random_uuid(),0,jsonb_set(payload,'{vehicle_type}','"store"'),null,false,fingerprint);
  assert result->'record'->>'vehicle_type'='store', 'store vehicle missing from store2 save response';
  assert (public.load_delivery_records(2,'1902-08',0)->'records'->0->>'vehicle_type')='store', 'store vehicle missing from query';

  result:=public.save_delivery_record(1,legacy_id,legacy_request,0,payload-'vehicle_type',null,false,fingerprint);
  assert result->'record' ? 'vehicle_type' and result->'record'->'vehicle_type'='null'::jsonb,
    'legacy exact retry rejected or assigned a vehicle';
  assert (select to_jsonb(r) from public.delivery_records r where id=legacy_id)=legacy_snapshot,
    'legacy exact retry changed the original row';
  assert (select value->'vehicle_type'='null'::jsonb
    from jsonb_array_elements(public.load_delivery_records(1,'1902-08',0)->'records')
    where value->>'id'=legacy_id::text), 'legacy query omitted explicit unknown vehicle';

  -- Compare the actual stored value as well as the request fingerprint.
  foreach candidate in array array[jsonb_set(payload,'{vehicle_type}','"store"'),payload-'vehicle_type'] loop
    blocked:=null;
    begin perform public.save_delivery_record(1,personal_id,personal_request,0,candidate,null,false,fingerprint);
    exception when object_not_in_prerequisite_state then blocked:=sqlstate; end;
    assert blocked='55000', 'changed or omitted vehicle was accepted as an exact retry';
  end loop;
  blocked:=null;
  begin perform public.save_delivery_record(1,legacy_id,legacy_request,0,payload,null,false,fingerprint);
  exception when object_not_in_prerequisite_state then blocked:=sqlstate; end;
  assert blocked='55000', 'legacy NULL vehicle could be assigned by a disguised retry';

  foreach candidate in array array[
    payload-'vehicle_type', jsonb_set(payload,'{vehicle_type}','null'),
    jsonb_set(payload,'{vehicle_type}','"bicycle"'), jsonb_set(payload,'{vehicle_type}','["personal","store"]'),
    payload||'{"extra":true}'::jsonb
  ] loop
    blocked:=null;
    begin perform public.save_delivery_record(1,gen_random_uuid(),gen_random_uuid(),0,candidate,null,false,fingerprint);
    exception when invalid_parameter_value then blocked:=sqlstate; end;
    assert blocked='22023', 'new record accepted missing/invalid vehicle or unexpected field';
  end loop;
  blocked:=null;
  begin
    insert into public.delivery_records
      (id,store_id,unit_name,address,courier,delivered_at,amount,distance_km,vehicle_type,last_request_id,last_request_fingerprint)
      values(gen_random_uuid(),1,'QA invalid vehicle','測試地址','測試人員',timestamptz '1902-08-10 12:00+08',1,1,'bicycle',gen_random_uuid(),fingerprint);
  exception when check_violation then blocked:=sqlstate; end;
  assert blocked='23514', 'direct insert bypassed vehicle enum constraint';
  blocked:=null;
  begin perform public.save_delivery_record(2,personal_id,personal_request,0,payload,null,false,fingerprint);
  exception when insufficient_privilege then blocked:=sqlstate; end;
  assert blocked='42501', 'other store could confirm a vehicle record';

  -- Late receipt paths return the selected vehicle without changing the row.
  photo_path:='1/'||personal_id||'/'||gen_random_uuid()||'-'||photo_hash||'.jpg';
  result:=public.attach_delivery_record_photo(1,personal_id,photo_request,1,photo_hash,photo_path);
  assert result->'record'->>'vehicle_type'='personal' and (result->'record'->>'has_photo')::boolean,
    'late receipt forgot selected vehicle';
  result:=public.save_delivery_record(1,personal_id,personal_request,0,payload,null,false,fingerprint);
  assert result->'record'->>'vehicle_type'='personal' and (result->'record'->>'has_photo')::boolean,
    'original retry after receipt did not preserve selected vehicle';
  photo_path:='1/'||legacy_id||'/'||gen_random_uuid()||'-'||photo_hash||'.jpg';
  result:=public.attach_delivery_record_photo(1,legacy_id,gen_random_uuid(),1,photo_hash,photo_path);
  assert result->'record'->'vehicle_type'='null'::jsonb and (result->'record'->>'has_photo')::boolean,
    'late receipt inferred a vehicle for a legacy record';
  result:=public.save_delivery_record(1,legacy_id,legacy_request,0,payload-'vehicle_type',null,false,fingerprint);
  assert result->'record'->'vehicle_type'='null'::jsonb and (result->'record'->>'has_photo')::boolean,
    'legacy save retry after late receipt lost compatibility';
  execute 'reset role';

  for as_service in select unnest(array[true,false]) loop
    if as_service then execute 'set local role service_role'; end if;
    blocked:=null;
    begin update public.delivery_records set vehicle_type='store' where id=personal_id;
    exception when insufficient_privilege or object_not_in_prerequisite_state then blocked:=sqlstate; end;
    assert blocked=(case when as_service then '42501' else '55000' end), 'selected vehicle was mutable';
    blocked:=null;
    begin update public.delivery_records set vehicle_type='personal' where id=legacy_id;
    exception when insufficient_privilege or object_not_in_prerequisite_state then blocked:=sqlstate; end;
    assert blocked=(case when as_service then '42501' else '55000' end), 'legacy unknown vehicle was mutable';
    if as_service then execute 'reset role'; end if;
  end loop;
  assert (select to_jsonb(r) from public.delivery_records r where id=personal_id)=record_snapshot,
    'attachment or rejected vehicle edit changed original business/retry metadata';
  assert (select to_jsonb(r) from public.delivery_records r where id=legacy_id)=legacy_snapshot,
    'attachment or rejected legacy edit changed original row';
  assert (select count(*) from public.delivery_records)=before_records+3, 'invalid vehicle produced an extra record';
  assert (select count(*) from public.delivery_photo_attachments)=before_attachments+2, 'vehicle operation changed attachments unexpectedly';
  assert not has_table_privilege('service_role','public.delivery_records','UPDATE,DELETE,TRUNCATE'), 'server mutation grants expanded';
  assert not has_table_privilege('anon','public.delivery_records','SELECT,INSERT,UPDATE,DELETE'), 'browser access expanded';
  assert not has_function_privilege('authenticated','public.save_delivery_record(integer,uuid,uuid,integer,jsonb,text,boolean,text)','EXECUTE'), 'browser RPC access expanded';
  assert not exists(select 1 from pg_proc where oid in (
    'public.save_delivery_record(integer,uuid,uuid,integer,jsonb,text,boolean,text)'::regprocedure,
    'public.delivery_record_json(public.delivery_records)'::regprocedure
  ) and prosecdef), 'vehicle functions unexpectedly SECURITY DEFINER';
end;
$$;
rollback;
select 'Vehicle assertions passed; all synthetic records and receipts rolled back.' as verification;
