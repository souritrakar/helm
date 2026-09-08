import { createServer } from 'node:net';
import { unlinkSync } from 'node:fs';
const path = process.argv[2];
try { unlinkSync(path); } catch {}
const server = createServer((socket) => socket.on('data', () => socket.write('{"result":{"type":"subscription_started"}}\n')));
server.listen(path, () => console.log(`fake-herdr listening ${path}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
