const API='https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/receipt-api';
const $=id=>document.getElementById(id);
let session=null,photo=null,submitted=[],editing=null;
let selectedDate='',serverToday='',statusReady=false,busy=false,photoBusy=false,photoVersion=0,statusVersion=0,monthVersion=0,dirty=false;
try{session=JSON.parse(sessionStorage.getItem('receipt-session')||'null')}catch{}
function taipeiToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function validDate(date){const d=new Date(date+'T00:00:00Z');return /^\d{4}-\d{2}-\d{2}$/.test(date)&&date>='1900-01-01'&&Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===date&&date<=(serverToday||taipeiToday())}
function message(s,error=false){$('message').textContent=s;$('message').classList.toggle('error',error)}
async function api(action,body={},form=null){
 const r=await fetch(API,{method:'POST',headers:{...(form?{}:{'Content-Type':'application/json'}),...(session?{Authorization:'Bearer '+session.token}:{})},body:form||JSON.stringify({action,...body})});
 const data=await r.json();if(!r.ok)throw Error(data.error||'連線失敗');return data;
}
function hasUber(){return [3,4,6].includes(Number(session?.store_id))}
function syncControls(){
 const blocked=busy;
 ['business-date','shift','logout','missing-month','refresh-missing'].forEach(id=>{$(id).disabled=blocked;});
 $('missing-list').querySelectorAll('button').forEach(b=>b.disabled=blocked);
 $('receipt-form').querySelectorAll('input').forEach(el=>el.disabled=blocked);
 const uber=$('receipt-form').elements.namedItem('uber_revenue');
 uber.closest('label').hidden=!hasUber();uber.disabled=blocked||!hasUber();uber.required=hasUber();
 const exists=submitted.includes($('shift').value);
 $('revenue-label').textContent=$('shift').value+'總營收（元）';
 $('submit').disabled=blocked||photoBusy||!statusReady||(exists&&!editing);
 $('submit').textContent=busy?'處理中…':photoBusy?'照片處理中…':editing?'儲存修改':exists?'此班別已上傳，可點選編輯':selectedDate<(serverToday||taipeiToday())?'補上傳 '+selectedDate+' '+$('shift').value:'確認上傳';
 $('edit').hidden=!statusReady||!exists||!!editing;$('edit').disabled=blocked;
 $('edit-note').hidden=!editing;$('photo').required=!editing;
}
function clearPhoto(){
 photoVersion++;photoBusy=false;photo=null;
 if($('preview').src)URL.revokeObjectURL($('preview').src);
 $('preview').removeAttribute('src');$('preview').hidden=true;$('photo').value='';
}
function resetEdit(){
 editing=null;clearPhoto();
 $('receipt-form').querySelectorAll('input[type=number]').forEach(el=>el.value=el.name==='expense'?'0':'');
 dirty=false;syncControls();
}
async function refreshDate(){
 const request=++statusVersion,date=selectedDate;
 statusReady=false;$('status').textContent='正在查詢 '+date+' 的上傳狀態…';syncControls();
 try{
  const data=await api('status',{business_date:date});
  if(request!==statusVersion||date!==selectedDate)return;
  serverToday=data.today||taipeiToday();$('business-date').max=serverToday;$('missing-month').max=serverToday.slice(0,7);
  submitted=data.submitted||[];statusReady=true;
  $('today').textContent='結帳日期：'+data.date+(data.date<serverToday?'（補上傳）':'（今天，台灣時間）');
  $('status').textContent=['早班','晚班'].map(s=>s+'：'+(submitted.includes(s)?'已上傳成功':'尚未上傳')).join('　｜　');
 }catch(e){if(request===statusVersion){$('status').textContent='無法確認上傳狀態，請按「重新檢查」再試。';message(e.message,true);throw e;}}
 finally{if(request===statusVersion)syncControls();}
}
function missingSlots(month,rows,today){
 const found=new Set(rows.map(r=>r.business_date+'|'+r.shift)),result=[];
 const [year,mon]=month.split('-').map(Number),days=new Date(Date.UTC(year,mon,0)).getUTCDate();
 for(let day=1;day<=days;day++){
  const date=month+'-'+String(day).padStart(2,'0');if(date>today)break;
  for(const shift of ['早班','晚班'])if(!found.has(date+'|'+shift))result.push({date,shift,pending:date===today});
 }
 return result;
}
async function refreshMonth(){
 const request=++monthVersion,month=$('missing-month').value;
 $('missing-list').replaceChildren();$('missing-summary').textContent='正在檢查…';
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'1900-01'||month>(serverToday||taipeiToday()).slice(0,7)){$('missing-summary').textContent='請選擇本月或以前的月份。';return;}
 try{
  const data=await api('month_status',{month});
  if(request!==monthVersion||month!==$('missing-month').value)return;
  serverToday=data.today;$('business-date').max=serverToday;$('missing-month').max=serverToday.slice(0,7);
  const slots=missingSlots(month,data.reports,serverToday);
  const overdue=slots.filter(s=>!s.pending),pending=slots.length-overdue.length;
  $('missing-summary').textContent=slots.length?month+'：'+new Set(overdue.map(s=>s.date)).size+' 天缺漏，共 '+overdue.length+' 個班別待補傳'+(pending?'；今天 '+pending+' 個班別待上傳':''):'✓ '+month+' 截至今天，早晚班帳條皆已上傳。';
  for(const slot of slots){
   const button=document.createElement('button');button.type='button';button.textContent=slot.date+' '+slot.shift+' · '+(slot.pending?'待上傳':'補上傳');
   button.onclick=()=>{if(!busy)chooseDate(slot.date,slot.shift);};button.disabled=busy;$('missing-list').append(button);
  }
 }catch(e){if(request===monthVersion){$('missing-list').replaceChildren();$('missing-summary').textContent='缺漏提醒載入失敗，請按「重新檢查」；目前無法確認是否有缺漏。';}}
}
async function chooseDate(date,shift){
 if(busy)return;
 if(!validDate(date)){$('business-date').value=selectedDate;message('請選擇今天或以前的有效結帳日期。',true);return;}
 if(dirty&&!confirm('切換日期或班別會清除尚未儲存的內容，確定切換？')){$('business-date').value=selectedDate;return;}
 selectedDate=date;$('business-date').value=date;if(shift)$('shift').value=shift;
 statusReady=false;submitted=[];resetEdit();message('');
 if($('missing-month').value!==date.slice(0,7)){$('missing-month').value=date.slice(0,7);void refreshMonth();}
 try{await refreshDate();if(shift)$('business-date').scrollIntoView({behavior:'smooth',block:'start'});}catch{}
}
$('business-date').onchange=()=>chooseDate($('business-date').value);
$('missing-month').onchange=()=>{if(!busy)void refreshMonth()};
$('refresh-missing').onclick=async()=>{if(busy)return;try{await Promise.all([refreshDate(),refreshMonth()])}catch{}};
$('shift').onchange=()=>{resetEdit();message('')};
$('receipt-form').addEventListener('input',()=>{dirty=true});
$('edit').onclick=async()=>{
 if(busy||!statusReady)return;const date=selectedDate,shift=$('shift').value;
 busy=true;syncControls();
 try{
  const data=await api('edit',{shift,business_date:date});
  editing=data.report;clearPhoto();
  for(const k of ['revenue','foodpanda_revenue','uber_revenue','cash_revenue','expense'])$('receipt-form').elements.namedItem(k).value=editing[k]??'';
  dirty=false;message('正在修改 '+date+' '+shift+'。未選新照片時會保留原照。');
 }catch(e){message(e.message,true)}
 finally{busy=false;syncControls()}
};
async function enter(){
 serverToday=taipeiToday();selectedDate=serverToday;
 $('business-date').value=selectedDate;$('business-date').max=serverToday;$('business-date').min='1900-01-01';
 $('missing-month').value=serverToday.slice(0,7);$('missing-month').max=serverToday.slice(0,7);$('missing-month').min='1900-01';
 $('store-name').textContent=session.store_name;$('workspace').hidden=false;$('login').hidden=true;
 resetEdit();await Promise.allSettled([refreshDate(),refreshMonth()]);
}
$('login-form').onsubmit=async e=>{
 e.preventDefault();const btn=e.submitter;btn.disabled=true;
 try{
  session=await api('login',{store_id:Number($('store').value),password:$('password').value});
  sessionStorage.setItem('receipt-session',JSON.stringify(session));$('password').value='';message('');await enter();
 }catch(e){message(e.message,true)}finally{btn.disabled=false}
};
$('logout').onclick=()=>{if(busy)return;sessionStorage.removeItem('receipt-session');session=null;location.reload()};
// Preserve the input's File while invalidating any earlier asynchronous preview.
$('photo').onchange=async()=>{
 const file=$('photo').files[0];photoVersion++;const version=photoVersion;photo=null;$('preview').hidden=true;
 if(!file){photoBusy=false;syncControls();return;}
 photoBusy=true;dirty=true;syncControls();
 try{
  if(file.size>30*1024*1024)throw Error('照片過大，請選擇 30MB 以內照片');
  const url=URL.createObjectURL(file),im=new Image();
  try{
   im.src=url;await im.decode();
   const scale=Math.min(1,2400/Math.max(im.width,im.height)),canvas=document.createElement('canvas');
   canvas.width=Math.round(im.width*scale);canvas.height=Math.round(im.height*scale);
   const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(im,0,0,canvas.width,canvas.height);
   const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.9));
   if(version!==photoVersion)return;
   if(!blob||blob.size>8*1024*1024)throw Error('照片過大，請改用較小照片');
   photo=blob;if($('preview').src)URL.revokeObjectURL($('preview').src);
   $('preview').src=URL.createObjectURL(photo);$('preview').hidden=false;message('');
  }finally{URL.revokeObjectURL(url)}
 }catch(e){if(version===photoVersion)message('無法讀取照片，請改選 JPG／PNG，或先截圖再上傳。'+e.message,true)}
 finally{if(version===photoVersion){photoBusy=false;syncControls()}}
};
$('receipt-form').onsubmit=async e=>{
 e.preventDefault();if(busy||photoBusy||!statusReady)return;
 if(!validDate(selectedDate))return message('請重新選擇有效的結帳日期。',true);
 if(!photo&&!editing)return message('請先選擇可讀取的帳條照片',true);
 const date=selectedDate,shift=$('shift').value,isEditing=!!editing;
 // Capture the enabled form before locking inputs.
 const form=new FormData(e.target);
 form.set('action',isEditing?'update':'submit');form.set('business_date',date);form.set('shift',shift);
 if(editing){form.set('id',editing.id);form.set('updated_at',editing.updated_at)}
 if(!hasUber())form.set('uber_revenue',String(editing?.uber_revenue??0));
 if(photo)form.set('photo',photo,'receipt.jpg');
 busy=true;syncControls();
 try{
  await api(isEditing?'update':'submit',{},form);
  e.target.reset();$('shift').value=shift;resetEdit();
  message(date+' '+shift+(isEditing?' 修改已儲存，等待主管重新確認。':' 上傳成功！'));
  await Promise.allSettled([refreshDate(),refreshMonth()]);
 }catch(e){message(e.message+'\n若網路中斷，請按「重新檢查」確認所選日期狀態後再試。',true)}
 finally{busy=false;syncControls()}
};
(async()=>{
 try{const data=await api('stores');$('store').replaceChildren(new Option('請選擇分店',''),...data.stores.map(s=>new Option(s.store_name,s.store_id)));if(session)await enter()}
 catch(e){message(e.message,true);session=null;sessionStorage.removeItem('receipt-session')}
})();
