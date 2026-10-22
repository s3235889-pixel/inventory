import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(Deno.env.get('SUPABASE_URL')!, secret, {auth:{persistSession:false}});
const headers = {'Access-Control-Allow-Origin':'https://s3235889-pixel.github.io','Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
const enc = new TextEncoder();
const key = await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
const b64 = (b:Uint8Array)=>btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const bytes = (s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function token(store:number,admin=false){const p=b64(enc.encode(JSON.stringify({store,admin,exp:Date.now()+8*3600000})));return p+'.'+b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(p))));}
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function fail(message:string,status=400){throw {message,status};}
function check(error:unknown){if(error) throw error;}
async function passwordHash(password:string,salt:string){
 const material=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
 return b64(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:100000,hash:'SHA-256'},material,256)));
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{headers});
 try {
 if(req.method!=='POST')fail('僅接受 POST',405);
 const multipart=req.headers.get('content-type')?.includes('multipart/form-data');
 const form=multipart?await req.formData():null;
 const body=form?Object.fromEntries(form):await req.json();
 const action=String(body.action||'');
 if(action==='stores'){const {data,error}=await db.from('stores').select('store_id,store_name,sort_order').order('sort_order');check(error);return Response.json({stores:data},{headers});}
 if(action==='login'){
 const store=Number(body.store_id);if(!Number.isInteger(store)||typeof body.password!=='string'||body.password.length>128)fail('請輸入門市與密碼');
 const {count,error:ce}=await db.from('receipt_login_attempts').select('id',{count:'exact',head:true}).eq('store_id',store).gte('created_at',new Date(Date.now()-15*60000).toISOString());check(ce);
 if((count||0)>=20)fail('嘗試次數過多，請等 15 分鐘再試',429);
 const {error:ae}=await db.from('receipt_login_attempts').insert({store_id:store});check(ae);
 const {data,error}=await db.from('stores').select('store_id,store_name,password').eq('store_id',store).maybeSingle();check(error);
 if(!data||!data.password||String(data.password).trim()!==body.password.trim())fail('門市或密碼錯誤',401);
 await db.from('receipt_login_attempts').delete().eq('store_id',store);
 return Response.json({token:await token(store),store_id:store,store_name:data.store_name},{headers});
 }

 if(action==='admin_setup'||action==='admin_login'){
  const {count,error:ce}=await db.from('receipt_login_attempts').select('id',{count:'exact',head:true}).eq('store_id',0).gte('created_at',new Date(Date.now()-15*60000).toISOString());check(ce);
  if((count||0)>=15)fail('主管登入嘗試過多，請 15 分鐘後再試',429);
  check((await db.from('receipt_login_attempts').insert({store_id:0})).error);
  const {data:config,error}=await db.from('receipt_admin_config').select('*').eq('id',1).single();check(error);
  const password=String(body.password||'');if(password.length<10||password.length>128)fail('主管密碼請設定為 10 至 128 個字元');
  if(action==='admin_setup'){
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(String(body.setup_token||''))))).map(x=>x.toString(16).padStart(2,'0')).join('');
   if(config.password_hash||digest!==config.setup_hash)fail('設定連結已失效或已使用',403);
   const salt=crypto.randomUUID(),hash=await passwordHash(password,salt);
   const {data:updated,error:ue}=await db.from('receipt_admin_config').update({password_hash:hash,salt,setup_hash:null}).eq('id',1).is('password_hash',null).eq('setup_hash',digest).select('id').single();check(ue);if(!updated)fail('設定連結已使用',403);
  }else if(!config.password_hash||await passwordHash(password,config.salt)!==config.password_hash)fail('主管密碼錯誤，或尚未完成初次設定',401);
  await db.from('receipt_login_attempts').delete().eq('store_id',0);
  return Response.json({token:await token(0,true)},{headers});
 }
 const bearer=req.headers.get('authorization')?.replace(/^Bearer /,'')||'';
 let store:number|null=null; let admin:string|null=null;
 if(bearer.split('.').length===2){
 const [p,s]=bearer.split('.');if(!await crypto.subtle.verify('HMAC',key,bytes(s),enc.encode(p)))fail('請重新登入',401);
 const payload=JSON.parse(new TextDecoder().decode(bytes(p)));if(payload.exp<Date.now())fail('登入已逾時，請重新登入',401);if(payload.admin===true)admin='shared';else store=payload.store;
 }else{
 const {data,error}=await db.auth.getUser(bearer);if(error||!data.user||data.user.app_metadata?.receipts_admin!==true)fail('需要主管帳號授權',403);admin=data.user.id;
 }
 if(action==='status'&&store){const {data,error}=await db.from('receipt_reports').select('shift').eq('store_id',store).eq('business_date',today());check(error);return Response.json({date:today(),submitted:data?.map(x=>x.shift)},{headers});}
 if(action==='edit'&&store){
 const {data,error}=await db.from('receipt_reports').select('id,shift,revenue,foodpanda_revenue,uber_revenue,cash_revenue,expense,updated_at').eq('store_id',store).eq('business_date',today()).eq('shift',String(body.shift)).maybeSingle();check(error);
 if(!data)fail('找不到今天此班別的帳條',404);
 return Response.json({report:data},{headers});
 }
 if((action==='submit'||action==='update')&&store){
 const shift=String(body.shift);const revenue=Number(body.revenue),expense=Number(body.expense);
 if(!['早班','晚班'].includes(shift)||body.revenue===''||body.expense===''||![revenue,expense].every(n=>Number.isFinite(n)&&n>=0&&n<=9999999999.99&&Math.abs(n*100-Math.round(n*100))<0.001))fail('請填寫正確班別及金額（最多小數兩位）');
 const detailKeys=['foodpanda_revenue','uber_revenue','cash_revenue'];
 const hasDetails=detailKeys.some(k=>body[k]!==undefined);
 const details:Record<string,number|null>={};
 for(const k of detailKeys){
   if(!hasDetails){details[k]=null;continue;}
   const raw=body[k],value=Number(raw);
   if(raw===undefined||raw===null||String(raw).trim()===''||!Number.isFinite(value)||value<0||value>9999999999.99||Math.abs(value*100-Math.round(value*100))>=0.001)fail('請完整填寫熊貓、Uber、現金營收，無營收請填 0（最多小數兩位）');
   details[k]=value;
 }
 const date=today();let previous:{id:string,photo_path:string,updated_at:string}|null=null;
 if(action==='update'){
  const {data,error}=await db.from('receipt_reports').select('id,photo_path,updated_at').eq('id',String(body.id)).eq('store_id',store).eq('business_date',date).eq('shift',shift).maybeSingle();check(error);
  if(!data)fail('只能修改自己分店當天已上傳的帳條',403);
  if(!body.updated_at||body.updated_at!==data.updated_at)fail('這筆資料已更新，請重新載入後再修改',409);
  previous=data;
 }
 const photo=form?.get('photo');const hasPhoto=photo instanceof File&&photo.size>0;
 if(!hasPhoto&&!previous)fail('請上傳帳條照片');
 const id=previous?.id||crypto.randomUUID();let path=previous?.photo_path||'';
 if(hasPhoto){
 if(photo.size>8*1024*1024||!['image/jpeg','image/png','image/webp'].includes(photo.type))fail('請上傳 8MB 以內 JPG、PNG 或 WebP 照片');
 const sig=new Uint8Array(await photo.slice(0,12).arrayBuffer());const valid=photo.type==='image/jpeg'?sig[0]===255&&sig[1]===216:photo.type==='image/png'?sig[0]===137&&sig[1]===80&&sig[2]===78&&sig[3]===71:new TextDecoder().decode(sig.slice(0,4))==='RIFF'&&new TextDecoder().decode(sig.slice(8,12))==='WEBP';if(!valid)fail('照片格式不正確');
 path=`${store}/${date}/${crypto.randomUUID()}`;
 const {error:up}=await db.storage.from('receipt-photos').upload(path,photo,{contentType:photo.type,upsert:false});check(up);
 }
 if(previous){
 const {data,error}=await db.from('receipt_reports').update({revenue,expense,...details,photo_path:path,reviewed_at:null,reviewed_by:null,updated_at:new Date().toISOString()}).eq('id',id).eq('store_id',store).eq('business_date',today()).eq('updated_at',previous.updated_at).select('id');
 if(error||!data?.length){if(hasPhoto)await db.storage.from('receipt-photos').remove([path]);if(error)throw error;fail('資料已更新或日期已變更，請重新載入',409);}
 if(hasPhoto&&path!==previous.photo_path)await db.storage.from('receipt-photos').remove([previous.photo_path]);
 }else{
 const {error}=await db.from('receipt_reports').insert({id,store_id:store,business_date:date,shift,revenue,expense,...details,photo_path:path});
 if(error){if(hasPhoto)await db.storage.from('receipt-photos').remove([path]);if(error.code==='23505')fail('這個班別今天已上傳，請使用編輯功能',409);throw error;}
 }
 return Response.json({ok:true,date,shift},{headers});
 }
 if(admin&&action==='list'){
 const month=String(body.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('請選擇月份');
 const [y,m]=month.split('-').map(Number);const end=new Date(Date.UTC(y,m,1)).toISOString().slice(0,10);
 let q=db.from('receipt_reports').select('id,store_id,business_date,shift,revenue,foodpanda_revenue,uber_revenue,cash_revenue,expense,updated_at,created_at,reviewed_at,reviewed_by,stores(store_name)').gte('business_date',month+'-01').lt('business_date',end).order('business_date',{ascending:false}).order('store_id').limit(1000);
 if(body.store_id)q=q.eq('store_id',Number(body.store_id));const {data,error}=await q;check(error);return Response.json({reports:data},{headers});
 }
 if(admin&&action==='review'){
 if(typeof body.reviewed!=='boolean'||typeof body.updated_at!=='string')fail('請重新整理主管頁後再審核');
 const timestamp=new Date().toISOString();
 const {data,error}=await db.from('receipt_reports').update({reviewed_at:body.reviewed?timestamp:null,reviewed_by:body.reviewed&&admin!=='shared'?admin:null,updated_at:timestamp}).eq('id',body.id).eq('updated_at',body.updated_at).select('id,updated_at');check(error);
 if(!data?.length)fail('帳條已被修改，請重新查詢並核對後再確認',409);
 return Response.json({ok:true,updated_at:data[0].updated_at},{headers});
 }
 if(admin&&action==='photo'){const {data,error}=await db.from('receipt_reports').select('photo_path').eq('id',body.id).single();check(error);const {data:url,error:se}=await db.storage.from('receipt-photos').createSignedUrl(data!.photo_path,120);check(se);return Response.json({url:url!.signedUrl},{headers});}
 fail('無權限執行此操作',403);
 }catch(e){const error=e as {message?:string,status?:number};return Response.json({error:error.status?error.message:'處理失敗，請稍後再試；資料未確認成功前請勿離開'}, {status:error.status||500,headers});}
});
