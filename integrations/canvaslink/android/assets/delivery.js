/* Transport contract v2. No DOM dependencies; shared by the client and tests. */
(function(root,factory){if(typeof module==='object')module.exports=factory();else root.CanvasLinkDelivery=factory();})(globalThis,()=>{
  class Delivery {
    constructor({channel,onChange=()=>{},timeout=65000,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=token=>clearTimeout(token),id=()=>crypto.randomUUID()}){Object.assign(this,{channel,onChange,timeout,setTimer,clearTimer,id});this.pending=new Map();this.sent=0;this.acked=0;this.seq=0;}
    send(input){
      const dc=this.channel();
      if(!dc||dc.readyState!=='open')return Promise.reject(Error('not-connected'));
      if(dc.bufferedAmount>65536||this.pending.size>=64)return Promise.reject(Error('input-busy'));
      const id=this.id();
      return new Promise((resolve,reject)=>{
        const entry={resolve,reject,input,timer:this.setTimer(()=>this.finish(id,false,'delivery-uncertain'),this.timeout)};
        this.pending.set(id,entry);
        try{dc.send(JSON.stringify({...input,id,seq:++this.seq}));this.sent++;this.onChange({id,status:'pending',kind:input.type,pending:this.pending.size});}
        catch{this.finish(id,false,'not-sent');}
      });
    }
    finish(id,ok,error,focus){const entry=this.pending.get(id);if(!entry)return false;this.pending.delete(id);this.clearTimer(entry.timer);if(ok)this.acked++;
      this.onChange({id,status:ok?'processed':error==='delivery-uncertain'?'uncertain':'failed',kind:entry.input.type,error:error||'',pending:this.pending.size});
      if(ok)entry.resolve({id,status:'processed',...(focus?{focus}:{})});else entry.reject(Error(error||'input-rejected'));return true;
    }
    receive(value){if(!['input-ok','input-error'].includes(value?.type))return false;return this.finish(value.id,value.type==='input-ok',value.error,value.focus);}
    close(){for(const id of [...this.pending.keys()])this.finish(id,false,'delivery-uncertain');}
  }
  return {Delivery};
});
