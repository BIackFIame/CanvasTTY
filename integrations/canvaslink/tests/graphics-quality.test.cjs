const {test}=require('node:test'),assert=require('node:assert/strict');
const {createSnapshot}=require('../host/snapshot.cjs'),{rgba}=require('../host/frames.js');
test('High density is configured at startup without changing CSS zoom or accepting unbounded factors',()=>{
 const {configureRenderScale}=require('../host/display-scale.cjs');let actual,exited=false;
 const app={isReady:()=>false,relaunch:options=>actual=options,exit:code=>{assert.equal(code,0);exited=true;}};
 configureRenderScale(app,['preview','--private-profile']);assert.deepEqual(actual,{args:['--private-profile','--force-device-scale-factor=2']});assert(exited);
 for(const scale of [1,2])configureRenderScale({...app,relaunch(){throw Error('Relaunch loop');}},['preview','--force-device-scale-factor='+scale]);
 assert.throws(()=>configureRenderScale({...app,isReady:()=>true}),/requires-startup/);
 for(const scale of [0,1.5,3,Infinity])assert.throws(()=>configureRenderScale(app,['preview','--force-device-scale-factor='+scale]),/invalid-render-scale/);
});
test('Raw snapshots preserve Retina pixels without JPEG or PNG encoding',()=>{
 const image={isEmpty:()=>false,getScaleFactors:()=>[1,2],getSize:()=>({width:8,height:5}),toBitmap:options=>{assert.equal(options.scaleFactor,2);return Buffer.alloc(16*10*4);},toJPEG(){throw Error('Lossy intermediate');},toPNG(){throw Error('Unnecessary compression');}};
 const value=createSnapshot(image,{createFromBitmap(){throw Error('Unnecessary resize');}});
 assert.equal(value.width,16);assert.equal(value.height,10);assert.equal(value.format,'bgra');
});
test('Capture bounds apply to physical pixels, including high DPI',()=>{
 const image={isEmpty:()=>false,getScaleFactors:()=>[2],getSize:()=>({width:8,height:5}),toBitmap:()=>Buffer.alloc(16*10*4)};
 const value=createSnapshot(image,{createFromBitmap(pixels,options){assert.equal(options.scaleFactor,1);assert.equal(options.width,16);assert.equal(options.height,10);return {resize(size){assert.equal(size.width,8);assert.equal(size.height,5);return {toBitmap:()=>Buffer.alloc(8*5*4)};}};}},{maxWidth:8,maxHeight:5});
 assert.equal(value.width,8);assert.equal(value.height,5);
});
test('Raw conversion preserves red/blue order and restores premultiplied alpha',()=>{
 const original=Uint8Array.from([0,0,255,255,255,0,0,255,10,20,40,128]);
 assert.deepEqual([...rgba(original,3,1)],[255,0,0,255,0,0,255,255,80,40,20,128]);assert.equal(original[0],0);
});
test('Malformed and unbounded pixel frames are rejected before canvas allocation',()=>{
 assert.throws(()=>rgba(new Uint8Array(4),2560,1600),/invalid-bitmap/);
 assert.throws(()=>rgba(new Uint8Array(0),0,0),/invalid-bitmap/);
 assert.throws(()=>rgba(new Uint8Array(2561*4),2561,1),/invalid-bitmap/);
});
