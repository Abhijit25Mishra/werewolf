#!/usr/bin/env node
'use strict';
// Copies the role catalog (what GET /api/roles serves) into public/mock/roles.json,
// so mock mode and the client's offline fallback use exactly the server's data.
// Run after editing src/roles.js:  node scripts/sync-mock-roles.js
const fs = require('fs');
const path = require('path');
const { roleInfoList } = require('../src/roles');

const out = path.join(__dirname, '..', 'public', 'mock', 'roles.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ roles: roleInfoList() }, null, 2) + '\n');
console.log(`Wrote ${path.relative(process.cwd(), out)} (${roleInfoList().length} roles)`);
