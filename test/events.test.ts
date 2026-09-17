/**
 * Event decoding, every tag through v1.1.2.
 *
 * events.ts had no tests before this. Now that layouts can carry addresses and a
 * tag can have two lengths, the table is the kind of thing that fails silently:
 * a wrong field order parses cleanly and returns plausible numbers. So every
 * layout here is exercised by BUILDING the bytes the contract emits — from the
 * emit sites in the source, not from the brief — and decoding them back.
 *
 * Two of those layouts differ from the brief that described them, and both are
 * pinned as such: \`skim\` is six u64s, and \`lopen\`'s address is in the middle.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import {
  EVENT_LAYOUT,
  FILL_RULE_TYPE,
  decodeEvent,
  eventsIn,
  isCrankFill,
  unwrapRelay,
} from '../dist/events.js';
import { RuleType } from '../dist/constants.js';

const ASCII = new TextEncoder();
const u64 = (n: bigint | number): number[] => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return [...b];
};
const ADDR = algosdk.encodeAddress(new Uint8Array(32).fill(0xab));
const addrBytes = (): number[] => [...algosdk.decodeAddress(ADDR).publicKey];
const emit = (tag: string, ...parts: number[][]): Uint8Array =>
  Uint8Array.from([...ASCII.encode(tag), ...parts.flat()]);

test('every layout round-trips: build the contract\'s bytes, decode them back', () => {
  let checked = 0;
  for (const [tag, spec] of Object.entries(EVENT_LAYOUT)) {
    const layouts = Array.isArray(spec[0]) ? (spec as readonly (readonly unknown[])[]) : [spec];
    for (const layout of layouts) {
      const parts: number[][] = [];
      const wantFields: Record<string, bigint> = {};
      const wantAddrs: Record<string, string> = {};
      (layout as readonly (string | { addr: string })[]).forEach((f, i) => {
        if (typeof f === 'string') {
          parts.push(u64(1000 + i));
          wantFields[f] = BigInt(1000 + i);
        } else {
          parts.push(addrBytes());
          wantAddrs[f.addr] = ADDR;
        }
      });
      const ev = decodeEvent(emit(tag, ...parts));
      assert.ok(ev, `${tag} must decode`);
      assert.equal(ev.tag, tag);
      assert.deepEqual(ev.fields, wantFields, `${tag} fields`);
      if (Object.keys(wantAddrs).length) assert.deepEqual(ev.addresses, wantAddrs, `${tag} addresses`);
      else assert.equal(ev.addresses, undefined, `${tag} has no address field`);
      checked++;
    }
  }
  assert.equal(checked, 27, 'twenty-six tags, one of them with two layouts');
});

// ── the nine v1.1.2 tags, byte for byte from the emit sites ──────────────────

test('pfill: sid, ruleId, spend, refund, then the recipient address', () => {
  const ev = decodeEvent(emit('pfill', u64(7), u64(2), u64(5_000_000), u64(1_000), addrBytes()))!;
  assert.deepEqual(ev.fields, { sid: 7n, ruleId: 2n, spend: 5_000_000n, refund: 1_000n });
  assert.deepEqual(ev.addresses, { recipient: ADDR });
  assert.equal(ev.ruleType, RuleType.Pay);
});

test('lfill: sid, ruleId, op, used, refund', () => {
  const ev = decodeEvent(emit('lfill', u64(7), u64(2), u64(3), u64(400), u64(1_000)))!;
  assert.deepEqual(ev.fields, { sid: 7n, ruleId: 2n, op: 3n, used: 400n, refund: 1_000n });
  assert.equal(ev.ruleType, RuleType.Folks);
});

test('ovfy: sid, ruleId, refund — relayed like a fill, but not one', () => {
  const ev = decodeEvent(emit('ovfy', u64(7), u64(2), u64(1_000)))!;
  assert.deepEqual(ev.fields, { sid: 7n, ruleId: 2n, refund: 1_000n });
  assert.equal(ev.ruleType, undefined);
  assert.equal(isCrankFill('ovfy'), false);
});

test('sprofit: two lengths — cleared is (sid, 0); set is the whole routing', () => {
  const cleared = decodeEvent(emit('sprofit', u64(7), u64(0)))!;
  assert.deepEqual(cleared.fields, { sid: 7n, destKind: 0n });
  const set = decodeEvent(emit('sprofit', u64(7), u64(2), u64(0), u64(250), u64(9)))!;
  assert.deepEqual(set.fields, { sid: 7n, destKind: 2n, mode: 0n, value: 250n, destSid: 9n });
  // Neither three nor four u64s is a layout the contract emits.
  assert.equal(decodeEvent(emit('sprofit', u64(7), u64(2), u64(0))), null);
  assert.equal(decodeEvent(emit('sprofit', u64(7), u64(2), u64(0), u64(250))), null);
});

test('skim is SIX u64s, not the three the brief described', () => {
  const ev = decodeEvent(emit('skim', u64(7), u64(2), u64(31566704), u64(125), u64(1), u64(1)))!;
  assert.deepEqual(ev.fields, { sid: 7n, ruleId: 2n, asset: 31566704n, amount: 125n, dest: 1n, sent: 1n });
  assert.equal(decodeEvent(emit('skim', u64(7), u64(2), u64(125))), null, 'three u64s is not a skim');
});

test('lopen puts the escrow BETWEEN the two u64s, not after them', () => {
  // Same 48-byte length as the brief's order, so only the field values tell.
  const ev = decodeEvent(emit('lopen', u64(7), addrBytes(), u64(971388781)))!;
  assert.deepEqual(ev.fields, { sid: 7n, loanApp: 971388781n });
  assert.deepEqual(ev.addresses, { escrow: ADDR });
  // The brief's order, decoded with this layout, would mangle both integers —
  // which is what makes an address-in-the-middle layout worth asserting.
  const briefOrder = decodeEvent(emit('lopen', u64(7), u64(971388781), addrBytes()))!;
  assert.notEqual(briefOrder.fields.loanApp, 971388781n);
});

test('gasa, srestore, lclose: one u64 each', () => {
  assert.deepEqual(decodeEvent(emit('gasa', u64(31566704)))!.fields, { asset: 31566704n });
  assert.deepEqual(decodeEvent(emit('gasa', u64(0)))!.fields, { asset: 0n }, 'cleared election');
  assert.deepEqual(decodeEvent(emit('srestore', u64(7)))!.fields, { sid: 7n });
  assert.deepEqual(decodeEvent(emit('lclose', u64(7)))!.fields, { sid: 7n });
});

// ── the decoder's rules ──────────────────────────────────────────────────────

test('a recognised tag with a wrong length is a skip, not a guess', () => {
  assert.equal(decodeEvent(emit('sfill', u64(1), u64(2))), null);
  assert.equal(decodeEvent(emit('pfill', u64(7), u64(2), u64(5), u64(1))), null, 'address missing');
});

test('an unknown tag is null — logs also carry ABI return values', () => {
  assert.equal(decodeEvent(emit('zzzz', u64(1))), null);
  assert.equal(decodeEvent(new Uint8Array([0x15, 0x1f, 0x7c, 0x75, 1, 2, 3])), null, 'an ARC-4 return prefix');
});

test('longer tags win: lclose, lopen and lfill are not misread as lock', () => {
  assert.equal(decodeEvent(emit('lclose', u64(7)))!.tag, 'lclose');
  assert.equal(decodeEvent(emit('lopen', u64(7), addrBytes(), u64(1)))!.tag, 'lopen');
  assert.equal(decodeEvent(emit('lfill', u64(1), u64(2), u64(3), u64(4), u64(5)))!.tag, 'lfill');
  assert.equal(decodeEvent(emit('lock', u64(7), u64(100)))!.tag, 'lock');
  assert.equal(decodeEvent(emit('srestore', u64(7)))!.tag, 'srestore');
  assert.equal(decodeEvent(emit('srem', u64(7), u64(1)))!.tag, 'srem');
  assert.equal(decodeEvent(emit('sprofit', u64(7), u64(0)))!.tag, 'sprofit');
  assert.equal(decodeEvent(emit('sput', u64(7), u64(1)))!.tag, 'sput');
});

test('the six crank fills carry a rule type; nothing else does', () => {
  assert.deepEqual(Object.keys(FILL_RULE_TYPE).sort(), ['bfill', 'gfill', 'lfill', 'ofill', 'pfill', 'sfill']);
  for (const tag of ['xfill', 'ovfy', 'skim', 'sprofit', 'sput']) assert.equal(isCrankFill(tag), false, tag);
  assert.equal(FILL_RULE_TYPE['pfill'], RuleType.Pay);
  assert.equal(FILL_RULE_TYPE['lfill'], RuleType.Folks);
});

test('RuleType now names what the contract has always numbered', () => {
  assert.equal(RuleType.Folks, 5);
  assert.equal(RuleType.Pay, 6);
});

// ── relays and transactions ──────────────────────────────────────────────────

test('a relay envelope unwraps to the passport and the payload', () => {
  const payload = emit('pfill', u64(7), u64(2), u64(5), u64(1), addrBytes());
  const envelope = Uint8Array.from([...ASCII.encode('ev'), ...u64(3674166181), ...payload]);
  const r = unwrapRelay(envelope)!;
  assert.equal(r.passport, 3674166181n);
  assert.deepEqual(decodeEvent(r.payload)!.addresses, { recipient: ADDR });
  assert.equal(unwrapRelay(payload), null, 'a bare event is not an envelope');
});

test('eventsIn walks inner transactions and tags relayed events with their passport', () => {
  const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
  const fill = emit('lfill', u64(7), u64(2), u64(0), u64(400), u64(1_000));
  const relay = Uint8Array.from([...ASCII.encode('ev'), ...u64(3673918932), ...fill]);
  const txn = {
    logs: [b64(fill), b64(emit('zzzz', u64(1)))],
    innerTxns: [{ logs: [b64(relay)] }, { logs: [b64(emit('skim', u64(7), u64(2), u64(0), u64(5), u64(3), u64(1)))] }],
  };
  const evs = eventsIn(txn);
  assert.deepEqual(evs.map((e) => e.tag), ['lfill', 'lfill', 'skim']);
  assert.equal(evs[0]!.passport, undefined, 'the outer log is the crank itself');
  assert.equal(evs[1]!.passport, 3673918932n, 'the relayed copy knows whose it was');
  assert.equal(evs[2]!.fields.dest, 3n);
});
