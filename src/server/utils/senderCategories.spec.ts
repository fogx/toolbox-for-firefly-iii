import { describe, expect, it } from 'vitest';
import { parseSenderCategories } from './senderCategories.js';

describe('parseSenderCategories', () => {
  it('returns no pairs when unset', () => {
    expect(parseSenderCategories(undefined)).toEqual([]);
    expect(parseSenderCategories('')).toEqual([]);
  });

  it('parses ; and newline separated pairs, lower-casing needles only', () => {
    expect(
      parseSenderCategories('REWE=Groceries; Deutsche Bahn = transport\nflixbus=transport')
    ).toEqual([
      ['rewe', 'Groceries'],
      ['deutsche bahn', 'transport'],
      ['flixbus', 'transport'],
    ]);
  });

  it('keeps everything after the first = as the category', () => {
    expect(parseSenderCategories('a=b=c')).toEqual([['a', 'b=c']]);
  });

  it('skips malformed entries', () => {
    expect(parseSenderCategories('noequals; =cat; needle=; ;ok=yes')).toEqual([['ok', 'yes']]);
  });
});
