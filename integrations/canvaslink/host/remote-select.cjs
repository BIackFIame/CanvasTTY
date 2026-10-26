// Native OS select popups are outside an owned WebContents stream. Open a
// renderer-local list only for an authenticated remote pointer on a select.
function selectAtPoint(x,y){
 const select=document.elementFromPoint(x,y)?.closest('select');
 if(!select||select.disabled||select.multiple||select.size>1)return false;
 window.__canvasLinkSelect?.close();
 const box=document.createElement('div'),r=select.getBoundingClientRect(),style=getComputedStyle(select);
 box.setAttribute('role','listbox');box.setAttribute('aria-label',select.getAttribute('aria-label')||select.labels?.[0]?.textContent||'Выбор значения');
 box.dataset.canvaslinkSelect='';
 Object.assign(box.style,{position:'fixed',zIndex:'2147483646',boxSizing:'border-box',width:Math.min(innerWidth-16,Math.max(220,r.width))+'px',maxHeight:Math.min(320,innerHeight-16)+'px',overflowY:'auto',padding:'6px',border:'1px solid #626773',borderRadius:'10px',background:'#20232b',color:'#f3f4f6',boxShadow:'0 8px 32px #0008',font:style.font});
 const entries=[...select.options].map((option,index)=>({option,index,disabled:option.disabled||option.parentElement?.tagName==='OPTGROUP'&&option.parentElement.disabled}));
 let current=select.selectedIndex,closed=false;
 const close=(restore=true)=>{if(closed)return;closed=true;box.remove();document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',keys,true);window.removeEventListener('resize',dismiss);if(window.__canvasLinkSelect?.box===box)delete window.__canvasLinkSelect;if(restore&&select.isConnected)select.focus({preventScroll:true});};
 const dismiss=()=>close(false);
 const choose=index=>{if(entries[index]?.disabled)return;select.selectedIndex=index;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));close();};
 const paint=()=>{for(const button of box.children){const active=Number(button.dataset.index)===current;button.setAttribute('aria-selected',String(active));button.style.background=active?'#485660':'transparent';}box.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});};
 const outside=event=>{if(!box.contains(event.target))close(false);};
 const keys=event=>{
  if(!['ArrowDown','ArrowUp','Home','End','Enter','Escape','Tab'].includes(event.key))return;
  if(event.key==='Tab'){close();return;}
  event.preventDefault();event.stopImmediatePropagation();
  if(event.key==='Escape'){close();return;}if(event.key==='Enter'){choose(current);return;}
  const available=entries.filter(e=>!e.disabled).map(e=>e.index);if(!available.length)return;
  const at=available.indexOf(current);current=event.key==='Home'?available[0]:event.key==='End'?available.at(-1):available[Math.max(0,Math.min(available.length-1,at+(event.key==='ArrowDown'?1:-1)))];paint();
 };
 for(const entry of entries){const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.dataset.index=String(entry.index);button.textContent=entry.option.label;button.disabled=entry.disabled;Object.assign(button.style,{display:'block',width:'100%',minHeight:'40px',padding:'9px 12px',border:'0',borderRadius:'6px',textAlign:'left',color:entry.disabled?'#858a94':'inherit',font:'inherit',cursor:entry.disabled?'default':'pointer',whiteSpace:'normal'});button.addEventListener('click',()=>choose(entry.index));box.append(button);}
 document.body.append(box);const b=box.getBoundingClientRect();box.style.left=Math.max(8,Math.min(r.left,innerWidth-b.width-8))+'px';box.style.top=Math.max(8,r.bottom+b.height+8<=innerHeight?r.bottom+4:r.top-b.height-4)+'px';
 document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',keys,true);window.addEventListener('resize',dismiss);window.__canvasLinkSelect={box,close};select.focus({preventScroll:true});paint();return true;
}
module.exports={selectPointerScript:(x,y)=>'('+selectAtPoint.toString()+')('+JSON.stringify(x)+','+JSON.stringify(y)+')',closeSelectScript:'window.__canvasLinkSelect?.close(false)'};
