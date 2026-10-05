import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { flowOutputDir, OUTPUT_DIR } from "./paths";
import { demoDatabase } from "./stack";

describe("demoDatabase", () => {
  it("accepts the default demo database", () => {
    expect(demoDatabase("postgres://localhost:5432/yarvis_demo").name).toBe("yarvis_demo");
  });

  it("refuses the app's own databases", () => {
    for (const name of ["yarvis", "yarvis_dev", "yarvis_test"]) {
      expect(() => demoDatabase(`postgres://localhost:5432/${name}`)).toThrow();
    }
  });

  it("refuses a URL that names no database", () => {
    expect(() => demoDatabase("postgres://localhost:5432")).toThrow();
    expect(() => demoDatabase("postgres://localhost:5432/")).toThrow();
  });

  it("refuses a name that could close the quoted SQL identifier", () => {
    expect(() => demoDatabase('postgres://localhost/demo";DROP DATABASE yarvis;--')).toThrow();
    expect(() => demoDatabase("postgres://localhost/demo%22")).toThrow();
  });

  it("refuses a query parameter that sends the sidecar to another database", () => {
    for (const param of ["database", "dbname", "db"]) {
      expect(() => demoDatabase(`postgres://localhost/yarvis_demo?${param}=yarvis`)).toThrow();
    }
  });

  it("refuses a database that isn't on this machine", () => {
    expect(() => demoDatabase("postgres://db.example.com/yarvis_demo")).toThrow();
  });

  it("connects to the postgres database for admin work, keeping host, port and credentials", () => {
    const admin = new URL(demoDatabase("postgres://u:p@127.0.0.1:6543/yarvis_demo").adminUrl);
    expect(admin.pathname).toBe("/postgres");
    expect(admin.username).toBe("u");
    expect(admin.password).toBe("p");
    expect(admin.port).toBe("6543");
  });
});

describe("flowOutputDir", () => {
  it("names the directory after the flow's title", () => {
    expect(flowOutputDir("Task added")).toBe(join(OUTPUT_DIR, "task-added"));
  });

  it("refuses a title that would resolve to the output root", () => {
    expect(() => flowOutputDir("!!!")).toThrow();
  });
});
