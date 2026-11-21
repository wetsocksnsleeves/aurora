import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { closeDb } from "../db";

/**
 * Point LIGHTSHOW_DATA_DIR at a fresh temp folder for the current test file and
 * remove it afterwards. Returns a getter for the folder path.
 */
export function withTempDataDir(): () => string {
  let dir = "";
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.LIGHTSHOW_DATA_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightshow-test-"));
    process.env.LIGHTSHOW_DATA_DIR = dir;
  });
  afterAll(() => {
    closeDb();
    if (previous === undefined) delete process.env.LIGHTSHOW_DATA_DIR;
    else process.env.LIGHTSHOW_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}
