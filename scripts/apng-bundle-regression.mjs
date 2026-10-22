import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('production APNG worker encodes without window, require or module globals', async () => {
  const directory = new URL('../web/dist/assets/', import.meta.url);
  const workers = (await readdir(directory)).filter(name => /^apng\.worker-.*\.js$/.test(name));
  assert.equal(workers.length, 1, 'Build the production fixture before this test');
  const source = await readFile(new URL(workers[0], directory), 'utf8');
  const replies = [];
  const scope = { postMessage: message => replies.push(message) };
  const context = vm.createContext({ self: scope, console });
  // Bun's own Worker provides CommonJS globals. A real browser Worker does
  // not, so unit-importing UPNG alone cannot detect bundler interop failures.
  vm.runInContext(source, context, { timeout: 5000 });
  assert.equal(typeof scope.onmessage, 'function');
  vm.runInContext(`self.onmessage({data:{
    frames:[new Uint8Array([12,34,56,255]).buffer,new Uint8Array([78,90,12,255]).buffer],
    width:1,height:1,delays:[42,41]
  }})`, context, { timeout: 5000 });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, true, replies[0].error);
  const bytes = Buffer.from(replies[0].png);
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  let offset = 8;
  const chunks = [];
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset);
    assert.ok(offset + size + 12 <= bytes.length, 'Complete PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    chunks.push(type);
    if (type === 'acTL') assert.equal(bytes.readUInt32BE(offset + 8), 2);
    offset += size + 12;
  }
  assert.equal(chunks.filter(type => type === 'fcTL').length, 2);
  assert.equal(chunks.at(-1), 'IEND');
  assert.equal(offset, bytes.length);
});
