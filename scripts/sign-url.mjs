#!/usr/bin/env node
// Build a URL signed the way the Docebo iFrame widget signs it, to test the handshake locally.
// hash = SHA-256("user_id,username,auth_code,salt")
//
// Usage: node scripts/sign-url.mjs [baseUrl] [salt]
//   node scripts/sign-url.mjs http://localhost:8787 dev-salt
import { createHash, randomBytes } from 'node:crypto';

const base = process.argv[2] || 'http://localhost:8787';
const salt = process.argv[3] || 'dev-salt';
const userId = '12345';
const username = 'test.learner';
const authCode = randomBytes(16).toString('hex');
const hash = createHash('sha256').update([userId, username, authCode, salt].join(',')).digest('hex');
const u = new URL(base);
u.search = new URLSearchParams({ user_id: userId, username, auth_code: authCode, hash }).toString();
console.log(u.toString());
