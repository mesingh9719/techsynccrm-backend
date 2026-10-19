import { describe, expect, it } from 'vitest'
import { addMinor, divideHalfEven, formatMoney, fromMinor, minorToJson, percentOf, toMinor } from '../../src/lib/money.js'

describe('money', () => {
  it('parses Indian-formatted amounts into paise', () => {
    expect(toMinor('₹1,85,000.50')).toBe(18500050n)
    expect(toMinor('Rs. 2,40,000')).toBe(24000000n)
    expect(toMinor(799)).toBe(79900n)
    expect(toMinor('0.5')).toBe(50n)
    expect(toMinor('-12.34')).toBe(-1234n)
  })

  it('rounds extra decimals half to even', () => {
    expect(toMinor('1.005')).toBe(100n) // 100.5 paise → even (100)
    expect(toMinor('1.015')).toBe(102n) // 101.5 paise → even (102)
    expect(toMinor('1.0151')).toBe(102n)
  })

  it('rejects garbage', () => {
    expect(() => toMinor('abc')).toThrow(RangeError)
    expect(() => toMinor('')).toThrow(RangeError)
  })

  it('formats and converts back', () => {
    expect(fromMinor(18500050n)).toBe('185000.50')
    expect(fromMinor(-5n)).toBe('-0.05')
    expect(formatMoney(18500050n)).toBe('₹1,85,000.50')
    expect(formatMoney(1200n, 'USD')).toBe('$12.00')
  })

  it('computes percentages with half-even rounding', () => {
    expect(percentOf(79900n, 1800)).toBe(14382n) // 18 % of ₹799
    expect(percentOf(250n, 1000)).toBe(25n)
    expect(percentOf(5n, 5000)).toBe(2n) // 2.5 → 2 (even)
    expect(percentOf(7n, 5000)).toBe(4n) // 3.5 → 4 (even)
    expect(divideHalfEven(-5n, 2n)).toBe(-2n)
  })

  it('adds and serialises safely', () => {
    expect(addMinor(1n, 2, '3')).toBe(6n)
    expect(minorToJson(18500050n)).toBe(18500050)
    expect(() => minorToJson(2n ** 60n)).toThrow(RangeError)
  })
})
