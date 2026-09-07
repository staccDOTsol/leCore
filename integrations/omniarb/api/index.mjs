// Vercel entry point.
//
// The desk is one plain Node request handler, so a serverless host needs no
// second implementation of it — just this. Note what does NOT come along: the
// write endpoints stay off here because STACCOVERFLOW_KP is not set in this
// environment, and it must not be. A public URL that can sign is a public URL
// that can be drained; launching, bridging and trading are for the local
// process that holds the key.
export { default } from '../site/server.mjs';
