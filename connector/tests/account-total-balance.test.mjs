import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAccountBalance } from '../dist/session-balance-source.js';
const wallet=(balance,currency='CNY')=>({balance,currency});
const ready=(normal,bonus)=>({status:'ready',value:normal,bonusWallets:bonus});
const available=(totalBalance,currency='CNY')=>({status:'available',currency,totalBalance});
test('same-currency available balance includes recharge and valid bonus wallets',()=>{
 assert.deepEqual(projectAccountBalance(ready([wallet('40.75')],[wallet('9.02')])),available('49.77'));
});
test('bonus-only account is not shown as zero or unavailable',()=>{
 assert.deepEqual(projectAccountBalance(ready([],[wallet('9.02')])),available('9.02'));
});
test('zero recharge with a usable bonus shows the usable total',()=>{
 assert.deepEqual(projectAccountBalance(ready([wallet('0')],[wallet('2')])),available('2'));
});
test('CNY and USD totals stay separate and keep the existing CNY preference',()=>{
 assert.deepEqual(projectAccountBalance(ready([wallet('1'),wallet('100','USD')],[wallet('2'),wallet('500','USD')])),available('3'));
 assert.deepEqual(projectAccountBalance(ready([wallet('1','USD')],[wallet('2','USD')])),available('3','USD'));
});
test('recharge-only and real zero balances remain available',()=>{
 assert.deepEqual(projectAccountBalance(ready([wallet('0')],[])),available('0'));
 assert.deepEqual(projectAccountBalance(ready([wallet('40.75')],[])),available('40.75'));
});
test('decimal addition does not round through binary floating point',()=>{
 assert.deepEqual(projectAccountBalance(ready([wallet('0.1')],[wallet('0.2')])),available('0.3'));
 assert.deepEqual(projectAccountBalance(ready([wallet('9007199254740993.12345678')],[wallet('.00000001')])),available('9007199254740993.12345679'));
});
test('rc.5 official account values are summed before adapting to phone precision',()=>{
 const display=(normal,bonus=[])=>projectAccountBalance(ready(normal,bonus),true);
 assert.deepEqual(display([wallet('37.586123456')]),available('37.58'));
 assert.deepEqual(display([wallet('0.0099999999')],[wallet('1e-10')]),available('0.01'));
 assert.deepEqual(display([wallet('-1.2345678901')],[wallet('1.2345678901')]),available('0.00'));
 assert.deepEqual(display([wallet('-0.00000000001')]),available('-0.01'));
 assert.deepEqual(display([wallet('-1.23500000001')]),available('-1.24'));
 assert.deepEqual(display([wallet('0.004')]),available('0.00'));
 assert.deepEqual(display([wallet('9999999999999999.999999999')],[wallet('1e-9')]),{status:'query_failed'});
 assert.deepEqual(projectAccountBalance(ready([wallet('37.586123456')],[])),{status:'query_failed'});
});
test('signed and scientific decimal balances are combined exactly',()=>{
 assert.deepEqual(projectAccountBalance(ready([wallet('-1.20')],[wallet('2e-1')])),available('-1'));
 assert.deepEqual(projectAccountBalance(ready([wallet('-1')],[wallet('1')])),available('0'));
});
test('missing or malformed bonus balance never silently understates total money',()=>{
 for(const value of [undefined,null,'bad',[wallet('NaN')],[wallet('1','XXX')],[wallet('1'),wallet('2')]])
  assert.deepEqual(projectAccountBalance(ready([wallet('40.75')],value)),{status:'query_failed'});
});
test('duplicate normal wallets, empty response and addition overflow are rejected',()=>{
 for(const value of [ready([],[]),ready([wallet('1'),wallet('2')],[]),ready([wallet('9999999999999999')],[wallet('1')])])
  assert.deepEqual(projectAccountBalance(value),{status:'query_failed'});
});
test('private account fields are not forwarded with wallet totals',()=>{
 assert.deepEqual(projectAccountBalance({...ready([wallet('1')],[wallet('2')]),private:'hidden'}),available('3'));
});
