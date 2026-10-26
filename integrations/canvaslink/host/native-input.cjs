const KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'c', 'a', 'v', 'z', 'd', 'l']);
function validateInput(e) {
  if (!e || !['pointer', 'scroll', 'key', 'text'].includes(e.type)) throw Error('invalid-input');
  if (['pointer', 'scroll'].includes(e.type) && (![e.x, e.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1))) throw Error('invalid-coordinates');
  if (e.type === 'pointer' && !['down', 'up', 'move'].includes(e.action)) throw Error('invalid-pointer');
  if (e.type === 'pointer' && ![0, 2].includes(e.button)) throw Error('invalid-button');
  if (e.type === 'scroll' && (![e.dx, e.dy].every(n => Number.isFinite(n) && Math.abs(n) <= 2000))) throw Error('invalid-scroll');
  if (e.type === 'text' && (typeof e.text !== 'string' || !e.text.length || e.text.length > 8000)) throw Error('invalid-text');
  if (e.type === 'key' && (!Array.isArray(e.modifiers) || !(KEYS.has(e.key)||(/^[a-z]$/.test(e.key)&&e.modifiers.some(m=>m==='control'||m==='meta'))) || e.modifiers.length > 4 || e.modifiers.some(m => !['control', 'shift', 'alt', 'meta'].includes(m)))) throw Error('invalid-key');
}
module.exports = { validateInput };
