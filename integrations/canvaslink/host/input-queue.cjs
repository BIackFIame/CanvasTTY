const {validateInput}=require('./native-input.cjs');
// One peer owns one ordered queue. Keep IDs for the whole peer lifetime: an old
// text/Enter request can never execute twice, even after its ACK was lost.
class InputQueue {
  constructor({apply,active,reply,limit=64,maxIds=256}){Object.assign(this,{apply,active,reply,limit,maxIds});this.tail=Promise.resolve();this.ids=new Map();this.pending=0;this.highWater=0;}
  receive(value){
    const id=value?.id;
    if(typeof id!=='string'||!/^[A-Za-z0-9-]{1,80}$/.test(id))return;
    const previous=this.ids.get(id);if(previous){if(previous.result)this.reply(previous.result);return;}
    const respond=result=>{this.reply(result);};
    if(!Number.isSafeInteger(value.seq)||value.seq<=this.highWater){respond({type:'input-error',id,error:'input-expired'});return;}
    if(!this.active()||this.pending>=this.limit){respond({type:'input-error',id,error:'input-busy'});return;}
    try{validateInput(value);}catch(error){respond({type:'input-error',id,error:error.message});return;}
    this.highWater=value.seq;const entry={};this.ids.set(id,entry);this.pending++;
    for(const [oldId,old] of this.ids){if(this.ids.size<=this.maxIds)break;if(old.result)this.ids.delete(oldId);}
    this.tail=this.tail.catch(()=>{}).then(async()=>{
      try{if(!this.active())throw Error('session-ended');const result=await this.apply(value);entry.result={type:'input-ok',id,...(result?.focus?{focus:result.focus}:{})};}
      catch(error){entry.result={type:'input-error',id,error:error.message||'input-rejected'};}
      finally{this.pending--;if(this.active())respond(entry.result);}
    });
  }
}
module.exports={InputQueue};
