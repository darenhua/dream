import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { wipeAllTables } from "../src/db";
import { localDate, todayLocal } from "../src/lib/time";
import { setConfig } from "../src/services/config";

beforeEach(() => wipeAllTables());
afterEach(() => wipeAllTables()); // never leak a TIMEZONE row into other files

describe("todayLocal is user-timezone-correct", () => {
  test("follows the configured TIMEZONE, not the server locale", () => {
    // UTC+14 vs UTC-11: for most of any given day these disagree on the date,
    // and each must match localDate for its own zone regardless.
    setConfig("TIMEZONE", "Pacific/Kiritimati");
    expect(todayLocal()).toBe(localDate("Pacific/Kiritimati"));
    setConfig("TIMEZONE", "Pacific/Pago_Pago");
    expect(todayLocal()).toBe(localDate("Pacific/Pago_Pago"));
  });

  test("default TIMEZONE is America/Los_Angeles", () => {
    expect(todayLocal()).toBe(localDate("America/Los_Angeles"));
  });
});
