-- Run after all delivery migrations. Only synthetic records are mutated;
-- every test insert, constraint and role change is rolled back. No live table
-- is truncated, no receipt object is removed, and no admin secret is read.
begin;

create function pg_temp.expect_delivery_error(statement text, expected_state text)
returns void language plpgsql security invoker as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE % but statement succeeded', expected_state;
end;
$$;

do $$
declare
  api_role text;
  rpc text;
  col text;
begin
  assert (select not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolreplication and not rolbypassrls and not rolinherit
    from pg_roles where rolname='delivery_admin_writer'), 'writer role has excessive attributes';
  foreach api_role in array array['anon','authenticated','service_role'] loop
    assert not pg_has_role(api_role,'delivery_admin_writer','MEMBER'), 'API role is a writer member';
    assert not has_table_privilege(api_role,'public.delivery_records','UPDATE,DELETE,TRUNCATE'), 'API can directly mutate records';
    assert not has_any_column_privilege(api_role,'public.delivery_records','UPDATE'), 'API has a hidden column UPDATE grant';
    assert not has_table_privilege(api_role,'public.delivery_admin_mutations','INSERT,UPDATE,DELETE,TRUNCATE'), 'API can mutate the audit log';
    foreach rpc in array array[
      'public.admin_load_delivery_records(text,integer)',
      'public.admin_save_delivery_record(integer,uuid,uuid,integer,jsonb,text,text,integer)',
      'public.admin_delete_delivery_record(integer,uuid,uuid,integer,text,integer)'
    ] loop
      assert has_function_privilege(api_role,rpc,'EXECUTE')=(api_role='service_role'), 'admin RPC execution grant is wrong';
    end loop;
  end loop;
  assert not has_table_privilege('delivery_admin_writer','public.delivery_records','UPDATE,DELETE,TRUNCATE'), 'writer has a blanket mutation grant';
  for col in select attname from pg_attribute where attrelid='public.delivery_records'::regclass and attnum>0 and not attisdropped loop
    assert has_column_privilege('delivery_admin_writer','public.delivery_records',col,'UPDATE') =
      (col=any(array['unit_name','address','courier','delivered_at','amount','distance_km','vehicle_type','version','updated_at','deleted_at'])),
      'writer column UPDATE allowlist is wrong';
  end loop;
  assert not has_table_privilege('delivery_admin_writer','public.receipt_admin_config','SELECT,INSERT,UPDATE,DELETE'), 'writer can access all admin configuration';
  for col in select attname from pg_attribute where attrelid='public.receipt_admin_config'::regclass and attnum>0 and not attisdropped loop
    assert has_column_privilege('delivery_admin_writer','public.receipt_admin_config',col,'SELECT')=(col=any(array['id','session_version'])),
      'writer can read unrelated admin configuration';
  end loop;
  assert not has_table_privilege('delivery_admin_writer','public.delivery_photo_attachments','INSERT,UPDATE,DELETE,TRUNCATE'), 'writer can modify receipts';
  assert not has_table_privilege('delivery_admin_writer','public.delivery_admin_mutations','UPDATE,DELETE,TRUNCATE'), 'writer can rewrite audit history';
  assert not exists(select 1 from pg_class where oid in (
    'public.delivery_records'::regclass,'public.delivery_photo_attachments'::regclass,
    'public.delivery_admin_mutations'::regclass,'public.receipt_admin_config'::regclass
  ) and not relrowsecurity), 'RLS is disabled';
  assert (select count(*)=2 from pg_proc where oid in (
    'public.admin_save_delivery_record(integer,uuid,uuid,integer,jsonb,text,text,integer)'::regprocedure,
    'public.admin_delete_delivery_record(integer,uuid,uuid,integer,text,integer)'::regprocedure
  ) and prosecdef and proowner='delivery_admin_writer'::regrole and proconfig @> array['search_path=""']),
    'admin mutations do not use the restricted owner and empty search path';
  assert not (select prosecdef from pg_proc where oid='public.admin_load_delivery_records(text,integer)'::regprocedure),
    'admin list unexpectedly bypasses caller permissions';
end;
$$;

