import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
const root = fileURLToPath(new URL('.', import.meta.url));
const outfile = root + 'lib/index.js';
// Remove stale artifacts before building; never leave a forbidden bundle deployable.
await rm(outfile, { force: true });
const result = await build({
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  entryPoints: ['src/index.ts'],
  outfile,
  write: false,
  external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*'],
  nodePaths: [root + 'node_modules'],
});
const output = result.outputFiles[0];
for (const forbidden of ['import.meta.env', 'firebase/firestore', 'firebase/app', 'react']) {
  if (output.text.includes(forbidden)) throw new Error(`Forbidden bundle content: ${forbidden}`);
}
await mkdir(root + 'lib', { recursive: true });
await writeFile(outfile, output.contents);
