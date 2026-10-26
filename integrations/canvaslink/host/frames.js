// NativeImage pixels are BGRA with premultiplied alpha; ImageData expects RGBA.
// The main process waits for frameConsumed before sending another full frame.
(function(root){
 function rgba(pixels,width,height){
  if(!ArrayBuffer.isView(pixels)||pixels.byteLength!==width*height*4||width<1||height<1||width>2560||height>1600)throw Error('invalid-bitmap-frame');
  const data=new Uint8ClampedArray(pixels);
  for(let i=0;i<data.length;i+=4){const b=data[i],a=data[i+3];data[i]=a&&a<255?Math.round(data[i+2]*255/a):data[i+2];data[i+1]=a&&a<255?Math.round(data[i+1]*255/a):data[i+1];data[i+2]=a&&a<255?Math.round(b*255/a):b;}
  return data;
 }
 if(typeof module==='object'&&module.exports)module.exports={rgba};else root.CanvasLinkFrames={rgba};
})(typeof window==='undefined'?globalThis:window);
