/* esbuild `inject` target for the lite bundle. The portable engine modules and
 * BYOK adapters use Node's Buffer (e.g. screenshot Buffers, png.toString('base64')),
 * but a service worker has no global Buffer. Exporting Buffer here makes esbuild
 * rewire every bare `Buffer` reference in the bundle to the feross/buffer polyfill
 * — no source change to BrowserPort/report/adapter types. */
export { Buffer } from 'buffer';
