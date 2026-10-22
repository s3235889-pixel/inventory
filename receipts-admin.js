const API='https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/receipt-api',$=id=>document.getElementById(id);let token=sessionStorage.getItem('receipt-admin-session')||'',reports=[];
const setupToken=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(setupToken){document.querySelector('#login p').textContent='初次設定：請建立 4 個字元以上的主管密碼。此設定連結只能使用一次。';document.querySelector('#login-form button').textContent='設定密碼並登入';}
const hasUber=store=>[3,4,6].includes(Number(store));
const showUber=()=>!$('store').value||hasUber($('store').value);
function msg(s){$('message').textContent=s}
async function api(action,body={},form=null){const r=await fetch(API,{method:'POST',headers:{...(form?{}:{'Content-Type':'application/json'}),Authorization:'Bearer '+token},body:form||JSON.stringify({action,...body})});const d=await r.json();if(!r.ok)throw Error(d.error||'連線失敗');return d}
$('month').value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).format(new Date()).slice(0,7);
async function load(){const d=await api('list',{month:$('month').value,store_id:$('store').value});reports=d.reports;const storesResult=await api('stores');renderDaily(reports,storesResult.stores);$('rows').replaceChildren();for(const row of reports){const tr=document.createElement('tr');for(const v of [row.business_date,row.stores?.store_name||row.store_id,row.shift,Number(row.revenue).toLocaleString(),...['foodpanda_revenue','uber_revenue','cash_revenue'].map(k=>k==='uber_revenue'&&!hasUber(row.store_id)?'—':row[k]==null?'未填':Number(row[k]).toLocaleString()),Number(row.expense).toLocaleString()]){const td=document.createElement('td');td.textContent=v;tr.append(td)}const td=document.createElement('td'),b=document.createElement('button');b.textContent='查看';b.onclick=async()=>{try{const d=await api('photo',{id:row.id});$('full-photo').src=d.url;$('photo-dialog').showModal()}catch(e){msg(e.message)}};td.append(b);tr.append(td);const check=document.createElement('input');check.type='checkbox';check.checked=!!row.reviewed_at;check.setAttribute('aria-label',row.business_date+' '+row.stores?.store_name+' '+row.shift+' 已確認');check.onchange=async()=>{check.disabled=true;try{const saved=await api('review',{id:row.id,reviewed:check.checked,updated_at:row.updated_at});row.updated_at=saved.updated_at;row.reviewed_at=check.checked?new Date().toISOString():null;msg('審核已儲存')}catch(e){check.checked=!check.checked;msg(e.message)}finally{check.disabled=false}};const cell=document.createElement('td');cell.append(check);tr.append(cell);const actions=document.createElement('td'),edit=document.createElement('button'),del=document.createElement('button');edit.textContent='修改';edit.onclick=()=>openEdit(row);del.textContent='刪除';del.className='secondary';del.onclick=async()=>{if(!confirm('確定刪除 '+row.business_date+' '+(row.stores?.store_name||row.store_id)+' '+row.shift+'，總營收 '+Number(row.revenue).toLocaleString()+' 元的帳條？刪除後無法復原，月報將同步扣除。'))return;del.disabled=true;try{const result=await api('admin_delete',{id:row.id,updated_at:row.updated_at});await load();msg(result.photo_cleanup_pending?'帳條已刪除，照片清理待完成。':'帳條已刪除，月報已更新。')}catch(e){msg(e.message)}finally{del.disabled=false}};actions.append(edit,del);tr.append(actions);$('rows').append(tr)}$('rows').closest('table').querySelectorAll('tr').forEach(tr=>{if(tr.children[5])tr.children[5].hidden=!showUber()});const rev=reports.reduce((a,r)=>a+Math.round(Number(r.revenue)*100),0)/100,exp=reports.reduce((a,r)=>a+Math.round(Number(r.expense)*100),0)/100;$('summary').textContent=`共 ${reports.length} 筆｜總營收 ${rev.toLocaleString()} 元｜支出 ${exp.toLocaleString()} 元｜差額 ${(rev-exp).toLocaleString()} 元`;const breakdown=[['foodpanda_revenue','熊貓'],['uber_revenue','Uber'],['cash_revenue','現金']].filter(([key])=>key!=='uber_revenue'||showUber()).map(([key,label])=>{const filled=reports.filter(r=>r[key]!=null);const total=filled.reduce((sum,r)=>sum+Math.round(Number(r[key])*100),0)/100;return label+' '+total.toLocaleString()+' 元'+(filled.length<reports.length?'（'+(reports.length-filled.length)+' 筆未填）':'')});$('summary').textContent+='\n明細：'+breakdown.join('｜')+'\n總營收不另加上述明細。';}
$('login-form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{const data=await api(setupToken?'admin_setup':'admin_login',{password:$('password').value,...(setupToken?{setup_token:setupToken}:{})});token=data.token;sessionStorage.setItem('receipt-admin-session',token);await load();const d=await api('stores');$('store').replaceChildren(new Option('全部分店',''),...d.stores.map(s=>new Option(s.store_name,s.store_id)));$('login').hidden=true;$('workspace').hidden=false;if(parent!==window)parent.postMessage({type:'receipt-admin-authenticated'},location.origin);$('password').value='';msg('')}catch(e){msg(e.message)}finally{e.submitter.disabled=false}};

$('load').onclick=async()=>{try{await load();msg('')}catch(e){msg(e.message)}};
$('logout').onclick=async()=>{sessionStorage.removeItem('receipt-admin-session');location.reload()};$('close-photo').onclick=()=>{$('photo-dialog').close();$('full-photo').removeAttribute('src')};
$('export').onclick=()=>{const clean=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';const rows=[['日期','分店','班別','總營收','熊貓營收','Uber 營收','現金營收','支出','已確認'],...reports.map(r=>[r.business_date,r.stores?.store_name,r.shift,r.revenue,r.foodpanda_revenue??'未填',hasUber(r.store_id)?(r.uber_revenue??'未填'):'—',r.cash_revenue??'未填',r.expense,r.reviewed_at?'是':'否'])];if(!showUber())rows.forEach(row=>row.splice(5,1));const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(clean).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='帳條月報-'+$('month').value+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};

if(token&&!setupToken){(async()=>{try{await load();const d=await api('stores');$('store').replaceChildren(new Option('全部分店',''),...d.stores.map(s=>new Option(s.store_name,s.store_id)));$('login').hidden=true;$('workspace').hidden=false}catch(e){sessionStorage.removeItem('receipt-admin-session');token='';msg(e.message)}})()}

$('change-password-form').onsubmit=async e=>{
 e.preventDefault();const output=$('password-message');
 if($('new-password').value!==$('confirm-password').value){output.textContent='兩次新密碼不一致，請重新輸入。';return;}
 const button=e.submitter;button.disabled=true;output.textContent='正在更新…';
 try{await api('change_password',{current_password:$('current-password').value,new_password:$('new-password').value});
 sessionStorage.removeItem('receipt-admin-session');token='';e.target.reset();
 alert('主管密碼已更新，請使用新密碼重新登入。');
 if(parent!==window)parent.location.reload();else location.reload();
 }catch(error){output.textContent=error.message}finally{button.disabled=false}
};

let editReport=null;
function openEdit(row){editReport={...row};$('edit-report-form').reset();$('edit-error').textContent='';$('edit-title').textContent=row.business_date+' '+(row.stores?.store_name||row.store_id)+' '+row.shift;for(const k of ['revenue','foodpanda_revenue','uber_revenue','cash_revenue','expense'])$('edit-report-form').elements.namedItem(k).value=row[k]??'';const uber=$('edit-report-form').elements.namedItem('uber_revenue');uber.closest('label').hidden=!hasUber(row.store_id);uber.disabled=!hasUber(row.store_id);uber.required=hasUber(row.store_id);$('edit-dialog').showModal();}
$('cancel-edit').onclick=()=>$('edit-dialog').close();
$('edit-report-form').onsubmit=async e=>{e.preventDefault();if(!editReport)return;const button=e.submitter;button.disabled=true;$('edit-error').textContent='';try{const form=new FormData(e.target);const photo=form.get('photo');if(photo?.size>8*1024*1024)throw Error('照片請選擇 8MB 以內');form.set('action','admin_update');form.set('id',editReport.id);form.set('updated_at',editReport.updated_at);if(!hasUber(editReport.store_id))form.set('uber_revenue',String(editReport.uber_revenue??0));await api('admin_update',{},form);$('edit-dialog').close();await load();msg('修改已儲存，請重新核對並勾選已確認。')}catch(e){$('edit-error').textContent=e.message}finally{button.disabled=false}};

function dailyRevenueRows(data,month,storeId,today){
 const [year,mon]=month.split('-').map(Number),days=new Date(Date.UTC(year,mon,0)).getUTCDate();
 const groups=new Map();
 for(let day=1;day<=days;day++){const date=month+'-'+String(day).padStart(2,'0');if(date<=today)groups.set(date,{date,morning:0,evening:0,morningCount:0,eveningCount:0});}
 for(const row of data){if(storeId&&String(row.store_id)!==String(storeId))continue;const group=groups.get(row.business_date);if(!group)continue;const key=row.shift==='早班'?'morning':row.shift==='晚班'?'evening':null;if(!key)continue;group[key]+=Math.round(Number(row.revenue)*100);group[key+'Count']++;}
 return [...groups.values()].reverse();
}
function renderDaily(data,stores){
 const month=$('month').value,storeId=$('store').value;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const selected=stores.filter(s=>!storeId||String(s.store_id)===String(storeId));
 const rows=dailyRevenueRows(data,month,storeId,today),expected=selected.length;
 $('daily-scope').textContent=month+'｜'+(storeId?(selected[0]?.store_name||'所選分店'):'全部分店合計')+'｜金額單位：元';
 $('daily-rows').replaceChildren();
 for(const row of rows){const tr=document.createElement('tr'),count=row.morningCount+row.eveningCount,complete=expected>0&&row.morningCount===expected&&row.eveningCount===expected;
 const money=n=>(n/100).toLocaleString('zh-TW',{maximumFractionDigits:2});
 const values=[row.date,row.morningCount?money(row.morning):'尚未上傳',row.eveningCount?money(row.evening):'尚未上傳',count?money(row.morning+row.evening)+(complete?'':'（暫計）'):'尚無資料',complete?'兩班皆已上傳':'早班 '+row.morningCount+'/'+expected+'、晚班 '+row.eveningCount+'/'+expected];
 for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td)}$('daily-rows').append(tr);}
 if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='此月份尚無已到日期。';tr.append(td);$('daily-rows').append(tr);}
}
