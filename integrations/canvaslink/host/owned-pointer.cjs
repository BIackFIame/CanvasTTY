// Only the owned renderer receives events; cancellation never activates a window.
class OwnedPointer {
  constructor(){this.held=new Map();}
  send(contents,event){
    contents.sendInputEvent(event);
    if(event.type==='mouseDown')this.held.set(event.button,{contents,event});
    else if(event.type==='mouseUp')this.held.delete(event.button);
    else if(event.type==='mouseMove')for(const state of this.held.values()){
      if(state.contents===contents)state.event={...state.event,x:event.x,y:event.y};
    }
  }
  release(){
    const held=[...this.held.values()];this.held.clear();
    for(const {contents,event} of held){
      try{if(!contents.isDestroyed())contents.sendInputEvent({...event,type:'mouseUp',modifiers:[],clickCount:1});}catch{}
    }
  }
}
module.exports={OwnedPointer};
