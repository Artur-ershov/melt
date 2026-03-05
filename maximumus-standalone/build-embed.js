/**
 * Встраивает картинки в index.html как data URL.
 * Запуск: node build-embed.js
 * После этого index.html можно открывать по file:// — всё работает без сервера.
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = [
  'nature.jpg', 'n1.png', 'n2.png', 'n3.png',
  'nature2.jpg', 'nn1.png', 'nn2.png', 'nn3.png',
  'prompt1.png', 'prompt2.png', 'prompt3.png', 'prompt4.png',
  'c.jpg', 'c1.png', 'c2.png', 'c3.png'
];

const mime = (name) => name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';

const out = {};
for (const name of files) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  const b64 = buf.toString('base64');
  out[name] = 'data:' + mime(name) + ';base64,' + b64;
  console.log('Embedded:', name);
}

const indexPath = path.join(dir, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');

const embedStr = 'const EMBEDDED_ASSETS = ' + JSON.stringify(out) + ';';
html = html.replace(/const EMBEDDED_ASSETS = null;/, embedStr);

fs.writeFileSync(indexPath, html, 'utf8');
console.log('Done. index.html now contains embedded images. Open it by double-click (file://).');