do $$
declare
  record_a uuid:=gen_random_uuid(); record_b uuid:=gen_random_uuid();
  legacy_id uuid:=gen_random_uuid(); store_created_id uuid:=gen_random_uuid();
  create_a uuid:=gen_random_uuid(); create_b uuid:=gen_random_uuid();
  edit_a uuid:=gen_random_uuid(); delete_a uuid:=gen_random_uuid();
  photo_request uuid:=gen_random_uuid(); legacy_request uuid:=gen_random_uuid();
  store_request uuid:=gen_random_uuid();
  fingerprint text:=repeat('a',64); photo_hash text:=repeat('b',64);
  payload jsonb:='{"unit_name":"QA admin delivery","address":"屏東縣潮州鎮測試路1號","courier":"測試人員","delivered_at":"1904-07-05T04:00:00Z","amount":1200.50,"distance_km":3.25,"vehicle_type":"personal"}';
  edited jsonb:='{"unit_name":"QA corrected unit","address":"屏東縣潮州鎮測試路2號","courier":"更正人員","delivered_at":"1904-07-06T05:30:00Z","amount":321.25,"distance_km":4.75,"vehicle_type":"store"}';
  result jsonb; initial_result jsonb; edit_result jsonb; deletion_result jsonb;
  original_a jsonb; before_change jsonb; before_failure jsonb;
  original_legacy jsonb; original_store jsonb;
  initial_totals jsonb; totals jsonb; selected_month text:='1904-07';
  path_a text; path_b text; retry_path text;
  current_session integer; invalid_session integer;
  before_records bigint; before_photos bigint; before_audit bigint; audit_count bigint;
  candidate jsonb; stmt text;
