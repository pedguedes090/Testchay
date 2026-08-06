import test from 'node:test';import assert from 'node:assert/strict';import {validName,rolesForCount,canPerform,newRoomCode} from '../server.js';
test('validates player names',()=>{assert.equal(validName('Cá Mập'),true);assert.equal(validName('x'),false);assert.equal(validName('<script>'),false)});
test('assigns unique roles for 4–6 players',()=>{for(const n of [4,5,6])assert.equal(new Set(rolesForCount(n)).size,n)});
test('guards actions by role',()=>{assert.equal(canPerform('jump','jump'),true);assert.equal(canPerform('jump','throw'),false);assert.equal(canPerform('actionThrow','throw'),true)});
test('creates five-character room codes',()=>assert.match(newRoomCode(()=>.1),/^[A-Z2-9]{5}$/));
