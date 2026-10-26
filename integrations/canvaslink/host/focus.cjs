// Geometry only; no field values or surrounding text cross the input channel.
function readFocus(){
 const e=document.activeElement,panel=document.querySelector('.settings-panel--open');
 const editable=!!e&&!e.disabled&&!e.readOnly&&(e.tagName==='TEXTAREA'||e.tagName==='INPUT'&&['text','search','email','url','tel','password','number'].includes(e.type)||e.isContentEditable);
 const kind=e?.classList.contains('xterm-helper-textarea')?'terminal':editable?'text-field':e?.matches('input,select,button,[role=button],[role=slider]')?'control':'canvas';
 const node=kind==='terminal'?e.closest('.xterm')?.querySelector('.xterm-screen'):editable?e:null;
 const r=node?.getBoundingClientRect(),c=kind==='terminal'?e.getBoundingClientRect():null;
 const normalized=b=>b&&b.width>0&&b.height>0?{x:b.x/innerWidth,y:b.y/innerHeight,width:b.width/innerWidth,height:b.height/innerHeight}:null;
 const clipped=e=>{const r=e.getBoundingClientRect();let x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(/hidden|auto|scroll|clip/.test(s.overflow+s.overflowX+s.overflowY)){const b=p.getBoundingClientRect();x=Math.max(x,b.left);y=Math.max(y,b.top);right=Math.min(right,b.right);bottom=Math.min(bottom,b.bottom);}}return normalized({x,y,width:right-x,height:bottom-y});};
 const dragRects=panel?[...panel.querySelectorAll('input[type=range]')].filter(e=>!e.disabled).map(clipped).filter(Boolean):[];
 const screens=panel?[]:[...document.querySelectorAll('.xterm-screen')].filter(node=>clipped(node));
 const selected=screens.filter(node=>node.closest('.terminal-card--selected'));
 const candidate=selected.length===1?selected[0]:screens.length===1?screens[0]:null;
 const terminalView=candidate?{rect:clipped(candidate),viewport:{width:innerWidth,height:innerHeight}}:null;
 const context=kind==='text-field'?e.closest('.api-profile-row,.provider-secret,.setting-group'):null;
 return {editable,kind,terminalView,surface:panel?'settings':'canvas',viewport:{width:innerWidth,height:innerHeight},dragRects,rect:normalized(r),contextRect:context?clipped(context):null,fontSize:editable?parseFloat(getComputedStyle(e).fontSize)||14:null,caret:r&&c&&c.x>=r.x-2&&c.y>=r.y-2&&c.right<=r.right+2&&c.bottom<=r.bottom+2?normalized(c):null};
}
module.exports={focusScript:'('+readFocus.toString()+')()'};