begin
  select session_version into current_session from public.receipt_admin_config where id=1;
  assert current_session>0, 'configured admin session_version is required';
  invalid_session:=case when current_session=1 then 2 else current_session-1 end;
  select count(*) into before_records from public.delivery_records;
  select count(*) into before_photos from public.delivery_photo_attachments;
  select count(*) into before_audit from public.delivery_admin_mutations;
  initial_totals:=public.admin_load_delivery_records(selected_month,null);

  -- Legacy data deliberately retains unknown vehicle ownership.
  insert into public.delivery_records(id,store_id,unit_name,address,courier,delivered_at,amount,distance_km,last_request_id,last_request_fingerprint)
    values(legacy_id,1,payload->>'unit_name',payload->>'address',payload->>'courier',
      (payload->>'delivered_at')::timestamptz,1200.50,3.25,legacy_request,fingerprint);
  select to_jsonb(r) into original_legacy from public.delivery_records r where id=legacy_id;

  execute 'set local role service_role';
  result:=public.save_delivery_record(1,store_created_id,store_request,0,payload,null,false,fingerprint);
  select to_jsonb(r) into original_store from public.delivery_records r where id=store_created_id;

  stmt:=format('select public.admin_save_delivery_record(1,%L,%L,0,%L::jsonb,null,%L,%s)',
    record_a,create_a,payload,fingerprint,invalid_session);
  perform pg_temp.expect_delivery_error(stmt,'42501');
  result:=public.admin_save_delivery_record(1,record_a,create_a,0,payload,null,fingerprint,current_session);
  initial_result:=result;
  assert result->'record'->>'id'=record_a::text and result->'record'->>'store_id'='1'
    and result->'record'->>'version'='1' and result->'record'->>'vehicle_type'='personal'
    and result->'record'->>'created_at' is not null, 'admin creation response is incomplete';
  select to_jsonb(r) into original_a from public.delivery_records r where id=record_a;
  assert (select action='create' and before_record is null and after_record=original_a and a.result=initial_result
    from public.delivery_admin_mutations a where request_id=create_a), 'creation audit is incomplete';
  result:=public.admin_save_delivery_record(1,record_a,create_a,0,payload,null,fingerprint,current_session);
  assert result=initial_result, 'creation exact retry did not return its committed result';
  perform pg_temp.expect_delivery_error(stmt,'42501'); -- even a committed retry must recheck the session
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,0,%L::jsonb,null,%L,%s)',
    record_a,create_a,edited,fingerprint,current_session),'40001');
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,0,%L::jsonb,null,%L,%s)',
    gen_random_uuid(),create_a,payload,fingerprint,current_session),'40001');
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,0,%L::jsonb,null,%L,%s)',
    record_a,gen_random_uuid(),payload,fingerprint,current_session),'40001');

  path_b:='2/'||record_b||'/'||gen_random_uuid()||'-'||photo_hash||'.jpg';
  retry_path:='2/'||record_b||'/'||gen_random_uuid()||'-'||photo_hash||'.jpg';
  result:=public.admin_save_delivery_record(2,record_b,create_b,0,edited,path_b,fingerprint,current_session);
  assert (result->'record'->>'has_photo')::boolean and result->>'photo_path'=path_b, 'new admin receipt missing';
  result:=public.admin_save_delivery_record(2,record_b,create_b,0,edited,retry_path,fingerprint,current_session);
  assert result->>'photo_path'=path_b, 'photo retry did not retain the committed physical object';
  assert public.delivery_record_photo_path(2,record_b)->>'photo_path'=path_b, 'store-bound original photo lookup failed';
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(2,%L,%L,1,%L::jsonb,%L,%L,%s)',
    record_b,gen_random_uuid(),edited,path_b,fingerprint,current_session),'22023');
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(2,%L,%L,1,%L::jsonb,null,%L,%s)',
    record_a,gen_random_uuid(),edited,fingerprint,current_session),'40001');
  perform pg_temp.expect_delivery_error(format('select public.admin_delete_delivery_record(2,%L,%L,1,%L,%s)',
    record_a,gen_random_uuid(),fingerprint,current_session),'P0002');
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(3,%L,%L,0,%L::jsonb,null,%L,%s)',
    gen_random_uuid(),gen_random_uuid(),payload,fingerprint,current_session),'22023');

  result:=public.admin_save_delivery_record(1,record_a,edit_a,1,edited,null,fingerprint,current_session);
  edit_result:=result;
  assert result->'record'->>'version'='2' and result->'record'->>'vehicle_type'='store', 'seven-field edit did not advance version';
  select to_jsonb(r) into before_change from public.delivery_records r where id=record_a;
  assert (before_change-array['unit_name','address','courier','delivered_at','amount','distance_km','vehicle_type','version','updated_at'])
    =(original_a-array['unit_name','address','courier','delivered_at','amount','distance_km','vehicle_type','version','updated_at']),
    'edit changed original store/photo/create retry metadata';
  assert (select before_record=original_a and after_record=before_change and a.result=edit_result
    from public.delivery_admin_mutations a where request_id=edit_a), 'edit audit is incomplete';
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,2,%L::jsonb,null,%L,%s)',
    record_a,gen_random_uuid(),payload,fingerprint,invalid_session),'42501');
  perform pg_temp.expect_delivery_error(format('select public.admin_delete_delivery_record(1,%L,%L,2,%L,%s)',
    record_a,gen_random_uuid(),fingerprint,invalid_session),'42501');

  -- Late receipt uses the incremented physical row version, then the public
  -- version adds the immutable attachment. Subsequent edits retain both.
  path_a:='1/'||record_a||'/'||gen_random_uuid()||'-'||photo_hash||'.jpg';
  result:=public.attach_delivery_record_photo(1,record_a,photo_request,2,photo_hash,path_a);
  assert result->'record'->>'version'='3' and (result->'record'->>'has_photo')::boolean, 'late receipt version overlay failed';
  assert (select to_jsonb(r) from public.delivery_records r where id=record_a)=before_change, 'attachment rewrote the parent';
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,2,%L::jsonb,null,%L,%s)',
    record_a,gen_random_uuid(),payload,fingerprint,current_session),'40001');
  perform pg_temp.expect_delivery_error(format('select public.admin_delete_delivery_record(1,%L,%L,2,%L,%s)',
    record_a,gen_random_uuid(),fingerprint,current_session),'40001');
  result:=public.admin_save_delivery_record(1,record_a,gen_random_uuid(),3,payload,null,fingerprint,current_session);
  assert result->'record'->>'version'='4' and (result->'record'->>'has_photo')::boolean, 'edit after receipt used the wrong version';
  assert (result->'record'->>'updated_at')::timestamptz=(select updated_at from public.delivery_records where id=record_a)
    and (result->'record'->>'updated_at')::timestamptz>(select created_at from public.delivery_photo_attachments where record_id=record_a),
    'old attachment timestamp hid the newer edit';
  assert public.delivery_record_photo_path(1,record_a)->>'photo_path'=path_a, 'admin edit replaced a late receipt';
  result:=public.admin_save_delivery_record(1,record_a,edit_a,1,edited,null,fingerprint,current_session);
  assert result=edit_result and (select version=3 from public.delivery_records where id=record_a), 'old mutation retry reapplied an edit';
  result:=public.attach_delivery_record_photo(1,record_a,photo_request,2,photo_hash,path_a);
  assert result->'record'->>'version'='4', 'exact receipt retry stopped working after admin edit';
  perform pg_temp.expect_delivery_error(format('select public.attach_delivery_record_photo(1,%L,%L,4,%L,%L)',
    record_a,gen_random_uuid(),photo_hash,path_a),'55000');
  perform pg_temp.expect_delivery_error(format('select public.delivery_record_photo_path(2,%L)',record_a),'P0002');

  -- Store entry points remain immutable even for administrator-created rows.
  perform pg_temp.expect_delivery_error(format('select public.save_delivery_record(1,%L,%L,4,%L::jsonb,null,false,%L)',
    record_a,gen_random_uuid(),edited,fingerprint),'55000');
  perform pg_temp.expect_delivery_error(format('select public.delete_delivery_record(1,%L,4)',record_a),'55000');

  result:=public.admin_save_delivery_record(1,legacy_id,gen_random_uuid(),1,payload||'{"vehicle_type":null}'::jsonb,null,fingerprint,current_session);
  assert result->'record'->'vehicle_type'='null'::jsonb, 'legacy edit invented a vehicle';
  assert (select last_request_id=legacy_request and last_request_fingerprint=fingerprint from public.delivery_records where id=legacy_id),
    'legacy edit rewrote original retry metadata';
  result:=public.admin_save_delivery_record(1,legacy_id,gen_random_uuid(),2,payload,null,fingerprint,current_session);
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,3,%L::jsonb,null,%L,%s)',
    legacy_id,gen_random_uuid(),payload||'{"vehicle_type":null}'::jsonb,fingerprint,current_session),'22023');
  result:=public.admin_save_delivery_record(1,store_created_id,gen_random_uuid(),1,edited,null,fingerprint,current_session);
  assert (select last_request_id=store_request and last_request_fingerprint=fingerprint and created_at=(original_store->>'created_at')::timestamptz
    from public.delivery_records where id=store_created_id), 'editing a store-created record changed original metadata';
  perform pg_temp.expect_delivery_error(format('select public.save_delivery_record(1,%L,%L,0,%L::jsonb,null,false,%L)',
    store_created_id,store_request,payload,fingerprint),'55000');

  -- Validation failures are atomic and create neither a record nor an audit.
  foreach candidate in array array[payload-'vehicle_type',payload||'{"vehicle_type":null}',
    payload||'{"vehicle_type":"both"}',payload||'{"store_id":2}',payload||'{"amount":"12"}',
    payload||'{"address":"屏東縣"}',payload||'{"delivered_at":"invalid"}'] loop
    perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,0,%L::jsonb,null,%L,%s)',
      gen_random_uuid(),gen_random_uuid(),candidate,fingerprint,current_session),'22023');
  end loop;
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,0,%L::jsonb,null,%L,%s)',
    gen_random_uuid(),gen_random_uuid(),payload||'{"amount":-1}',fingerprint,current_session),'23514');
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,0,%L::jsonb,%L,%L,%s)',
    gen_random_uuid(),gen_random_uuid(),payload,path_b,fingerprint,current_session),'22023');

  -- Force only this synthetic record's next audit insert to fail, proving
  -- the preceding row UPDATE and version increment roll back with it.
  select to_jsonb(r) into before_failure from public.delivery_records r where id=store_created_id;
  select count(*) into audit_count from public.delivery_admin_mutations;
  execute 'reset role';
  execute format('alter table public.delivery_admin_mutations add constraint delivery_admin_qa_forced_failure check (record_id <> %L::uuid) not valid',store_created_id);
  execute 'set local role service_role';
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,2,%L::jsonb,null,%L,%s)',
    store_created_id,gen_random_uuid(),payload,fingerprint,current_session),'23514');
  assert (select to_jsonb(r) from public.delivery_records r where id=store_created_id)=before_failure, 'failed audit committed a partial edit';
  assert (select count(*) from public.delivery_admin_mutations)=audit_count, 'failed audit added history';
  assert current_setting('app.delivery_admin_mutation',true) is distinct from 'allowed', 'failed edit leaked the mutation flag';
  execute 'reset role';
  alter table public.delivery_admin_mutations drop constraint delivery_admin_qa_forced_failure;
  execute 'set local role service_role';

  totals:=public.admin_load_delivery_records(selected_month,null);
  assert (totals->>'total_count')::bigint=(initial_totals->>'total_count')::bigint+4, 'admin list omitted a store or silently paginated';
  result:=public.admin_delete_delivery_record(1,record_a,delete_a,4,fingerprint,current_session);
  deletion_result:=result;
  assert result->>'deleted'='true' and result->>'version'='5' and result->>'store_id'='1', 'delete did not use the attachment-aware version';
  assert (select version=4 and deleted_at is not null and photo_path is null from public.delivery_records where id=record_a), 'delete did not preserve a physical tombstone';
  assert (select photo_path=path_a from public.delivery_photo_attachments where record_id=record_a), 'delete removed the receipt attachment';
  assert public.admin_delete_delivery_record(1,record_a,delete_a,4,fingerprint,current_session)=deletion_result, 'delete retry is not idempotent';
  perform pg_temp.expect_delivery_error(format('select public.admin_delete_delivery_record(1,%L,%L,5,%L,%s)',
    record_a,gen_random_uuid(),fingerprint,current_session),'P0002');
  perform pg_temp.expect_delivery_error(format('select public.admin_delete_delivery_record(1,%L,%L,4,%L,%s)',
    record_a,delete_a,repeat('c',64),current_session),'40001');
  perform pg_temp.expect_delivery_error(format('select public.admin_save_delivery_record(1,%L,%L,5,%L::jsonb,null,%L,%s)',
    record_a,gen_random_uuid(),payload,fingerprint,current_session),'P0002');
  perform pg_temp.expect_delivery_error(format('select public.save_delivery_record(1,%L,%L,0,%L::jsonb,null,false,%L)',
    record_a,create_a,payload,fingerprint),'40001');
  perform pg_temp.expect_delivery_error(format('select public.attach_delivery_record_photo(1,%L,%L,5,%L,null)',
    record_a,gen_random_uuid(),photo_hash),'P0002');
  perform pg_temp.expect_delivery_error(format('select public.delivery_record_photo_path(1,%L)',record_a),'P0002');
  result:=public.admin_delete_delivery_record(2,record_b,gen_random_uuid(),1,fingerprint,current_session);
  assert result->>'version'='2' and (select photo_path=path_b from public.delivery_records where id=record_b), 'delete discarded an original photo';
  totals:=public.admin_load_delivery_records(selected_month,null);
  assert (totals->>'total_count')::bigint=(initial_totals->>'total_count')::bigint+2
    and (totals->>'total_amount')::numeric=(initial_totals->>'total_amount')::numeric+1521.75
    and (totals->>'total_distance_km')::numeric=(initial_totals->>'total_distance_km')::numeric+8,
    'admin totals include deleted rows';
  assert not exists(select 1 from jsonb_array_elements(totals->'records') x where x->>'id' in(record_a::text,record_b::text)), 'admin list includes deleted rows';
  assert not exists(select 1 from jsonb_array_elements(public.load_delivery_records(1,selected_month,0)->'records') x where x->>'id'=record_a::text)
    and not exists(select 1 from jsonb_array_elements(public.load_delivery_records(2,selected_month,0)->'records') x where x->>'id'=record_b::text),
    'store lists include deleted rows';
  assert (public.load_delivery_records(1,selected_month,0)->>'total_count')::bigint+
    (public.load_delivery_records(2,selected_month,0)->>'total_count')::bigint=(totals->>'total_count')::bigint,
    'store totals disagree after deletion';
  assert (public.admin_load_delivery_records(selected_month,1)->>'total_count')::bigint=
    (public.load_delivery_records(1,selected_month,0)->>'total_count')::bigint, 'admin store filter is wrong';

  -- A spoofed local flag never gives the server API direct UPDATE access.
  perform set_config('app.delivery_admin_mutation','allowed',true);
  perform pg_temp.expect_delivery_error(format('update public.delivery_records set amount=1 where id=%L',legacy_id),'42501');
  -- SET ROLE authorization uses session_user (the QA migration owner), so
  -- writer membership is asserted above rather than impersonated here.
  perform pg_temp.expect_delivery_error(format('update public.delivery_admin_mutations set action=''delete'' where request_id=%L',create_a),'42501');
  perform set_config('app.delivery_admin_mutation','',true);
  execute 'reset role';
  perform set_config('app.delivery_admin_mutation','allowed',true);
  perform pg_temp.expect_delivery_error(format('update public.delivery_records set amount=1 where id=%L',legacy_id),'55000');
  perform set_config('app.delivery_admin_mutation','',true);
  perform pg_temp.expect_delivery_error(format('delete from public.delivery_records where id=%L',legacy_id),'55000');
  perform pg_temp.expect_delivery_error(format('update public.delivery_admin_mutations set action=''delete'' where request_id=%L',create_a),'55000');
  perform pg_temp.expect_delivery_error(format('delete from public.delivery_admin_mutations where request_id=%L',create_a),'55000');
  execute 'set local role delivery_admin_writer';
  perform pg_temp.expect_delivery_error(format('update public.delivery_records set amount=1 where id=%L',legacy_id),'55000');
  perform set_config('app.delivery_admin_mutation','allowed',true);
  perform pg_temp.expect_delivery_error(format('update public.delivery_records set store_id=2 where id=%L',legacy_id),'42501');
  perform pg_temp.expect_delivery_error(format('update public.delivery_records set amount=1 where id=%L',legacy_id),'55000');
  assert not exists(select 1 from public.receipt_admin_config where id<>1), 'writer RLS can see unrelated admin configurations';
  perform set_config('app.delivery_admin_mutation','',true);
  execute 'reset role';
  assert (select count(*) from public.delivery_records)=before_records+4, 'invalid or retried writes created extra rows';
  assert (select count(*) from public.delivery_photo_attachments)=before_photos+1, 'admin edits or deletes changed photo count';
  assert (select count(*) from public.delivery_admin_mutations)=before_audit+9, 'audit count is inconsistent with committed operations';
