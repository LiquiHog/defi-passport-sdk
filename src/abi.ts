/**
 * Method signatures, verbatim. These strings ARE the ABI: a selector is
 * `sha512_256("name(type,type)ret")[0..4]`, so a typo here is a silent
 * "unknown method" at submit time rather than a compile error.
 *
 * Argument NAMES are deliberately absent — they are not part of a selector.
 */
import { ABIMethod } from 'algosdk';

const m = (sig: string) => ABIMethod.fromSignature(sig);

export const PASSPORT = {
  // lifecycle
  create: m('create(uint64,uint64)void'),
  confirm_version: m('confirm_version(uint64)void'),
  destroy: m('destroy(byte[],byte[])void'),
  // wiring
  set_oracle: m('set_oracle(uint64)void'),
  set_directory: m('set_directory(uint64)void'),
  sync_contracts: m('sync_contracts()void'),
  // custody
  optin: m('optin(uint64)void'),
  optout: m('optout(uint64)void'),
  withdraw: m('withdraw(uint64,uint64)void'),
  lock: m('lock(uint64,uint64)void'),
  unlock: m('unlock(uint64,uint64)void'),
  set_position: m('set_position(uint64,uint64,uint64,uint64,uint64,uint64,byte[])void'),
  clear_position: m('clear_position(uint64)void'),
  // strategies and rules
  open_strategy: m('open_strategy(uint64,uint64,uint64,uint64)uint64'),
  close_strategy: m('close_strategy(uint64,byte[])void'),
  add_rule: m('add_rule(uint64,uint64,uint64,uint64,uint64,byte[])uint64'),
  update_rule: m('update_rule(uint64,uint64,byte[])void'),
  fund_rule: m('fund_rule(uint64,uint64,uint64,uint64,uint64)void'),
  remove_rule: m('remove_rule(uint64,uint64)void'),
  add_reserve: m('add_reserve(uint64,uint64)void'),
  remove_reserve: m('remove_reserve(uint64,uint64)void'),
  set_refund_budget: m('set_refund_budget(uint64,uint64)void'),
  // owner-driven swap, and the keeper's entry point
  swap: m('swap(uint64,uint64,uint64,uint64,byte[])uint64'),
  ping: m('ping()void'),
} as const;

export const REGISTRY = {
  create_entry: m('create_entry()void'),
  link_passport: m('link_passport(uint64,uint64)void'),
  remove_entry: m('remove_entry(uint64)void'),
  verify_update: m('verify_update(uint64)void'),
} as const;
