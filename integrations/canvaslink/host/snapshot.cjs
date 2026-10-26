// Transfer bounded BGRA pixels inside Electron. Only WebRTC performs lossy
// encoding; do not spend CPU encoding/decoding JPEG or PNG on the same Mac.
function createSnapshot(image,nativeImage,{maxWidth=2560,maxHeight=1600}={}){
 if(image.isEmpty())return null;
 const scaleFactor=Math.max(1,...image.getScaleFactors().filter(s=>Number.isFinite(s)&&s>0));
 let pixels=image.toBitmap({scaleFactor}),size=image.getSize(scaleFactor);
 if(pixels.length!==size.width*size.height*4){
  size={width:Math.round(size.width*scaleFactor),height:Math.round(size.height*scaleFactor)};
  if(pixels.length!==size.width*size.height*4)throw Error('invalid-snapshot-size');
 }
 const factor=Math.min(1,maxWidth/size.width,maxHeight/size.height);
 if(factor<1){
  const normalized=nativeImage.createFromBitmap(pixels,{...size,scaleFactor:1});
  size={width:Math.max(1,Math.floor(size.width*factor)),height:Math.max(1,Math.floor(size.height*factor))};
  pixels=normalized.resize({...size,quality:'best'}).toBitmap({scaleFactor:1});
  if(pixels.length!==size.width*size.height*4)throw Error('invalid-resized-snapshot');
 }
 return {pixels,...size,scaleFactor,format:'bgra'};
}
module.exports={createSnapshot};