end;
$$;

-- Scope is the complete month for export; fail explicitly rather than returning
-- an incomplete XLSX. This transaction contains only synthetic generated IDs.
do $$
declare
  result jsonb;
begin
  insert into public.delivery_records(id,store_id,unit_name,address,courier,delivered_at,amount,distance_km,vehicle_type,last_request_id,last_request_fingerprint)
    select gen_random_uuid(),1,'QA export '||n,'屏東縣測試地址','測試人員',timestamptz '1905-01-01 00:00+08',1,1,'personal',gen_random_uuid(),repeat('e',64)
    from generate_series(1,10001) n;
  execute 'set local role service_role';
  perform pg_temp.expect_delivery_error('select public.admin_load_delivery_records(''1905-01'',null)','54000');
  perform pg_temp.expect_delivery_error('select public.admin_load_delivery_records(''1905-01'',1)','54000');
  result:=public.admin_load_delivery_records('1905-01',2);
  assert result->'records'='[]'::jsonb and result->>'total_count'='0', 'store filter leaked other-store export records';
  perform pg_temp.expect_delivery_error('select public.admin_load_delivery_records(''1905-13'',null)','22023');
  perform pg_temp.expect_delivery_error('select public.admin_load_delivery_records(''1905-01'',3)','22023');
  execute 'reset role';
end;
$$;

rollback;
select 'Admin delivery assertions passed; all synthetic records, receipts, audit entries and test constraints rolled back.' as verification;
