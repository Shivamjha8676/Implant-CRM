(function(){
  const INV_DOC = "data/inventory";
  const LOW_STOCK = 2;
  let db=null;
  let items=[];      // code, description, material, dp, rp, mrp, stock
  let activity=[];   // movements
  let customers=[]; let crmEditId=null; let fuId=null;
  let documents=[]; let docType='po'; let docLines=[]; let suppliers=[];
  let payments=[]; let ledgerPartyType='customer';

  let modalAction=null; // {type:'sell'|'stock', code}
  let editCode=null;
  let salesFilter='all';
  let lastHandledBy='';
  try{ lastHandledBy = localStorage.getItem('armed_handled_by') || ''; }catch(e){}

  const fmtMoney = n => '₹' + Number(n||0).toLocaleString('en-IN');
  const byId = id => document.getElementById(id);
  const escapeHtml = s => String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function toast(msg){
    const t=byId('toast'); t.textContent=msg; t.classList.add('show');
    clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'), 2200);
  }
  function genId(prefix){
    try{ return prefix+'_'+crypto.randomUUID(); }catch(e){ return prefix+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,10); }
  }

  // Custom confirm (native confirm()/alert()/prompt() are blocked inside the published sandbox)
  let confirmPending=null;
  function askConfirm(title, sub, onYes){
    byId('confirmTitle').textContent = title;
    byId('confirmSub').textContent = sub;
    confirmPending = onYes;
    byId('confirmBack').classList.add('show');
  }
  byId('confirmCancel').addEventListener('click', ()=>{ confirmPending=null; byId('confirmBack').classList.remove('show'); });
  byId('confirmBack').addEventListener('click', (e)=>{ if(e.target===byId('confirmBack')){ confirmPending=null; byId('confirmBack').classList.remove('show'); } });
  byId('confirmOk').addEventListener('click', ()=>{
    const fn = confirmPending; confirmPending=null;
    byId('confirmBack').classList.remove('show');
    if(fn) fn();
  });

  // ---------- Tabs ----------
  const TAB_TITLES = {
    dashboard: ['Dashboard', "Today's overview — stock, follow-ups and documents at a glance"],
    inventory: ['Inventory', 'Stock levels, prices and Used/Sold tracking'],
    crm: ['CRM', 'Doctors, hospitals and clinics — with follow-ups'],
    sales: ['Sales History', 'Monthly collection summary and full activity log'],
    add: ['Add / Import Items', 'Add a new item or bulk import from Excel/CSV'],
    docs: ['PO / Invoice', 'Create a Purchase Order or GST Invoice'],
    ledger: ['Ledger', 'Party-wise statement and payments']
  };
  function switchTab(tabId){
    document.querySelectorAll('.tab-btn[data-tab]').forEach(b=>b.classList.toggle('active', b.dataset.tab===tabId));
    Object.keys(TAB_TITLES).forEach(t=>{
      const sec = byId('tab-'+t);
      if(sec) sec.style.display = (t===tabId) ? '' : 'none';
    });
    const meta = TAB_TITLES[tabId];
    if(meta){ byId('pageTitle').textContent = meta[0]; byId('pageSub').textContent = meta[1]; }
  }
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn=>{
    btn.addEventListener('click', ()=> switchTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-goto]').forEach(el=>{
    el.addEventListener('click', ()=> switchTab(el.dataset.goto));
  });

  function materialOptions(){
    const set = new Set(items.map(i=>i.material).filter(Boolean));
    const sel = byId('materialFilter');
    const current = sel.value;
    sel.innerHTML = '<option value="">All Materials</option>' +
      [...set].sort().map(m=>`<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    sel.value = current;
  }

  function lastSoldMap(){
    const map = new Map();
    activity.forEach(a=>{
      if(a.type==='sale' && !a.reversed && (!map.has(a.code) || a.ts>map.get(a.code))) map.set(a.code, a.ts);
    });
    return map;
  }

  function renderStats(){
    byId('statSkus').textContent = items.length;
    byId('statUnits').textContent = items.reduce((s,i)=>s+(Number(i.stock)||0),0).toLocaleString('en-IN');
    byId('statOut').textContent = items.filter(i=>Number(i.stock)<=LOW_STOCK).length;
    const sold = activity.filter(a=>a.type==='sale' && !a.reversed);
    byId('statSales').textContent = fmtMoney(sold.reduce((s,x)=>s+(Number(x.amount)||0),0));
    byId('statProfit').textContent = fmtMoney(sold.reduce((s,x)=>s+(Number(x.profit)||0),0));
  }

  function renderInvHeader(){
    byId('invHeadRow').innerHTML = `<th>Code</th><th>Description</th><th>Material</th><th>DP</th><th>RP (DP+50%)</th><th>MRP</th><th>Stock</th><th>Last Sold</th><th>Actions</th>`;
  }

  function renderInventory(){
    materialOptions();
    renderInvHeader();
    const q = byId('searchBox').value.trim().toLowerCase();
    const mat = byId('materialFilter').value;
    const rows = items.filter(i=>{
      if(mat && i.material!==mat) return false;
      if(!q) return true;
      return i.code.toLowerCase().includes(q) || i.description.toLowerCase().includes(q);
    }).sort((a,b)=> a.code.localeCompare(b.code, undefined, {numeric:true}));

    const lastSold = lastSoldMap();
    byId('invEmpty').style.display = rows.length ? 'none' : '';

    byId('invBody').innerHTML = rows.map(i=>{
      const stock = Number(i.stock);
      const low = stock<=LOW_STOCK;
      const stockCell = `<span class="stock-badge ${low?'low':''}">${i.stock}</span>${stock===0?'<span class="low-tag">Out of stock</span>':(low?'<span class="low-tag">Low stock</span>':'')}`;
      const ls = lastSold.get(i.code);
      return `
      <tr class="${low?'row-low':''}">
        <td class="code-cell">${escapeHtml(i.code)}</td>
        <td class="desc-cell">${escapeHtml(i.description)}</td>
        <td><span class="tag">${escapeHtml(i.material)}</span></td>
        <td>₹${Number(i.dp).toLocaleString('en-IN')}</td>
        <td class="rp-cell">₹${Number(i.rp).toLocaleString('en-IN')}</td>
        <td>₹${Number(i.mrp).toLocaleString('en-IN')}</td>
        <td>${stockCell}</td>
        <td>${ls ? new Date(ls).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'}</td>
        <td class="actions-cell">
          <button class="btn btn-teal btn-sm" data-act="sell" data-code="${escapeHtml(i.code)}" ${stock<=0?'disabled':''}>✓ Used/Sold</button>
          <button class="btn btn-outline btn-sm" data-act="stock" data-code="${escapeHtml(i.code)}">+ Stock</button>
          <button class="btn-icon" data-act="edit" data-code="${escapeHtml(i.code)}" title="Edit">✏️</button>
          <button class="btn-danger" data-act="delete" data-code="${escapeHtml(i.code)}" title="Delete">🗑</button>
        </td>
      </tr>`;
    }).join('');
  }

  function renderSales(){
    const rows = activity.filter(a=> salesFilter==='all' ? true : a.type===salesFilter);
    byId('salesEmpty').style.display = rows.length ? 'none' : '';
    byId('salesBody').innerHTML = rows.map(s=>`
      <tr class="${s.reversed?'row-reversed':''}">
        <td>${new Date(s.ts).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
        <td><span class="type-chip ${s.reversed?'reversed':s.type}">${s.reversed?'Reversed':(s.type==='sale'?'Used/Sold':'Stock Added')}</span></td>
        <td class="code-cell">${escapeHtml(s.code)}</td>
        <td class="desc-cell">${escapeHtml(s.description||'')}</td>
        <td>${s.qty}</td>
        <td>${fmtMoney(s.dp)}</td>
        <td>${fmtMoney(s.rp)}</td>
        <td class="rp-cell">${s.type==='sale' ? fmtMoney(s.amount) : '—'}</td>
        <td class="profit-cell">${s.type==='sale' ? fmtMoney(s.profit) : '—'}</td>
        <td>${escapeHtml(s.by||'—')}</td>
        <td>${s.reversed ? '' : `<button class="btn btn-outline btn-sm" data-undo-id="${escapeHtml(s.id)}">↩ Undo</button>`}</td>
      </tr>`).join('');
  }

  function monthKey(ts){ const d=new Date(ts); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
  function monthLabel(key){ const [y,m]=key.split('-'); return new Date(Number(y), Number(m)-1, 1).toLocaleDateString('en-IN',{month:'long', year:'numeric'}); }
  function monthlyData(){
    const sold = activity.filter(a=>a.type==='sale' && !a.reversed);
    const map = new Map();
    sold.forEach(s=>{
      const k = monthKey(s.ts);
      const row = map.get(k) || {key:k, qty:0, cost:0, amount:0, profit:0};
      row.qty += Number(s.qty)||0;
      row.cost += (Number(s.dp)||0) * (Number(s.qty)||0);
      row.amount += Number(s.amount)||0;
      row.profit += Number(s.profit)||0;
      map.set(k, row);
    });
    return [...map.values()].sort((a,b)=> b.key.localeCompare(a.key));
  }
  function renderMonthly(){
    const rows = monthlyData();
    byId('monthlyEmpty').style.display = rows.length ? 'none' : '';
    byId('monthlyBody').innerHTML = rows.map(r=>`
      <tr>
        <td class="code-cell">${monthLabel(r.key)}</td>
        <td>${r.qty}</td>
        <td>${fmtMoney(r.cost)}</td>
        <td class="rp-cell">${fmtMoney(r.amount)}</td>
        <td class="profit-cell">${fmtMoney(r.profit)}</td>
      </tr>`).join('');
  }

  function renderAll(){
    renderStats(); renderInventory(); renderCrm(); renderDashboard();
    renderSales(); renderDocsTab(); renderMonthly(); renderLedger();
  }

  function renderDashboard(){
    byId('dashCustomers').textContent = customers.length;
    byId('dashHavePhone').textContent = customers.filter(c=>c.phone).length;
    byId('dashHaveAddr').textContent = customers.filter(c=>c.address).length;
    byId('dashSuppliers').textContent = suppliers.length;
    byId('dashTotalSkus').textContent = items.length;
    const low = items.filter(i=>Number(i.stock)<=LOW_STOCK).sort((a,b)=>Number(a.stock)-Number(b.stock));
    byId('dashLowStock').textContent = low.length;
    byId('dashLowList').innerHTML = low.slice(0,6).map(i=>`<li><span>${escapeHtml(i.code)} — ${escapeHtml(i.description)}</span><b style="color:var(--danger);">${i.stock} left</b></li>`).join('') || '<li><span>All items are well stocked 👍</span></li>';
    const today = todayStr();
    byId('dashDue').textContent = customers.filter(c=>c.status!=='inactive' && c.nextFollowUp && c.nextFollowUp<=today).length;
    const recentDocs = documents.slice().sort((a,b)=>b.ts-a.ts).slice(0,6);
    byId('dashDocsList').innerHTML = recentDocs.map(d=>`<li><span>${escapeHtml(d.number)} — ${escapeHtml(d.party||'—')}</span><b>${fmtMoney(d.total)}</b></li>`).join('') || '<li><span>No PO/Invoice created yet.</span></li>';
  }

  byId('searchBox').addEventListener('input', renderInventory);
  byId('materialFilter').addEventListener('change', renderInventory);
  document.querySelectorAll('.chip-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.chip-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      salesFilter = btn.dataset.filter;
      renderSales();
    });
  });

  // ---------- Persist items ----------
  async function saveItems(newItems){
    items = newItems;
    renderAll();
    if(!db) return;
    try{ await db.doc(INV_DOC).set({items: newItems}); }catch(e){ toast('Could not save — try again'); }
  }

  async function logMovement(type, item, qty, by){
    const dp = Number(item.dp)||0, rp = Number(item.rp)||0;
    const id = genId('mv');
    const entry = {
      type, code:item.code, description:item.description, material:item.material, qty,
      dp, rp,
      amount: type==='sale' ? qty*rp : null,
      profit: type==='sale' ? qty*(rp-dp) : null,
      by: by || '', ts: Date.now(), reversed:false, id
    };
    activity = [entry, ...activity];
    renderAll();
    if(!db) return;
    try{ await db.collection('movements').doc(id).set(entry); }catch(e){ /* non-fatal */ }
  }

  function applyStockDelta(code, delta){
    const newStock = Math.max(0, Number((items.find(i=>i.code===code)||{}).stock||0) + delta);
    saveItems(items.map(i=> i.code===code ? {...i, stock:newStock} : i));
    return newStock;
  }

  // ---------- Undo a movement ----------
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-undo-id]');
    if(!btn) return;
    const id = btn.dataset.undoId;
    const mv = activity.find(a=>a.id===id);
    if(!mv) return;
    const label = mv.type==='sale' ? 'Used/Sold' : 'Stock Added';
    askConfirm('Undo this entry?',
      `"${label}" for ${mv.code} (qty ${mv.qty}) will be reversed — stock corrected and excluded from Sales Value / Profit.`,
      async ()=>{
        applyStockDelta(mv.code, mv.type==='sale' ? mv.qty : -mv.qty);
        activity = activity.map(a=> a.id===id ? {...a, reversed:true} : a);
        renderAll();
        if(db){ try{ await db.collection('movements').doc(id).update({reversed:true, reversedAt:Date.now()}); }catch(err){} }
        toast('Entry undone — stock corrected');
      });
  });

  // ---------- Row actions (sell / stock / edit / delete) ----------
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-act]');
    if(!btn) return;
    const act = btn.dataset.act, code = btn.dataset.code;
    const item = items.find(i=>i.code===code);
    if(!item) return;

    if(act==='delete'){
      askConfirm('Delete item?', `"${item.code} — ${item.description}" will be permanently deleted. This cannot be undone.`, ()=>{
        saveItems(items.filter(i=>i.code!==code));
        toast('Item deleted');
      });
      return;
    }
    if(act==='edit'){
      editCode = code;
      byId('editSub').textContent = `${item.code} — editing price & details`;
      byId('e_desc').value = item.description;
      byId('e_material').value = item.material;
      byId('e_dp').value = item.dp;
      byId('e_rp').value = item.rp;
      byId('e_mrp').value = item.mrp;
      byId('editBack').classList.add('show');
      return;
    }
    modalAction = {type:act, code};
    byId('modalTitle').textContent = act==='sell' ? 'Mark as Used / Sold' : 'Add Stock';
    byId('modalSub').textContent = `${item.code} — ${item.description} (current stock: ${item.stock})`;
    byId('modalQty').value = 1;
    byId('modalQty').max = act==='sell' ? item.stock : '';
    byId('modalBy').value = lastHandledBy;
    byId('modalBack').classList.add('show');
    byId('modalQty').focus();
  });

  byId('modalCancel').addEventListener('click', ()=>byId('modalBack').classList.remove('show'));
  byId('modalBack').addEventListener('click', (e)=>{ if(e.target===byId('modalBack')) byId('modalBack').classList.remove('show'); });

  byId('modalConfirm').addEventListener('click', async ()=>{
    if(!modalAction) return;
    const qty = Math.max(1, parseInt(byId('modalQty').value||'1',10));
    const by = byId('modalBy').value.trim();
    const item = items.find(i=>i.code===modalAction.code);
    byId('modalBack').classList.remove('show');
    if(!item) return;
    if(by){ lastHandledBy = by; try{ localStorage.setItem('armed_handled_by', by); }catch(e){} }

    if(modalAction.type==='sell'){
      const useQty = Math.min(qty, Number(item.stock));
      applyStockDelta(item.code, -useQty);
      logMovement('sale', item, useQty, by);
      toast(`Marked ${useQty} × ${item.code} as used/sold`);
    } else {
      applyStockDelta(item.code, qty);
      logMovement('restock', item, qty, by);
      toast(`Added ${qty} to ${item.code} stock`);
    }
  });

  // ---------- Edit item modal ----------
  byId('editCancel').addEventListener('click', ()=>byId('editBack').classList.remove('show'));
  byId('editBack').addEventListener('click', (e)=>{ if(e.target===byId('editBack')) byId('editBack').classList.remove('show'); });
  byId('editConfirm').addEventListener('click', ()=>{
    if(!editCode) return;
    saveItems(items.map(i=> i.code===editCode ? {
      ...i,
      description: byId('e_desc').value.trim(),
      material: byId('e_material').value.trim(),
      dp: parseFloat(byId('e_dp').value)||0,
      rp: parseFloat(byId('e_rp').value)||0,
      mrp: parseFloat(byId('e_mrp').value)||0
    } : i));
    byId('editBack').classList.remove('show');
    toast(`${editCode} updated`);
    editCode=null;
  });

  // ---------- Add item form ----------
  byId('addForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const code = byId('f_code').value.trim();
    if(!code) return;
    if(items.some(i=>i.code.toLowerCase()===code.toLowerCase())){ toast('An item with this code already exists'); return; }
    const dp = parseFloat(byId('f_dp').value)||0;
    const rpVal = byId('f_rp').value;
    const rp = rpVal ? parseFloat(rpVal) : Math.round(dp*1.5);
    saveItems([...items, {
      code, description: byId('f_desc').value.trim(), material: byId('f_material').value.trim(),
      dp, rp, mrp: parseFloat(byId('f_mrp').value)||0, stock: parseInt(byId('f_stock').value||'0',10)
    }]);
    byId('addForm').reset();
    toast(`Added ${code} to inventory`);
  });

  // ---------- Bulk import ----------
  byId('fileInput').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type:'array'});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, {defval:''});
      const norm = k => String(k).toLowerCase().replace(/[^a-z]/g,'');
      let added=0, updated=0;
      let itemMap = new Map(items.map(i=>[i.code.toLowerCase(), {...i}]));
      rows.forEach(row=>{
        const rec = {};
        Object.keys(row).forEach(k=> rec[norm(k)] = row[k]);
        const code = String(rec.code ?? '').trim();
        if(!code) return;
        const dp = parseFloat(rec.dp)||0;
        const rp = rec.rp!==undefined && rec.rp!=='' ? parseFloat(rec.rp) : Math.round(dp*1.5);
        const rec2 = {
          code, description: String(rec.description ?? '').trim(), material: String(rec.material ?? '').trim(),
          dp, rp, mrp: parseFloat(rec.mrp)||0, stock: parseInt(rec.stock ?? 0,10)||0
        };
        if(itemMap.has(code.toLowerCase())) updated++; else added++;
        itemMap.set(code.toLowerCase(), rec2);
      });
      saveItems([...itemMap.values()]);
      toast(`Import complete: ${added} added, ${updated} updated`);
    }catch(err){ toast('Could not read that file'); }
    e.target.value='';
  });

  // ---------- Browser download helper (plain file save — works on any normal website) ----------
  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }

  // ---------- Download Excel ----------
  byId('downloadBtn').addEventListener('click', ()=>{
    const rows = items.map(i=>({Code:i.code, Description:i.description, Material:i.material, DP:i.dp, 'RP (DP+50%)':i.rp, MRP:i.mrp, Stock:i.stock}));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
    const out = XLSX.write(wb, {type:'array', bookType:'xlsx'});
    const blob = new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    downloadBlob(blob, 'AR_Medequip_Inventory.xlsx');
    toast('Excel file downloaded');
  });

  byId('downloadReportBtn').addEventListener('click', ()=>{
    const monthRows = monthlyData().map(r=>({Month: monthLabel(r.key), 'Units Sold': r.qty, 'Cost (DP Total)': r.cost, 'To Collect from Partner (RP Total)': r.amount, 'Your Profit': r.profit}));
    const activityRows = activity.map(s=>({Date: new Date(s.ts).toLocaleString('en-IN'), Type: s.reversed?'Reversed':(s.type==='sale'?'Used/Sold':'Stock Added'), Code:s.code, Description:s.description, Qty:s.qty, DP:s.dp, RP:s.rp, Amount: s.type==='sale'?s.amount:'', Profit: s.type==='sale'?s.profit:'', 'Handled By': s.by||''}));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthRows), 'Monthly Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(activityRows), 'Activity Log');
    const out = XLSX.write(wb, {type:'array', bookType:'xlsx'});
    const blob = new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    downloadBlob(blob, 'AR_Medequip_Sales_Report.xlsx');
    toast('Report downloaded');
  });

  // ---------- CRM ----------
  function todayStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  const STATUS_LABEL = {lead:'Lead', active:'Active', inactive:'Inactive'};
  function fmtDate(str){ if(!str) return '—'; const [y,m,d]=str.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }

  function renderCrm(){
    const q = byId('crmSearch').value.trim().toLowerCase();
    const st = byId('crmStatus').value;
    const today = todayStr();
    const isDue = c => c.status!=='inactive' && c.nextFollowUp && c.nextFollowUp<=today;
    const due = customers.filter(isDue).length;
    byId('dueCount').textContent = due ? `(${due})` : '';
    const rows = customers.filter(c=>{
      if(st && c.status!==st) return false;
      if(!q) return true;
      return [c.name,c.phone,c.org,c.city].some(v=>String(v||'').toLowerCase().includes(q));
    }).sort((a,b)=> (a.nextFollowUp||'9999').localeCompare(b.nextFollowUp||'9999') || (b.ts-a.ts));
    byId('crmEmpty').style.display = rows.length ? 'none' : '';
    byId('crmBody').innerHTML = rows.map(c=>{
      const od = isDue(c);
      const last = (c.log && c.log.length) ? c.log[c.log.length-1] : null;
      return `
      <tr>
        <td class="code-cell">${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.phone||'—')}</td>
        <td class="desc-cell">${escapeHtml(c.org||'—')}</td>
        <td>${escapeHtml(c.city||'—')}</td>
        <td><span class="type-chip ${c.status}">${STATUS_LABEL[c.status]||c.status}</span></td>
        <td class="${od?'due-cell':''}">${fmtDate(c.nextFollowUp)}${od?'<span class="low-tag">Follow-up due</span>':''}</td>
        <td class="desc-cell">${last ? escapeHtml(last.note) : '—'}</td>
        <td class="actions-cell">
          <button class="btn btn-teal btn-sm" data-crm-fu="${escapeHtml(c.id)}">+ Follow-up</button>
          <button class="btn-icon" data-crm-edit="${escapeHtml(c.id)}" title="Edit">✏️</button>
          <button class="btn-danger" data-crm-del="${escapeHtml(c.id)}" title="Delete">🗑</button>
        </td>
      </tr>`;
    }).join('');
  }
  byId('crmSearch').addEventListener('input', renderCrm);
  byId('crmStatus').addEventListener('change', renderCrm);

  async function persistCustomer(rec){
    if(!db){ toast('Live sync unavailable — not saved'); return; }
    try{ await db.collection('customers').doc(rec.id).set(rec); }
    catch(e){ toast('Save failed — try again'); }
  }

  function openCustomerModal(id){
    crmEditId = id || null;
    const c = id ? customers.find(x=>x.id===id) : null;
    byId('crmTitle').textContent = c ? 'Edit Customer' : 'Add Customer';
    byId('c_name').value = c ? c.name : '';
    byId('c_phone').value = c ? (c.phone||'') : '';
    byId('c_org').value = c ? (c.org||'') : '';
    byId('c_city').value = c ? (c.city||'') : '';
    byId('c_address').value = c ? (c.address||'') : '';
    byId('c_gstin').value = c ? (c.gstin||'') : '';
    byId('c_status').value = c ? c.status : 'lead';
    byId('c_next').value = c ? (c.nextFollowUp||'') : '';
    byId('c_notes').value = c ? (c.notes||'') : '';
    byId('crmBack').classList.add('show');
  }
  byId('crmAddBtn').addEventListener('click', ()=>openCustomerModal(null));
  byId('crmCancel').addEventListener('click', ()=>byId('crmBack').classList.remove('show'));
  byId('crmBack').addEventListener('click', e=>{ if(e.target===byId('crmBack')) byId('crmBack').classList.remove('show'); });
  byId('crmSave').addEventListener('click', ()=>{
    const name = byId('c_name').value.trim();
    if(!name){ toast('Name is required'); return; }
    const base = {
      name, phone: byId('c_phone').value.trim(), org: byId('c_org').value.trim(), city: byId('c_city').value.trim(),
      address: byId('c_address').value.trim(), gstin: byId('c_gstin').value.trim(),
      status: byId('c_status').value, nextFollowUp: byId('c_next').value || '', notes: byId('c_notes').value.trim()
    };
    let rec;
    if(crmEditId){
      rec = {...customers.find(c=>c.id===crmEditId), ...base};
      customers = customers.map(c=> c.id===crmEditId ? rec : c);
    } else {
      rec = {id: genId('cu'), log: [], ts: Date.now(), ...base};
      customers = [rec, ...customers];
    }
    byId('crmBack').classList.remove('show');
    renderCrm();
    persistCustomer(rec);
    toast(crmEditId ? 'Customer updated' : 'Customer added');
    crmEditId = null;
  });

  function openFollowUp(id){
    const c = customers.find(x=>x.id===id); if(!c) return;
    fuId = id;
    byId('fuSub').textContent = c.name + (c.org ? ' — '+c.org : '');
    const log = (c.log||[]).slice(-6).reverse();
    byId('fuHistory').innerHTML = log.length
      ? log.map(l=>`<div><b>${new Date(l.ts).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}</b> — ${escapeHtml(l.note)}</div>`).join('')
      : '<div>No follow-up notes yet.</div>';
    byId('f_note').value = '';
    byId('f_next').value = c.nextFollowUp || '';
    byId('f_status').value = c.status;
    byId('fuBack').classList.add('show');
  }
  byId('fuCancel').addEventListener('click', ()=>byId('fuBack').classList.remove('show'));
  byId('fuBack').addEventListener('click', e=>{ if(e.target===byId('fuBack')) byId('fuBack').classList.remove('show'); });
  byId('fuSave').addEventListener('click', ()=>{
    const c = customers.find(x=>x.id===fuId); if(!c) return;
    const note = byId('f_note').value.trim();
    const log = note ? [...(c.log||[]), {ts: Date.now(), note}] : (c.log||[]);
    const rec = {...c, log, nextFollowUp: byId('f_next').value || '', status: byId('f_status').value};
    customers = customers.map(x=> x.id===fuId ? rec : x);
    byId('fuBack').classList.remove('show');
    renderCrm();
    persistCustomer(rec);
    toast('Follow-up saved');
    fuId = null;
  });

  document.addEventListener('click', (e)=>{
    const fu = e.target.closest('button[data-crm-fu]');
    const ed = e.target.closest('button[data-crm-edit]');
    const dl = e.target.closest('button[data-crm-del]');
    if(fu) openFollowUp(fu.dataset.crmFu);
    else if(ed) openCustomerModal(ed.dataset.crmEdit);
    else if(dl){
      const id = dl.dataset.crmDel;
      const c = customers.find(x=>x.id===id); if(!c) return;
      askConfirm('Delete customer?', `"${c.name}" and their entire follow-up history will be permanently deleted.`, async ()=>{
        customers = customers.filter(x=>x.id!==id);
        renderCrm();
        if(db){ try{ await db.collection('customers').doc(id).delete(); }catch(err){} }
        toast('Customer deleted');
      });
    }
  });

  // ---------- PO / Invoice ----------
  function docNextNumber(type){
    const prefix = type==='po' ? 'PO' : 'INV';
    let max = 0;
    documents.filter(d=>d.type===type).forEach(d=>{
      const n = parseInt(String(d.number||'').split('-')[1],10);
      if(!isNaN(n) && n>max) max = n;
    });
    return `${prefix}-${String(max+1).padStart(4,'0')}`;
  }

  function populateDocItemSelect(){
    const sel = byId('doc_itemSelect');
    const list = items.slice().sort((a,b)=>a.code.localeCompare(b.code, undefined, {numeric:true}));
    sel.innerHTML = list.map(i=>`<option value="${escapeHtml(i.code)}">${escapeHtml(i.code)} — ${escapeHtml(i.description)}</option>`).join('');
  }

  function populatePartyList(){
    const isPo = docType==='po';
    const names = isPo ? suppliers.map(s=>s.name) : customers.map(c=>c.name);
    byId('doc_partyList').innerHTML = names.map(n=>`<option value="${escapeHtml(n)}">`).join('');
  }

  function gstBreakup(subtotal, gstType, gstRate){
    if(gstType==='none' || !gstRate) return {cgst:0, sgst:0, igst:0, tax:0};
    const tax = subtotal * (Number(gstRate)/100);
    if(gstType==='intra') return {cgst:tax/2, sgst:tax/2, igst:0, tax};
    return {cgst:0, sgst:0, igst:tax, tax};
  }

  function renderDocLines(){
    byId('docLinesEmpty').style.display = docLines.length ? 'none' : '';
    byId('docLinesBody').innerHTML = docLines.map((l,idx)=>`
      <tr>
        <td class="code-cell">${escapeHtml(l.code)}</td>
        <td class="desc-cell">${escapeHtml(l.description)}</td>
        <td>${l.qty}</td>
        <td><input type="number" min="0" step="0.01" class="line-price-input" data-line-idx="${idx}" value="${l.unitPrice}" style="width:90px; padding:6px 8px;"></td>
        <td class="rp-cell">${fmtMoney(l.qty*l.unitPrice)}</td>
        <td><button type="button" class="remove-x" data-rm-line="${idx}">×</button></td>
      </tr>`).join('');
    const subtotal = docLines.reduce((s,l)=>s+l.qty*l.unitPrice,0);
    const gst = gstBreakup(subtotal, byId('doc_gstType').value, byId('doc_gstRate').value);
    let line = 'Subtotal: ' + fmtMoney(subtotal);
    if(gst.tax>0){
      if(gst.igst>0) line += ` + IGST: ${fmtMoney(gst.igst)}`;
      else line += ` + CGST: ${fmtMoney(gst.cgst)} + SGST: ${fmtMoney(gst.sgst)}`;
    }
    line += ' = Total: ' + fmtMoney(subtotal+gst.tax);
    byId('docTotal').textContent = line;
  }
  document.addEventListener('input', (e)=>{
    if(e.target.classList.contains('line-price-input')){
      const idx = parseInt(e.target.dataset.lineIdx,10);
      if(docLines[idx]){ docLines[idx].unitPrice = parseFloat(e.target.value)||0; renderDocLines(); }
    }
  });
  byId('doc_gstType').addEventListener('change', renderDocLines);
  byId('doc_gstRate').addEventListener('input', renderDocLines);

  function renderDocsTab(){
    populateDocItemSelect();
    populatePartyList();
    const isPo = docType==='po';
    byId('docBuilderTitle').textContent = isPo ? 'New Purchase Order' : 'New Invoice';
    byId('docBuilderSub').textContent = isPo
      ? 'Create a PO to order stock from the company — uses the DP price (you can override it).'
      : 'Cut an invoice for a partner or customer — uses the RP price (you can override it).';
    byId('docPartyLabel').textContent = isPo ? 'Supplier' : 'Bill To';
    byId('docPartyHead').textContent = isPo ? 'Supplier' : 'Bill To';
    byId('docPartyGstLabel').textContent = isPo ? 'Supplier GSTIN (optional)' : 'Buyer GSTIN (optional)';
    byId('docSaveParty').style.display = isPo ? '' : 'none';
    document.querySelectorAll('.invoice-only').forEach(el=> el.style.display = isPo ? 'none' : '');
    const rows = documents.filter(d=>d.type===docType).sort((a,b)=>b.ts-a.ts);
    byId('docHistEmpty').style.display = rows.length ? 'none' : '';
    byId('docHistBody').innerHTML = rows.map(d=>`
      <tr>
        <td class="code-cell">${escapeHtml(d.number)}</td>
        <td>${fmtDate(d.date)}</td>
        <td class="desc-cell">${escapeHtml(d.party||'—')}</td>
        <td>${d.items.length}</td>
        <td class="rp-cell">${fmtMoney(d.total)}</td>
        <td><button class="btn btn-outline btn-sm" data-redownload="${escapeHtml(d.id)}">⬇️ PDF</button></td>
      </tr>`).join('');
  }

  document.querySelectorAll('.chip-btn[data-doctype]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.chip-btn[data-doctype]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      docType = btn.dataset.doctype;
      docLines = [];
      byId('doc_party').value = '';
      renderDocLines();
      renderDocsTab();
      fillPartyGstin();
    });
  });

  function fillDocPrice(){
    const code = byId('doc_itemSelect').value;
    const item = items.find(i=>i.code===code);
    if(item) byId('doc_price').value = docType==='po' ? item.dp : item.rp;
  }
  byId('doc_itemSelect').addEventListener('change', fillDocPrice);

  function fillPartyGstin(){
    const name = byId('doc_party').value.trim();
    const isPo = docType==='po';
    const rec = isPo ? suppliers.find(s=>s.name===name) : customers.find(c=>c.name===name);
    // Always set (even to empty) so a previous party's GSTIN never lingers on screen.
    byId('doc_partyGstin').value = (rec && rec.gstin) ? rec.gstin : '';

    const prev = byId('doc_partyPreview');
    if(!name){ prev.textContent = ''; return; }
    if(!rec){ prev.textContent = '🆕 New party — no saved detail yet. Use "+ Save detail" to store it.'; return; }
    const parts = [];
    if(isPo){
      if(rec.phone) parts.push('📞 '+rec.phone);
      if(rec.email) parts.push(rec.email);
      if(rec.address) parts.push(rec.address);
    } else {
      if(rec.org) parts.push(rec.org);
      if(rec.address) parts.push(rec.address); else if(rec.city) parts.push(rec.city);
      if(rec.phone) parts.push('📞 '+rec.phone);
    }
    prev.textContent = parts.length ? ('✓ '+parts.join(' · ')) : '✓ Saved party (no address/phone on file).';
  }
  byId('doc_party').addEventListener('input', fillPartyGstin);
  byId('doc_party').addEventListener('change', fillPartyGstin);
  byId('doc_party').addEventListener('blur', fillPartyGstin);

  byId('docAddLine').addEventListener('click', ()=>{
    const code = byId('doc_itemSelect').value;
    const item = items.find(i=>i.code===code);
    if(!item) return;
    const qty = Math.max(1, parseInt(byId('doc_qty').value||'1',10));
    const priceVal = byId('doc_price').value;
    const unitPrice = priceVal!=='' ? parseFloat(priceVal) : (docType==='po' ? item.dp : item.rp);
    const existing = docLines.find(l=>l.code===code);
    if(existing){ existing.qty += qty; }
    else docLines.push({code:item.code, description:item.description, qty, unitPrice});
    renderDocLines();
  });

  // ---------- Suppliers (PO party) ----------
  byId('docSaveParty').addEventListener('click', ()=>{
    byId('s_name').value = byId('doc_party').value.trim();
    byId('s_address').value=''; byId('s_phone').value=''; byId('s_email').value='';
    byId('s_gstin').value = byId('doc_partyGstin').value.trim();
    byId('supBack').classList.add('show');
  });
  byId('supCancel').addEventListener('click', ()=>byId('supBack').classList.remove('show'));
  byId('supBack').addEventListener('click', e=>{ if(e.target===byId('supBack')) byId('supBack').classList.remove('show'); });
  byId('supSave').addEventListener('click', async ()=>{
    const name = byId('s_name').value.trim();
    if(!name){ toast('Enter the supplier name'); return; }
    const rec = {
      id: genId('sup'), name, address: byId('s_address').value.trim(), phone: byId('s_phone').value.trim(),
      email: byId('s_email').value.trim(), gstin: byId('s_gstin').value.trim(), ts: Date.now()
    };
    const existingIdx = suppliers.findIndex(s=>s.name.toLowerCase()===name.toLowerCase());
    if(existingIdx>=0){ rec.id = suppliers[existingIdx].id; suppliers[existingIdx] = rec; }
    else suppliers = [rec, ...suppliers];
    byId('doc_party').value = name;
    populatePartyList();
    fillPartyGstin();
    byId('supBack').classList.remove('show');
    if(db){ try{ await db.collection('suppliers').doc(rec.id).set(rec); }catch(e){} }
    toast('Supplier saved');
  });

  document.addEventListener('click', (e)=>{
    const rm = e.target.closest('button[data-rm-line]');
    if(rm){ docLines.splice(parseInt(rm.dataset.rmLine,10),1); renderDocLines(); }
  });

  function rs(n){ return fmtMoney(n).replace('₹','Rs. '); }

  function buildPdfBlob(d){
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({unit:'pt', format:'a4'});
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 36;
    const fullW = pageW - margin*2;
    let y = margin;

    function hline(yy){ doc.setDrawColor(170,170,170); doc.line(margin, yy, pageW-margin, yy); }
    function box(yy, hh){ doc.setDrawColor(170,170,170); doc.rect(margin, yy, fullW, hh); }

    if(d.type!=='invoice'){
      // ---------- Simple Purchase Order layout ----------
      doc.setFont('helvetica','bold'); doc.setFontSize(18);
      doc.text('AR Medequip Enterprises', margin, y+16);
      doc.setFontSize(11); doc.setFont('helvetica','normal');
      doc.text('Stock & Sales Manager', margin, y+34);
      if(d.myGstin){ doc.text(`GSTIN: ${d.myGstin}`, margin, y+49); }

      doc.setFont('helvetica','bold'); doc.setFontSize(16);
      doc.text('PURCHASE ORDER', pageW-margin, y+16, {align:'right'});
      doc.setFont('helvetica','normal'); doc.setFontSize(11);
      doc.text(`No: ${d.number}`, pageW-margin, y+34, {align:'right'});
      doc.text(`Date: ${fmtDate(d.date)}`, pageW-margin, y+50, {align:'right'});

      y += 75; hline(y); y += 20;
      doc.setFont('helvetica','bold'); doc.text('Supplier:', margin, y);
      doc.setFont('helvetica','normal'); doc.text(d.party || '—', margin+70, y);
      const sup = suppliers.find(s=>s.name===d.party);
      if(sup && sup.address){
        const addrLines = doc.splitTextToSize(sup.address, fullW-70);
        doc.text(addrLines, margin+70, y+14); y += addrLines.length*12;
      }
      if(sup && sup.phone){ y += 14; doc.text(`Phone: ${sup.phone}`, margin+70, y); }
      if(sup && sup.email){ y += 14; doc.text(`Email: ${sup.email}`, margin+70, y); }
      if(d.partyGstin){ y += 14; doc.text(`GSTIN: ${d.partyGstin}`, margin+70, y); }
      y += 24;

      const cols = [
        {label:'#', x:margin, w:25},{label:'Code', x:margin+25, w:60},{label:'Description', x:margin+85, w:230},
        {label:'Qty', x:margin+315, w:40},{label:'Unit Price', x:margin+360, w:75},{label:'Amount', x:margin+440, w:75}
      ];
      doc.setFillColor(15,118,110); doc.rect(margin, y, fullW, 22, 'F');
      doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(10);
      cols.forEach(c=> doc.text(c.label, c.x+4, y+15));
      y += 22; doc.setTextColor(20,20,20); doc.setFont('helvetica','normal');

      d.items.forEach((it,idx)=>{
        if(y > 760){ doc.addPage(); y = 50; }
        const rowH = 20;
        if(idx%2===1){ doc.setFillColor(245,248,247); doc.rect(margin, y, fullW, rowH, 'F'); }
        doc.text(String(idx+1), cols[0].x+4, y+14);
        doc.text(String(it.code), cols[1].x+4, y+14);
        doc.text(String(it.description).slice(0,48), cols[2].x+4, y+14);
        doc.text(String(it.qty), cols[3].x+4, y+14);
        doc.text(rs(it.unitPrice), cols[4].x+4, y+14);
        doc.text(rs(it.qty*it.unitPrice), cols[5].x+4, y+14);
        y += rowH;
      });

      y += 10; hline(y); y += 18;
      doc.setFont('helvetica','normal'); doc.setFontSize(10);
      doc.text('Subtotal: ' + rs(d.subtotal), pageW-margin, y, {align:'right'});
      if(d.gstType!=='none' && d.taxAmount>0){
        if(d.gstType==='inter'){ y+=15; doc.text(`IGST (${d.gstRate}%): `+rs(d.igst), pageW-margin, y, {align:'right'}); }
        else{
          y+=15; doc.text(`CGST (${(d.gstRate/2).toFixed(1)}%): `+rs(d.cgst), pageW-margin, y, {align:'right'});
          y+=15; doc.text(`SGST (${(d.gstRate/2).toFixed(1)}%): `+rs(d.sgst), pageW-margin, y, {align:'right'});
        }
      }
      y += 20; doc.setFont('helvetica','bold'); doc.setFontSize(13);
      doc.text('Grand Total: ' + rs(d.total), pageW-margin, y, {align:'right'});

      if(d.notes){
        y += 34; doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.text('Notes:', margin, y);
        doc.setFont('helvetica','normal');
        const split = doc.splitTextToSize(d.notes, fullW);
        doc.text(split, margin, y+14); y += 14 + split.length*12;
      }
      y = Math.max(y+50, 740);
      if(y>780){ doc.addPage(); y=100; }
      doc.setDrawColor(150,150,150); doc.line(margin, y, margin+160, y);
      doc.setFontSize(9); doc.text('Authorized Signatory', margin, y+12);
      return doc.output('blob');
    }

    // ---------- Full GST Tax Invoice layout ----------
    doc.setFont('helvetica','bold'); doc.setFontSize(13);
    doc.text('Tax Invoice', pageW/2, y+16, {align:'center'});
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text('(ORIGINAL FOR RECIPIENT)', pageW-margin, y+16, {align:'right'});
    y += 26; hline(y);

    // Seller block
    const sellerTop = y;
    doc.setFont('helvetica','bold'); doc.setFontSize(12);
    doc.text('AR Medequip Enterprises', margin+4, y+16);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    let sy = y+29;
    if(d.myAddress){ const al = doc.splitTextToSize(d.myAddress, fullW/2-10); doc.text(al, margin+4, sy); sy += al.length*11; }
    if(d.myState){ doc.text(`State: ${d.myState}`, margin+4, sy); sy += 12; }
    if(d.myGstin){ doc.text(`GSTIN/UIN: ${d.myGstin}`, margin+4, sy); sy += 12; }
    if(d.myPan){ doc.text(`PAN: ${d.myPan}`, margin+4, sy); sy += 12; }

    // Invoice meta block (right half)
    const metaX = margin + fullW/2;
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    let my2 = y+14;
    const metaRow = (label,val)=>{ doc.text(label, metaX+4, my2); doc.text(String(val||'—'), metaX+fullW*0.32, my2); my2+=16; };
    metaRow('Invoice No.:', d.number);
    metaRow('Dated:', fmtDate(d.date));
    metaRow('Place of Supply:', d.myState || '—');
    metaRow('Terms of Payment:', 'Immediate');

    y = Math.max(sy, my2) + 8;
    doc.setDrawColor(170,170,170); doc.line(margin, y, pageW-margin, y);
    doc.line(metaX, sellerTop, metaX, y);

    // Buyer block
    y += 16;
    doc.setFont('helvetica','bold'); doc.setFontSize(10);
    doc.text('Buyer (Bill To):', margin+4, y);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    y += 13;
    doc.setFont('helvetica','bold'); doc.text(d.party || '—', margin+4, y); doc.setFont('helvetica','normal');
    const cust = customers.find(c=>c.name===d.party);
    if(cust && cust.address){
      y += 12;
      const cal = doc.splitTextToSize(cust.address, fullW/2-10);
      doc.text(cal, margin+4, y); y += (cal.length-1)*11;
    } else if(cust && (cust.org || cust.city)){
      y += 12; doc.text([cust.org, cust.city].filter(Boolean).join(', '), margin+4, y);
    }
    if(d.partyGstin){ y += 12; doc.text(`GSTIN/UIN: ${d.partyGstin}`, margin+4, y); }
    y += 18; hline(y); y += 6;

    // Item table
    const hsn = d.hsn || '—';
    const cols = [
      {label:'Sl', x:margin, w:22},
      {label:'Description of Goods', x:margin+22, w:190},
      {label:'HSN/SAC', x:margin+212, w:55},
      {label:'Qty', x:margin+267, w:40},
      {label:'Rate', x:margin+307, w:65},
      {label:'per', x:margin+372, w:30},
      {label:'Amount', x:margin+402, w:fullW-402}
    ];
    y += 8;
    doc.setFillColor(15,118,110); doc.rect(margin, y, fullW, 22, 'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(9);
    cols.forEach(c=> doc.text(c.label, c.x+4, y+15));
    y += 22; doc.setTextColor(20,20,20); doc.setFont('helvetica','normal'); doc.setFontSize(9);

    d.items.forEach((it,idx)=>{
      if(y > 740){ doc.addPage(); y = 50; }
      const rowH = 20;
      if(idx%2===1){ doc.setFillColor(245,248,247); doc.rect(margin, y, fullW, rowH, 'F'); }
      doc.text(String(idx+1), cols[0].x+4, y+14);
      doc.text(String(it.description).slice(0,46)+` (${it.code})`, cols[1].x+4, y+14);
      doc.text(hsn, cols[2].x+4, y+14);
      doc.text(String(it.qty), cols[3].x+4, y+14);
      doc.text(rs(it.unitPrice), cols[4].x+4, y+14);
      doc.text('Pcs', cols[5].x+4, y+14);
      doc.text(rs(it.qty*it.unitPrice), cols[6].x+4, y+14, {align:'left'});
      y += rowH;
    });
    y += 4; hline(y);

    // Totals block
    y += 16;
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text('Subtotal', cols[1].x, y); doc.text(rs(d.subtotal), pageW-margin, y, {align:'right'});
    if(d.gstType!=='none' && d.taxAmount>0){
      if(d.gstType==='inter'){ y+=14; doc.text(`IGST Output (${d.gstRate}%)`, cols[1].x, y); doc.text(rs(d.igst), pageW-margin, y, {align:'right'}); }
      else{
        y+=14; doc.text(`CGST Output (${(d.gstRate/2).toFixed(1)}%)`, cols[1].x, y); doc.text(rs(d.cgst), pageW-margin, y, {align:'right'});
        y+=14; doc.text(`SGST Output (${(d.gstRate/2).toFixed(1)}%)`, cols[1].x, y); doc.text(rs(d.sgst), pageW-margin, y, {align:'right'});
      }
    }
    if(d.roundOff){ y+=14; doc.text('Round Off', cols[1].x, y); doc.text(rs(d.roundOff), pageW-margin, y, {align:'right'}); }
    y += 18; hline(y); y += 16;
    doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.text('Total', cols[1].x, y); doc.text(rs(d.total), pageW-margin, y, {align:'right'});
    y += 16; hline(y);

    // Amount in words
    y += 16;
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.text('Amount Chargeable (in words):', margin, y);
    doc.setFont('helvetica','normal');
    const words = doc.splitTextToSize(amountInWords(d.total), fullW);
    doc.text(words, margin, y+13); y += 13 + words.length*12;

    // HSN-wise tax summary table (single HSN simplification)
    if(d.gstType!=='none' && d.taxAmount>0){
      y += 10;
      const tCols = [
        {label:'HSN/SAC', x:margin, w:70},{label:'Taxable Value', x:margin+70, w:90},
        {label:'CGST', x:margin+160, w:90},{label:'SGST/IGST', x:margin+250, w:90},
        {label:'Total Tax', x:margin+340, w:fullW-340}
      ];
      doc.setFillColor(235,240,239); doc.rect(margin, y, fullW, 20, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
      tCols.forEach(c=>doc.text(c.label, c.x+3, y+14));
      y += 20;
      doc.setFont('helvetica','normal');
      doc.text(hsn, tCols[0].x+3, y+14);
      doc.text(rs(d.subtotal), tCols[1].x+3, y+14);
      doc.text(d.gstType==='inter' ? '—' : rs(d.cgst), tCols[2].x+3, y+14);
      doc.text(d.gstType==='inter' ? rs(d.igst) : rs(d.sgst), tCols[3].x+3, y+14);
      doc.text(rs(d.taxAmount), tCols[4].x+3, y+14);
      y += 20; hline(y);
      y += 14;
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text('Tax Amount (in words):', margin, y);
      doc.setFont('helvetica','normal');
      const twords = doc.splitTextToSize(amountInWords(d.taxAmount), fullW);
      doc.text(twords, margin, y+13); y += 13 + twords.length*12;
    }

    // Bank details + PAN
    if(d.bankName || d.bankAccNo || d.myPan){
      y += 14;
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text("Company's Bank Details", margin, y); y += 13;
      doc.setFont('helvetica','normal');
      if(d.bankAcc){ doc.text(`A/c Holder Name: ${d.bankAcc}`, margin, y); y+=12; }
      if(d.bankName){ doc.text(`Bank Name: ${d.bankName}`, margin, y); y+=12; }
      if(d.bankAccNo){ doc.text(`A/c No.: ${d.bankAccNo}`, margin, y); y+=12; }
      if(d.bankIfsc){ doc.text(`IFSC & Branch: ${d.bankIfsc}`, margin, y); y+=12; }
      if(d.myPan){ doc.text(`Company's PAN: ${d.myPan}`, margin, y); y+=12; }
    }

    if(d.notes){
      y += 14; doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text('Notes:', margin, y);
      doc.setFont('helvetica','normal');
      const split = doc.splitTextToSize(d.notes, fullW); doc.text(split, margin, y+13); y += 13+split.length*12;
    }

    y += 10;
    doc.setFont('helvetica','italic'); doc.setFontSize(8);
    const decl = doc.splitTextToSize('Declaration: We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.', fullW-170);
    doc.text(decl, margin, y+10);

    doc.setFont('helvetica','normal');
    doc.text('for AR Medequip Enterprises', pageW-margin, y, {align:'right'});
    doc.setFontSize(9);
    doc.text('Authorized Signatory', pageW-margin, y+44, {align:'right'});

    y += Math.max(decl.length*10, 50) + 16;
    doc.setFontSize(8); doc.setTextColor(120,120,120);
    doc.text('This is a Computer Generated Invoice', pageW/2, Math.min(y, 800), {align:'center'});

    return doc.output('blob');
  }

  async function downloadDoc(d){
    const blob = buildPdfBlob(d);
    downloadBlob(blob, `${d.number}.pdf`);
    toast('PDF downloaded');
  }

  document.addEventListener('click', (e)=>{
    const rd = e.target.closest('button[data-redownload]');
    if(!rd) return;
    const d = documents.find(x=>x.id===rd.dataset.redownload);
    if(d) downloadDoc(d);
  });

  byId('docSaveBtn').addEventListener('click', async ()=>{
    const party = byId('doc_party').value.trim();
    if(!party){ toast('Enter the Supplier/Bill To name'); return; }
    if(!docLines.length){ toast('Add at least one item'); return; }
    const subtotal = docLines.reduce((s,l)=>s+l.qty*l.unitPrice,0);
    const gstType = byId('doc_gstType').value;
    const gstRate = parseFloat(byId('doc_gstRate').value)||0;
    const gst = gstBreakup(subtotal, gstType, gstRate);
    const myGstin = byId('doc_myGstin').value.trim();
    const partyGstin = byId('doc_partyGstin').value.trim();
    saveCompanyProfile();
    const roundOff = Math.round(subtotal+gst.tax) - (subtotal+gst.tax);
    const d = {
      id: genId('doc'), type: docType, number: docNextNumber(docType),
      date: byId('doc_date').value || todayStr(), party, myGstin, partyGstin,
      myAddress: byId('doc_myAddress').value.trim(), myState: byId('doc_myState').value.trim(),
      myPan: byId('doc_myPan').value.trim(), hsn: byId('doc_hsn').value.trim(),
      bankName: byId('doc_bankName').value.trim(), bankAcc: byId('doc_bankAcc').value.trim(),
      bankAccNo: byId('doc_bankAccNo').value.trim(), bankIfsc: byId('doc_bankIfsc').value.trim(),
      gstType, gstRate, cgst:gst.cgst, sgst:gst.sgst, igst:gst.igst, taxAmount:gst.tax, roundOff,
      items: docLines.map(l=>({...l})), subtotal, total: Math.round(subtotal+gst.tax),
      notes: byId('doc_notes').value.trim(), ts: Date.now()
    };
    documents = [d, ...documents];
    renderDocsTab();
    if(db){ try{ await db.collection('documents').doc(d.id).set(d); }catch(e){ /* non-fatal */ } }
    await downloadDoc(d);
    docLines = [];
    byId('doc_party').value=''; byId('doc_notes').value=''; byId('doc_partyGstin').value=''; byId('doc_partyPreview').textContent='';
    renderDocsTab();
    renderDocLines();
    toast(`${d.number} saved`);
  });

  function loadCompanyProfile(){
    try{
      const p = JSON.parse(localStorage.getItem('armed_company_profile')||'{}');
      byId('doc_myGstin').value = p.gstin||'';
      byId('doc_myAddress').value = p.address||'';
      byId('doc_myState').value = p.state||'';
      byId('doc_myPan').value = p.pan||'';
      byId('doc_hsn').value = p.hsn||'';
      byId('doc_bankName').value = p.bankName||'';
      byId('doc_bankAcc').value = p.bankAcc||'';
      byId('doc_bankAccNo').value = p.bankAccNo||'';
      byId('doc_bankIfsc').value = p.bankIfsc||'';
    }catch(e){}
  }
  function saveCompanyProfile(){
    try{
      localStorage.setItem('armed_company_profile', JSON.stringify({
        gstin: byId('doc_myGstin').value.trim(), address: byId('doc_myAddress').value.trim(),
        state: byId('doc_myState').value.trim(), pan: byId('doc_myPan').value.trim(),
        hsn: byId('doc_hsn').value.trim(), bankName: byId('doc_bankName').value.trim(),
        bankAcc: byId('doc_bankAcc').value.trim(), bankAccNo: byId('doc_bankAccNo').value.trim(),
        bankIfsc: byId('doc_bankIfsc').value.trim()
      }));
    }catch(e){}
  }

  // Indian numbering (Lakh/Crore) number-to-words, for "Amount in words"
  const NUM_ONES = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const NUM_TENS = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function twoDigitWords(n){
    if(n<20) return NUM_ONES[n];
    return NUM_TENS[Math.floor(n/10)] + (n%10 ? ' '+NUM_ONES[n%10] : '');
  }
  function threeDigitWords(n){
    if(n>=100) return NUM_ONES[Math.floor(n/100)] + ' Hundred' + (n%100 ? ' '+twoDigitWords(n%100) : '');
    return twoDigitWords(n);
  }
  function numberToWordsIndian(num){
    num = Math.round(num);
    if(num===0) return 'Zero';
    let parts = [];
    const crore = Math.floor(num/10000000); num %= 10000000;
    const lakh = Math.floor(num/100000); num %= 100000;
    const thousand = Math.floor(num/1000); num %= 1000;
    const rest = num;
    if(crore) parts.push(threeDigitWords(crore)+' Crore');
    if(lakh) parts.push(threeDigitWords(lakh)+' Lakh');
    if(thousand) parts.push(threeDigitWords(thousand)+' Thousand');
    if(rest) parts.push(threeDigitWords(rest));
    return parts.join(' ');
  }
  function amountInWords(n){
    const rupees = Math.floor(n);
    const paise = Math.round((n-rupees)*100);
    let s = 'Indian Rupees ' + numberToWordsIndian(rupees) + ' Only';
    if(paise) s = 'Indian Rupees ' + numberToWordsIndian(rupees) + ' and ' + numberToWordsIndian(paise) + ' Paise Only';
    return s;
  }

  byId('doc_date').value = todayStr();
  loadCompanyProfile();
  ['doc_myGstin','doc_myAddress','doc_myState','doc_myPan','doc_hsn','doc_bankName','doc_bankAcc','doc_bankAccNo','doc_bankIfsc'].forEach(id=>{
    byId(id).addEventListener('change', saveCompanyProfile);
  });
  renderDocLines();

  // ---------- Ledger ----------
  function populateLedgerParty(){
    const isCust = ledgerPartyType==='customer';
    byId('ledgerPartyLabel').textContent = isCust ? 'Select Customer' : 'Select Supplier';
    byId('ledgerBalLabel').textContent = isCust ? 'Balance Due (Receivable)' : 'Balance Payable';
    // Include every party name that appears anywhere (saved contact, an invoice/PO, or a payment) —
    // not just names formally saved in CRM/Suppliers, so ad-hoc names typed directly on a document still show up.
    const names = new Set((isCust ? customers : suppliers).map(x=>x.name));
    documents.filter(d=> d.type===(isCust?'invoice':'po') && d.party).forEach(d=> names.add(d.party));
    payments.filter(p=> p.partyType===ledgerPartyType && p.party).forEach(p=> names.add(p.party));
    const list = [...names].sort();
    const sel = byId('ledger_party');
    const current = sel.value;
    sel.innerHTML = list.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    if(list.includes(current)) sel.value = current; else if(list.length) sel.value = list[0];
  }

  function ledgerEntries(partyType, party){
    const entries = [];
    if(partyType==='customer'){
      documents.filter(d=>d.type==='invoice' && d.party===party).forEach(d=>{
        entries.push({ts:d.ts, date:d.date, particulars:`Invoice ${d.number}`, debit:d.total, credit:0});
      });
    } else {
      documents.filter(d=>d.type==='po' && d.party===party).forEach(d=>{
        entries.push({ts:d.ts, date:d.date, particulars:`Purchase Order ${d.number}`, debit:0, credit:d.total});
      });
    }
    payments.filter(p=>p.partyType===partyType && p.party===party).forEach(p=>{
      if(partyType==='customer') entries.push({ts:p.ts, date:p.date, particulars:`Payment Received${p.note?' — '+p.note:''}`, debit:0, credit:p.amount});
      else entries.push({ts:p.ts, date:p.date, particulars:`Payment Made${p.note?' — '+p.note:''}`, debit:p.amount, credit:0});
    });
    entries.sort((a,b)=> (a.date||'').localeCompare(b.date||'') || a.ts-b.ts);
    let bal = 0;
    entries.forEach(e=>{
      bal += partyType==='customer' ? (e.debit - e.credit) : (e.credit - e.debit);
      e.balance = bal;
    });
    return entries;
  }

  function renderLedger(){
    populateLedgerParty();
    const party = byId('ledger_party').value;
    if(!party){
      byId('ledgerEmpty').style.display = '';
      byId('ledgerBody').innerHTML = '';
      byId('ledgerBalance').textContent = '₹0';
      return;
    }
    const entries = ledgerEntries(ledgerPartyType, party);
    byId('ledgerEmpty').style.display = entries.length ? 'none' : '';
    byId('ledgerBody').innerHTML = entries.map(e=>`
      <tr>
        <td>${fmtDate(e.date)}</td>
        <td class="desc-cell">${escapeHtml(e.particulars)}</td>
        <td>${e.debit ? fmtMoney(e.debit) : '—'}</td>
        <td>${e.credit ? fmtMoney(e.credit) : '—'}</td>
        <td class="${e.balance<0?'due-cell':''}" style="font-weight:700;">${fmtMoney(Math.abs(e.balance))} ${e.balance<0?'(Adv.)':''}</td>
      </tr>`).join('');
    const finalBal = entries.length ? entries[entries.length-1].balance : 0;
    byId('ledgerBalance').textContent = fmtMoney(Math.abs(finalBal)) + (finalBal<0 ? ' (Advance)' : '');
  }

  document.querySelectorAll('.chip-btn[data-ptype]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.chip-btn[data-ptype]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      ledgerPartyType = btn.dataset.ptype;
      renderLedger();
    });
  });
  byId('ledger_party').addEventListener('change', renderLedger);

  byId('pay_date').value = todayStr();
  byId('paySaveBtn').addEventListener('click', async ()=>{
    const party = byId('ledger_party').value;
    if(!party){ toast('Select a party first'); return; }
    const amount = parseFloat(byId('pay_amount').value)||0;
    if(amount<=0){ toast('Enter an amount'); return; }
    const rec = {
      id: genId('pay'), partyType: ledgerPartyType, party, date: byId('pay_date').value || todayStr(),
      amount, note: byId('pay_note').value.trim(), ts: Date.now()
    };
    payments = [rec, ...payments];
    renderLedger();
    if(db){ try{ await db.collection('payments').doc(rec.id).set(rec); }catch(e){ toast('Save failed — try again'); } }
    byId('pay_amount').value=''; byId('pay_note').value='';
    toast(ledgerPartyType==='customer' ? 'Payment received recorded' : 'Payment made recorded');
  });

  // ---------- CRM Excel import ----------
  byId('crmImportBtn').addEventListener('click', ()=>byId('crmFile').click());
  byId('crmFile').addEventListener('change', async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    try{
      const wb = XLSX.read(await file.arrayBuffer(), {type:'array'});
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval:''});
      const norm = k => String(k).toLowerCase().replace(/[^a-z]/g,'');
      const have = new Set(customers.map(c=>(c.name+'|'+(c.city||'')).toLowerCase()));
      const fresh = [];
      rows.forEach((row,i)=>{
        const r = {}; Object.keys(row).forEach(k=> r[norm(k)] = row[k]);
        const name = String(r.name||r.doctorfacility||'').trim(); if(!name) return;
        const city = String(r.city||r.location||'').trim();
        const key = (name+'|'+city).toLowerCase(); if(have.has(key)) return; have.add(key);
        fresh.push({
          id: genId('cu'), name, city, phone: String(r.phone||'').trim(),
          org: String(r.hospital||r.org||r.hospitalclinic||'').trim(),
          address: String(r.address||r.fulladdress||'').trim(), gstin: String(r.gstin||'').trim(),
          status: ['lead','active','inactive'].includes(String(r.status||'').toLowerCase()) ? String(r.status).toLowerCase() : 'lead',
          nextFollowUp: '', notes: String(r.notes||'').trim(), log: [], ts: Date.now()+i
        });
      });
      customers = [...fresh, ...customers]; renderCrm(); renderDashboard();
      if(db){
        for(let i=0;i<fresh.length;i+=400){
          const batch = db.batch();
          fresh.slice(i,i+400).forEach(c=> batch.set(db.collection('customers').doc(c.id), c));
          await batch.commit();
        }
      }
      toast(`Imported ${fresh.length} customers`);
    }catch(err){ console.error(err); toast('Could not import that file'); }
    e.target.value='';
  });

  // ---------- Boot + Login ----------
  function firebaseIsConfigured(){
    return typeof firebase !== 'undefined' && window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey
      && !String(window.FIREBASE_CONFIG.apiKey).startsWith('PASTE_');
  }
  function showBanner(msg){ const b=byId('setupBanner'); b.style.display=''; if(msg) b.textContent=msg; }

  let started = false;
  function startData(){
    if(started) return; started = true;
    const onErr = (e)=>{ console.error(e); showBanner('Database error: ' + (e && e.message ? e.message : 'check Firestore rules and config.js')); };
    db.doc(INV_DOC).onSnapshot(snap=>{ items = (snap.exists && snap.data().items) ? snap.data().items : []; renderAll(); }, onErr);
    const sub = (name, order, lim, setter)=> db.collection(name).orderBy(order,'desc').limit(lim).onSnapshot(snap=>{
      setter(snap.docs.map(d=>({...d.data(), id:d.id}))); renderAll();
    }, onErr);
    sub('customers','ts',2000, v=>customers=v);
    sub('movements','ts',500, v=>activity=v);
    sub('documents','ts',300, v=>documents=v);
    sub('suppliers','ts',300, v=>suppliers=v);
    sub('payments','ts',1000, v=>payments=v);
  }

  function boot(){
    renderInvHeader(); renderAll();
    if(!firebaseIsConfigured()){ showBanner(); return; }
    try{
      if(!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.firestore();
    }catch(e){ showBanner('Could not connect to Firebase. Please check config.js.'); return; }

    const auth = firebase.auth();
    const overlay = byId('loginOverlay');
    async function doLogin(){
      byId('loginError').textContent = '';
      try{ await auth.signInWithEmailAndPassword(byId('loginEmail').value.trim(), byId('loginPass').value); }
      catch(e){
  console.error("Firebase login error:", e.code, e.message);
  byId('loginError').textContent =
    "Login error: " + (e.code || e.message);
}
    }
    byId('loginBtn').addEventListener('click', doLogin);
    byId('loginPass').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
    byId('logoutBtn').addEventListener('click', async ()=>{ await auth.signOut(); location.reload(); });

    auth.onAuthStateChanged(user=>{
      if(user){ overlay.style.display='none'; byId('loginPass').value=''; startData(); }
      else { overlay.style.display='flex'; }
    });
  }
  boot();
})();
