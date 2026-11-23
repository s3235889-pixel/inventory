-- Run after all delivery migrations with a database management connection.
-- Only synthetic UUIDs are inserted/used. Never modify existing records or
-- TRUNCATE a live table. Every test change and role change is rolled back.
begin;
do $$
declare
  empty_id uuid := gen_random_uuid();
  original_photo_id uuid := gen_random_uuid();
  store2_id uuid := gen_random_uuid();
  guard_id uuid := gen_random_uuid();
  tombstone_id uuid := gen_random_uuid();
  missing_id uuid := gen_random_uuid();
  create_request uuid := gen_random_uuid();
  photo_request uuid := gen_random_uuid();
  photo_hash text := repeat('c',64);
  fingerprint text := repeat('a',64);
  path text;
  retry_path text;
  changed_path text;
  original_path text;
  store2_path text;
  candidate_path text;
  payload jsonb := '{"unit_name":"QA late photo rollback","address":"屏東縣潮州鎮測試路1號","courier":"測試人員","delivered_at":"1901-05-10T04:00:00Z","amount":1200.50,"distance_km":3.25}';
  original_row jsonb;
  original_attachment jsonb;
  result jsonb;
  loaded jsonb;
  row_count_before bigint;
  attachment_count_before bigint;
  blocked text;
  role_name text;
  assignment text;
  as_service boolean;
