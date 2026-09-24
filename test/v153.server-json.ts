/* V153 — MCP registry manifest (E3) stays in step with package.json. */
import fs from 'node:fs';

const check = (l: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) process.exitCode = 1; };
const read = (f: string) => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const pkg = read('package.json'), srv = read('server.json');
check('name matches package.json mcpName', srv.name === pkg.mcpName && /^io\.github\.[^/]+\/[^/]+$/.test(srv.name));
check('version matches package.json', srv.version === pkg.version && srv.packages[0].version === pkg.version);
check('points at the published npm package', srv.packages[0].registryType === 'npm' && srv.packages[0].identifier === pkg.name);
check('runs over stdio with the mcp subcommand', srv.packages[0].transport.type === 'stdio' && srv.packages[0].packageArguments[0].value === 'mcp');
check('description within the registry limit (100 chars)', srv.description.length > 0 && srv.description.length <= 100);
check('server.json ships in the package', pkg.files.includes('server.json'));
