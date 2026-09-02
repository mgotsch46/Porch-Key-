// Standalone check of everything the owner has asked for, against a live server.
process.env.DATA_DIR='/tmp/verify-'+Date.now();
process.env.PORT=3311;
process.env.ADMIN_EMAIL='v@test.com'; process.env.ADMIN_PASSWORD='Verify123!';
require('/sessions/trusting-zen-sagan/mnt/AI Project Folders/PorchPay-repo/server.js');
const BASE='http://localhost:3311';
let C='', pass=0, fail=0;
const ok=(c,n)=>{ c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL:',n)); };
async function q(p,o={}){ const r=await fetch(BASE+p,{headers:{'Content-Type':'application/json',Cookie:C},...o});
  const j=await r.json().catch(()=>({})); const s=r.headers.get('set-cookie');
  if(s) C=s.split(';')[0]; return {status:r.status,json:j}; }

(async()=>{
await new Promise(r=>setTimeout(r,900));
let r=await q('/api/login',{method:'POST',body:JSON.stringify({email:'v@test.com',password:'Verify123!'})});
ok(r.status===200,'sign in');
await q('/api/change-password',{method:'POST',body:JSON.stringify({password:'Verify123!'})});

console.log('\n1. EDIT BUYER + LOAN');
r=await q('/api/admin/properties',{method:'POST',body:JSON.stringify({address:'44 Maple Ave',city:'Dayton',state:'OH',zip:'45402',lat:39.75,lng:-84.19})});
const pid=r.json.id;
r=await q('/api/admin/tenants',{method:'POST',body:JSON.stringify({name:'Sam Buyer',email:'sam@x.test',phone:'9375551212'})});
const tid=r.json.id;
r=await q('/api/admin/loans',{method:'POST',body:JSON.stringify({property_id:pid,tenant_user_id:tid,
  sale_price_cents:9000000,down_payment_cents:1000000,principal_cents:8000000,interest_rate_bps:900,
  term_months:360,first_payment_date:'2026-09-01',late_fee_cents:5000,grace_days:5})});
const lid=r.json.loan.id;
r=await q('/api/admin/tenants/'+tid,{method:'PUT',body:JSON.stringify({name:'Samuel Buyer',phone:'9375559999'})});
ok(r.json.name==='Samuel Buyer'&&r.json.phone==='937-555-9999','buyer editable, phone reformatted');
r=await q('/api/admin/loans/'+lid,{method:'PUT',body:JSON.stringify({interest_rate_bps:775,term_months:300,recalc_payment:1,monthly_taxes_cents:18000,monthly_insurance_cents:7500})});
r=await q('/api/admin/loans/'+lid);
ok(r.json.loan.interest_rate_bps===775&&r.json.loan.term_months===300,'loan terms editable');
ok(r.json.loan.escrow_cents===25500,'escrow tracks taxes + insurance');
ok(r.json.loan.payment_cents>0,'P&I recalculated');

console.log('\n2. YEARLY / MONTHLY SCHEDULE');
ok(r.json.schedule.length===300,'monthly schedule');
ok(r.json.schedule_yearly.length>=25,'yearly rollup');
ok(r.json.schedule[r.json.schedule.length-1].balance_cents===0,'final payment clears to zero');
r=await q('/api/admin/amortize?principal_cents=8000000&interest_rate_bps=775&term_months=300&first_payment_date=2026-09-01');
ok(r.json.schedule_yearly&&r.json.schedule_yearly.length>=25,'calculator yearly rollup');
ok(r.json.solved_for==='payment','calculator solves the missing variable');

console.log('\n3. ONE-TIME NO-REPLY INVITE');
r=await q('/api/admin/properties',{method:'POST',body:JSON.stringify({address:'9 Birch Ln',city:'Dayton',state:'OH'})});
const pid2=r.json.id;
r=await q('/api/admin/properties/'+pid2+'/sell',{method:'POST',body:JSON.stringify({
  buyer_name:'Nia Buyer',buyer_email:'nia@x.test',buyer_phone:'9375552222',
  sale_price_cents:7500000,down_payment_cents:500000,principal_cents:7000000,
  interest_rate_bps:850,term_months:360,first_payment_date:'2026-10-01'})});
ok(r.status===200,'sell a property to a buyer');
r=await q('/api/admin/invitations');
const inv=r.json.invitations[0];
if(inv){
  r=await q('/api/admin/invitations/'+inv.id+'/preview');
  ok(/unmonitored number/i.test(r.json.text),'invite says unmonitored');
  ok(/STOP/.test(r.json.text),'invite carries the STOP opt-out');
  await q('/api/admin/invitations/'+inv.id+'/mark-sent',{method:'POST',body:'{}'});
  r=await q('/api/admin/invitations/'+inv.id+'/send',{method:'POST',body:'{}'});
  ok(r.status===409,'a second invite send is blocked');
} else { ok(false,'invitation created on sale'); }

console.log('\n4. LOCATION');
r=await q('/api/admin/tenants/'+tid+'/location');
ok(r.json.home&&r.json.home.geocoded,'property geocoded for distance');
ok(Array.isArray(r.json.history),'location history returned');
ok(!r.json.consent_at,'nothing recorded without opt-in');

console.log('\n5. TASKS');
r=await q('/api/admin/tasks',{method:'POST',body:JSON.stringify({title:'Winterize',property_id:pid,category:'bog',due_date:'2026-11-01',repeat_every:'yearly',remind_days_before:7})});
const tk=r.json.id;
ok(r.json.property_address==='44 Maple Ave','task tagged to a property');
r=await q('/api/admin/tasks',{method:'POST',body:JSON.stringify({title:'Renew the LLC filing'})});
ok(r.status===200&&!r.json.property_id,'one-off task with no property');
r=await q('/api/admin/tasks?property_id='+pid);
ok(r.json.tasks.length===1,'property task filter');
r=await q('/api/admin/tasks/'+tk+'/complete',{method:'POST',body:'{}'});
ok(r.json.next&&r.json.next.due_date==='2027-11-01','yearly task repeats');

console.log('\n6. CALENDAR');
await q('/api/admin/properties/'+pid+'/details',{method:'PUT',body:JSON.stringify({insurance_expires:'2026-11-15',insurance_carrier:'Allstate',tax_due_date:'2026-11-20'})});
r=await q('/api/admin/calendar?from=2026-11-01&to=2026-11-30');
const kinds=new Set(r.json.events.map(e=>e.source));
ok(kinds.has('task'),'tasks on the calendar');
ok(kinds.has('payment'),'buyer payments on the calendar');
ok(kinds.has('renewal'),'insurance + taxes on the calendar');
r=await q('/api/admin/calendar?from=2026-11-01&to=2026-11-30&payments=0&renewals=0&pml=0');
ok(r.json.events.every(e=>e.source==='task'),'layers can be switched off');

console.log('\n7. CONTACTS + VENDOR TEXT');
r=await q('/api/admin/contacts',{method:'POST',body:JSON.stringify({name:'Miguel BOG',role:'bog',phone:'9375550001',property_id:pid})});
const cid=r.json.id;
ok(r.json.phone==='937-555-0001','contact saved with dashes');
r=await q('/api/admin/properties/'+pid+'/contacts');
ok(r.json.contacts.length===1,'contact attached to the property');
r=await q('/api/admin/contacts/'+cid+'/messages',{method:'POST',body:JSON.stringify({body:'Check the furnace',property_id:pid})});
ok(r.status===400&&r.json.text.includes('44 Maple Ave'),'vendor text drafted with the address');
const wh=await fetch(BASE+'/sms/incoming',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'From=%2B19375550001&Body=furnace+is+fine'});
const x=await wh.text();
ok(!/<Message>/.test(x),'vendor reply routed to the thread, not auto-answered');
r=await q('/api/admin/contacts/'+cid+'/messages');
ok(r.json.messages.some(m=>m.direction==='in'),'their reply is in the thread');

console.log('\n8. NOTES');
r=await q('/api/admin/notes',{method:'POST',body:JSON.stringify({property_id:pid,body:'Lockbox code 4417'})});
ok(r.json.author_name,'property note saved with author');
r=await q('/api/admin/notes',{method:'POST',body:JSON.stringify({loan_id:lid,body:'Buyer paid late in Oct'})});
ok(r.status===200,'loan note saved');

console.log('\n9. DASHBOARD COUNTS');
r=await q('/api/admin/summary');
ok(typeof r.json.overdue_tasks==='number','dashboard reports overdue tasks');
ok(typeof r.json.unread_vendor_texts==='number','dashboard reports unread vendor texts');
ok(typeof r.json.income.ytd_gross_cents==='number' && typeof r.json.income.ytd_net_cents==='number','dashboard still reports gross and net income');
ok(typeof r.json.monthly_spread_cents==='number','dashboard still reports the TB/PML spread');

console.log('\n10. TEXTING SETUP');
r=await q('/api/admin/texting');
ok(r.json.connected===false,'texting reports disconnected honestly');
ok(/\/sms\/incoming$/.test(r.json.webhook_url),'webhook URL shown for Twilio');
r=await q('/api/admin/texting',{method:'PUT',body:JSON.stringify({sid:'bogus',token:'x',from:'5555555555'})});
ok(r.status===400,'bad credentials rejected before saving');

console.log('\n11. INVITE TEXTS ITSELF ON SALE');
r=await q('/api/admin/properties',{method:'POST',body:JSON.stringify({address:'12 Auto St'})});
r=await q('/api/admin/properties/'+r.json.id+'/sell',{method:'POST',body:JSON.stringify({
  buyer_name:'Auto Two',buyer_email:'auto2@x.test',buyer_phone:'9375553333',
  sale_price_cents:6000000,down_payment_cents:0,principal_cents:6000000,
  interest_rate_bps:900,term_months:240,first_payment_date:'2026-11-01'})});
ok(r.json.invite && r.json.invite.sent===false,'sale attempts the text without being asked');
ok(/not connected/i.test(r.json.invite.error),'and says exactly why it could not send');

console.log('\n12. MANAGEMENT COMPANY NAME ON CORRESPONDENCE');
await q('/api/admin/company',{method:'PUT',body:JSON.stringify({name:'Verify Holdings LLC'})});
await q('/api/admin/setup',{method:'POST',body:JSON.stringify({mgmt_company_name:'Verify Management Co'})});
r=await q('/api/admin/templates');
const tpl0=r.json.templates[0];
r=await q('/api/admin/templates/preview',{method:'POST',body:JSON.stringify({loan_id:lid,subject:tpl0.subject,body_html:tpl0.body_html})});
ok(/Verify Management Co/.test(r.json.html),'letterhead uses the management company');
ok(!/Verify Holdings LLC/.test(r.json.html),'legal entity name kept off correspondence');

console.log('\n13. PROPERTIES LIST');
r=await q('/api/admin/properties');
ok(Array.isArray(r.json)&&r.json.length>=3,'properties list returns rows to click into');
ok(r.json.every(p=>p.id&&p.address),'every row has an id and address to open');

console.log('\n14. LOANS LIST — searchable and clickable');
r=await q('/api/admin/loans');
ok(Array.isArray(r.json)&&r.json.length>=2,'loans list returns rows');
const L0=r.json[0];
ok(L0.id&&L0.address!==undefined,'each row has an id and address to open');
ok('city' in L0,'city included so the search can match on it');
ok('tenant_email' in L0,'buyer email included so the search can match on it');
ok(L0.status_info&&typeof L0.status_info.is_past_due==='boolean','past-due flag present for the status filter');
r=await q('/api/admin/loans/'+L0.id);
ok(r.status===200&&r.json.loan,'clicking a loan line opens the full loan');
r=await q('/api/admin/pml');
ok(Array.isArray(r.json),'PML list still separate and intact');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
