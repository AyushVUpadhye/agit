import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/format/canonical.js";

describe("canonicalJson (SPEC §3)", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("orders keys by UTF-16 code unit", () => {
    // "Z" (0x5A) < "a" (0x61); "é" (0xE9) after both.
    expect(canonicalJson({ a: 1, Z: 2, "é": 3 })).toBe('{"Z":2,"a":1,"é":3}');
  });

  it("leaves array order alone", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3, "x"])).toBe('[{"a":2,"b":1},3,"x"]');
  });

  it("is stable across insertion order", () => {
    const x = JSON.parse('{"p":1,"q":{"y":2,"x":3}}');
    const y = JSON.parse('{"q":{"x":3,"y":2},"p":1}');
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it("rejects NaN and infinities", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });

  it("serializes escapes and null like JSON.stringify", () => {
    expect(canonicalJson({ s: 'a"b\n', n: null })).toBe('{"n":null,"s":"a\\"b\\n"}');
  });
});