begin
  if exists (select 1 from public.delivery_records where delivered_at >= timestamptz '1901-05-01 00:00+08'
    and delivered_at < timestamptz '1901-06-01 00:00+08') then
    raise exception 'Delivery late-photo QA month already has data; choose an unused month.';
  end if;
  select count(*) into row_count_before from public.delivery_records;
  select count(*) into attachment_count_before from public.delivery_photo_attachments;
  path := '1/' || empty_id || '/' || gen_random_uuid() || '-' || photo_hash || '.jpg';
  retry_path := '1/' || empty_id || '/' || gen_random_uuid() || '-' || photo_hash || '.jpg';
  changed_path := '1/' || empty_id || '/' || gen_random_uuid() || '-' || repeat('d',64) || '.jpg';
  original_path := '1/' || original_photo_id || '/' || gen_random_uuid() || '-' || photo_hash || '.jpg';
  store2_path := '2/' || store2_id || '/' || gen_random_uuid() || '-' || photo_hash || '.jpg';

  execute 'set local role service_role';
  perform public.save_delivery_record(1,empty_id,create_request,0,payload,null,false,fingerprint);
  perform public.save_delivery_record(1,original_photo_id,gen_random_uuid(),0,payload,original_path,false,fingerprint);
  perform public.save_delivery_record(2,store2_id,gen_random_uuid(),0,payload,null,false,fingerprint);
  perform public.save_delivery_record(1,guard_id,gen_random_uuid(),0,payload,null,false,fingerprint);
  select to_jsonb(r) into original_row from public.delivery_records r where id=empty_id;
  result := public.attach_delivery_record_photo(1,empty_id,photo_request,1,photo_hash,null);
  assert (result ->> 'ready_for_upload')::boolean, 'preflight did not allow an empty receipt';
  assert not (result -> 'record' ->> 'has_photo')::boolean, 'preflight attached a photo';
  assert (result -> 'record' ->> 'version')::integer=1, 'preflight advanced version';
  assert (select count(*) from public.delivery_photo_attachments)=attachment_count_before, 'preflight inserted an attachment';

  blocked := null;
  begin perform public.attach_delivery_record_photo(1,empty_id,photo_request,2,photo_hash,null);
  exception when serialization_failure then blocked:=sqlstate; end;
  assert blocked='40001', 'stale version without photo was accepted';
  blocked := null;
  begin perform public.attach_delivery_record_photo(2,empty_id,photo_request,1,photo_hash,null);
  exception when no_data_found then blocked:=sqlstate; end;
  assert blocked='P0002', 'other store could preflight this record';
  blocked := null;
  begin perform public.delivery_record_photo_path(2,empty_id);
  exception when no_data_found then blocked:=sqlstate; end;
  assert blocked='P0002', 'other store could read receipt path';
  blocked := null;
  begin perform public.attach_delivery_record_photo(1,missing_id,photo_request,1,photo_hash,null);
  exception when no_data_found then blocked:=sqlstate; end;
  assert blocked='P0002', 'missing record could receive an attachment';
  blocked := null;
  begin perform public.attach_delivery_record_photo(3,empty_id,photo_request,1,photo_hash,null);
  exception when insufficient_privilege then blocked:=sqlstate; end;
  assert blocked='42501', 'unsupported store could attach a receipt';
  blocked := null;
  begin perform public.attach_delivery_record_photo(1,original_photo_id,photo_request,1,photo_hash,null);
  exception when object_not_in_prerequisite_state then blocked:=sqlstate; end;
  assert blocked='55000', 'a record with its original photo allowed attachment';

  result := public.attach_delivery_record_photo(1,empty_id,photo_request,1,photo_hash,path);
  assert not (result ->> 'ready_for_upload')::boolean, 'commit reported ready rather than attached';
  assert (result -> 'record' ->> 'has_photo')::boolean, 'attached photo missing from record response';
  assert (result -> 'record' ->> 'version')::integer=2, 'public version did not advance once';
  assert result ->> 'photo_path'=path, 'wrong committed photo path';
  assert not (result -> 'record' ? 'photo_path'), 'raw path exposed in record';
  assert (select to_jsonb(r) from public.delivery_records r where id=empty_id)=original_row,
    'attachment mutated original business/version/request metadata';
  select to_jsonb(a) into original_attachment from public.delivery_photo_attachments a where record_id=empty_id;
  assert result -> 'record' ->> 'updated_at'=original_attachment ->> 'created_at', 'public attachment timestamp mismatch';
  assert public.delivery_record_photo_path(1,empty_id) ->> 'photo_path'=path, 'photo lookup ignored attachment';
  assert public.delivery_record_photo_path(1,original_photo_id) ->> 'photo_path'=original_path, 'original photo lookup changed';

  result := public.attach_delivery_record_photo(1,empty_id,photo_request,1,photo_hash,null);
  assert not (result ->> 'ready_for_upload')::boolean and result ->> 'photo_path'=path,
    'exact retry preflight did not return committed attachment';
  result := public.attach_delivery_record_photo(1,empty_id,photo_request,1,photo_hash,retry_path);
  assert result ->> 'photo_path'=path and (result -> 'record' ->> 'version')::integer=2,
    'exact retry replaced photo or advanced version';
  assert (select count(*) from public.delivery_photo_attachments)=attachment_count_before+1, 'exact retry duplicated attachment';
  blocked := null;
  begin perform public.attach_delivery_record_photo(1,empty_id,gen_random_uuid(),1,photo_hash,retry_path);
  exception when object_not_in_prerequisite_state then blocked:=sqlstate; end;
  assert blocked='55000', 'new request replaced attachment';
  blocked := null;
  begin perform public.attach_delivery_record_photo(1,empty_id,photo_request,1,repeat('d',64),changed_path);
  exception when object_not_in_prerequisite_state then blocked:=sqlstate; end;
  assert blocked='55000', 'same request accepted changed photo bytes';
  blocked := null;
  begin perform public.attach_delivery_record_photo(1,empty_id,photo_request,1,photo_hash,replace(retry_path,'.jpg','.png'));
  exception when object_not_in_prerequisite_state then blocked:=sqlstate; end;
  assert blocked='55000', 'same request accepted changed image format';
  blocked := null;
  begin perform public.attach_delivery_record_photo(1,empty_id,photo_request,1,photo_hash,changed_path);
  exception when invalid_parameter_value then blocked:=sqlstate; end;
  assert blocked='22023', 'path hash did not match content hash';
  assert (select to_jsonb(a) from public.delivery_photo_attachments a where record_id=empty_id)=original_attachment,
    'a rejected retry changed the attachment';

  -- Original create retries must retain their old fingerprint while returning
  -- the current combined photo/version state, not reopening a late-photo UI.
  result := public.save_delivery_record(1,empty_id,create_request,0,payload,null,false,fingerprint);
  assert (result -> 'record' ->> 'has_photo')::boolean and (result -> 'record' ->> 'version')::integer=2,
    'original create retry forgot the late attachment';
  assert (select to_jsonb(r) from public.delivery_records r where id=empty_id)=original_row,
    'create retry mutated original row';
  loaded := public.load_delivery_records(1,'1901-05',0);
  assert (loaded ->> 'total_count')::integer=3 and (loaded ->> 'total_amount')::numeric=3601.50,
    'attachment changed monthly totals';
  assert (select (value ->> 'has_photo')::boolean and (value ->> 'version')::integer=2
    from jsonb_array_elements(loaded -> 'records') where value ->> 'id'=empty_id::text), 'load omitted late attachment';
  result := public.attach_delivery_record_photo(2,store2_id,gen_random_uuid(),1,photo_hash,store2_path);
  assert (result -> 'record' ->> 'has_photo')::boolean, 'store2 could not attach own receipt';
  assert public.delivery_record_photo_path(2,store2_id) ->> 'photo_path'=store2_path, 'store2 photo lookup failed';
  assert (public.load_delivery_records(2,'1901-05',0) ->> 'total_count')::integer=1, 'store2 saw another store records';
  execute 'reset role';

  -- A synthetic tombstone proves that the new path cannot revive old deletions.
  insert into public.delivery_records
    (id,store_id,unit_name,address,courier,delivered_at,amount,distance_km,version,last_request_id,last_request_fingerprint,deleted_at)
    values (tombstone_id,1,'QA tombstone','測試地址','測試人員',timestamptz '1901-05-11 12:00+08',1,1,2,gen_random_uuid(),fingerprint,clock_timestamp());
  blocked:=null;
  begin perform public.attach_delivery_record_photo(1,tombstone_id,gen_random_uuid(),2,photo_hash,null);
  exception when no_data_found then blocked:=sqlstate; end;
  assert blocked='P0002', 'tombstone accepted late photo';

  -- INSERT guards apply even to server code that bypasses the attachment RPC.
  execute 'set local role service_role';
  candidate_path:='2/' || guard_id || '/' || gen_random_uuid() || '-' || photo_hash || '.jpg';
  blocked:=null;
  begin insert into public.delivery_photo_attachments(record_id,store_id,request_id,base_version,photo_hash,photo_path)
    values(guard_id,2,gen_random_uuid(),1,photo_hash,candidate_path);
  exception when insufficient_privilege then blocked:=sqlstate; end;
  assert blocked='42501', 'direct INSERT bypassed parent store check';
  candidate_path:='1/' || guard_id || '/' || gen_random_uuid() || '-' || photo_hash || '.jpg';
  blocked:=null;
  begin insert into public.delivery_photo_attachments(record_id,store_id,request_id,base_version,photo_hash,photo_path)
    values(guard_id,1,gen_random_uuid(),2,photo_hash,candidate_path);
  exception when serialization_failure then blocked:=sqlstate; end;
  assert blocked='40001', 'direct INSERT ignored base version';
  blocked:=null;
  begin insert into public.delivery_photo_attachments(record_id,store_id,request_id,base_version,photo_hash,photo_path)
    values(original_photo_id,1,gen_random_uuid(),1,photo_hash,original_path);
  exception when object_not_in_prerequisite_state then blocked:=sqlstate; end;
  assert blocked='55000', 'direct INSERT bypassed original-photo lock';
  candidate_path:='1/' || tombstone_id || '/' || gen_random_uuid() || '-' || photo_hash || '.jpg';
  blocked:=null;
  begin insert into public.delivery_photo_attachments(record_id,store_id,request_id,base_version,photo_hash,photo_path)
    values(tombstone_id,1,gen_random_uuid(),2,photo_hash,candidate_path);
  exception when no_data_found then blocked:=sqlstate; end;
  assert blocked='P0002', 'direct INSERT bypassed tombstone check';
  blocked:=null;
  begin insert into public.delivery_photo_attachments(record_id,store_id,request_id,base_version,photo_hash,photo_path)
    values(empty_id,1,gen_random_uuid(),1,photo_hash,retry_path);
  exception when unique_violation then blocked:=sqlstate; end;
  assert blocked='23505', 'record primary key allowed a second receipt';
  execute 'reset role';

  for as_service in select unnest(array[true,false]) loop
    if as_service then execute 'set local role service_role'; end if;
    foreach assignment in array array[
      'photo_path=' || quote_literal(retry_path), 'photo_hash=repeat(''e'',64)', 'store_id=2',
      'record_id=gen_random_uuid()', 'request_id=gen_random_uuid()', 'base_version=2',
      'created_at=created_at+interval ''1 minute'''
    ] loop
      blocked:=null;
      begin execute 'update public.delivery_photo_attachments set ' || assignment || ' where record_id=$1' using empty_id;
      exception when object_not_in_prerequisite_state or insufficient_privilege then blocked:=sqlstate; end;
      assert blocked=(case when as_service then '42501' else '55000' end), 'attachment update bypassed privilege/trigger';
    end loop;
    blocked:=null;
    begin delete from public.delivery_photo_attachments where record_id=empty_id;
    exception when object_not_in_prerequisite_state or insufficient_privilege then blocked:=sqlstate; end;
    assert blocked=(case when as_service then '42501' else '55000' end), 'attachment deletion bypassed privilege/trigger';
    blocked:=null;
    begin update public.delivery_records set photo_path=path where id=empty_id;
    exception when object_not_in_prerequisite_state or insufficient_privilege then blocked:=sqlstate; end;
    assert blocked=(case when as_service then '42501' else '55000' end), 'original record update was relaxed';
    if as_service then execute 'reset role'; end if;
  end loop;
  blocked:=null;
  begin perform public.delete_delivery_record(1,empty_id,2);
  exception when object_not_in_prerequisite_state then blocked:=sqlstate; end;
  assert blocked='55000', 'late attachment enabled record deletion';

  foreach role_name in array array['anon','authenticated'] loop
    assert not has_table_privilege(role_name,'public.delivery_photo_attachments','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
      'browser role can directly access attachments';
    assert not has_function_privilege(role_name,'public.attach_delivery_record_photo(integer,uuid,uuid,integer,text,text)','EXECUTE'),
      'browser role can invoke attachment RPC';
    assert not has_function_privilege(role_name,'public.delivery_record_photo_path(integer,uuid)','EXECUTE'),
      'browser role can invoke photo lookup RPC';
  end loop;
  assert has_table_privilege('service_role','public.delivery_photo_attachments','SELECT')
    and has_table_privilege('service_role','public.delivery_photo_attachments','INSERT'), 'server lacks required attachment grants';
  assert not has_table_privilege('service_role','public.delivery_photo_attachments','UPDATE,DELETE,TRUNCATE'), 'server can mutate attachment';
  assert not has_table_privilege('service_role','public.delivery_records','UPDATE,DELETE,TRUNCATE'), 'original table mutation grants expanded';
  assert (select relrowsecurity from pg_class where oid='public.delivery_photo_attachments'::regclass), 'attachment RLS missing';
  assert exists(select 1 from pg_trigger where tgrelid='public.delivery_photo_attachments'::regclass
    and tgname='delivery_photo_attachments_no_truncate' and tgenabled='O'), 'attachment TRUNCATE trigger missing';
  assert not exists(select 1 from pg_proc where oid in (
    'public.attach_delivery_record_photo(integer,uuid,uuid,integer,text,text)'::regprocedure,
    'public.delivery_record_photo_path(integer,uuid)'::regprocedure,
    'public.delivery_record_json(public.delivery_records)'::regprocedure,
    'public.guard_delivery_photo_attachment_insert()'::regprocedure,
    'public.prevent_delivery_photo_attachment_change()'::regprocedure
  ) and prosecdef), 'attachment function unexpectedly SECURITY DEFINER';
  assert (select count(*) from public.delivery_records)=row_count_before+5, 'photo operation changed record count';
  assert (select count(*) from public.delivery_photo_attachments)=attachment_count_before+2, 'photo operation changed attachment count';
  assert (select to_jsonb(r) from public.delivery_records r where id=empty_id)=original_row, 'original row changed';
  assert (select to_jsonb(a) from public.delivery_photo_attachments a where record_id=empty_id)=original_attachment, 'committed attachment changed';
end;
$$;
rollback;
