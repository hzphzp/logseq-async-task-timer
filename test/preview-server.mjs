import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const paths = new Set(['/test/preview.html', '/src/ui.js', '/src/db-store.js', '/src/reminder.js', '/src/titles.js', '/src/style.css']);
createServer(async (request, response) => {
  const path = request.url === '/' ? '/test/preview.html' : request.url;
  if (!paths.has(path)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
  response.end(await readFile(new URL('..' + path, import.meta.url)));
}).listen(5178, '127.0.0.1', () => console.log('UI fixture: http://127.0.0.1:5178/'));
