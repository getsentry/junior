import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyAppAndPluginContent,
  copyIncludedFiles,
} from "@/build/copy-build-content";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "junior-copy-build-content-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

function writePackage(
  root: string,
  packageName: string,
  options: { entryPoint?: boolean } = {},
): string {
  const packageDir = path.join(root, "node_modules", ...packageName.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  const entryPoint = options.entryPoint ?? true;
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: packageName,
      ...(entryPoint ? { main: "index.js" } : {}),
    }),
    "utf8",
  );
  if (entryPoint) {
    fs.writeFileSync(path.join(packageDir, "index.js"), "export {};\n", "utf8");
  }
  return packageDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("copyIncludedFiles", () => {
  it("copies configured package files into node_modules output", () => {
    const cwd = process.cwd();
    const serverRoot = makeTempDir();

    copyIncludedFiles(cwd, serverRoot, ["yaml/package.json"]);

    expect(
      fs.existsSync(
        path.join(serverRoot, "node_modules", "yaml", "package.json"),
      ),
    ).toBe(true);
  });

  it("fails when a configured package cannot be resolved", () => {
    const cwd = process.cwd();
    const serverRoot = makeTempDir();

    expect(() =>
      copyIncludedFiles(cwd, serverRoot, ["@acme/missing-plugin/dist/*.js"]),
    ).toThrow(
      'includeFiles entry "@acme/missing-plugin/dist/*.js" references package "@acme/missing-plugin", but it could not be resolved',
    );
  });

  it("fails when includeFiles is not an array", () => {
    const cwd = process.cwd();
    const serverRoot = makeTempDir();

    expect(() =>
      copyIncludedFiles(cwd, serverRoot, "yaml/package.json"),
    ).toThrow("includeFiles must be an array of package subpath patterns");
  });

  it("fails when an includeFiles entry is not a string pattern", () => {
    const cwd = process.cwd();
    const serverRoot = makeTempDir();

    expect(() => copyIncludedFiles(cwd, serverRoot, [42])).toThrow(
      "includeFiles entries must be package subpath patterns",
    );
  });

  it("fails when a configured include pattern matches no files", () => {
    const cwd = process.cwd();
    const serverRoot = makeTempDir();

    expect(() =>
      copyIncludedFiles(cwd, serverRoot, ["yaml/dist/no-such-file.js"]),
    ).toThrow(
      'includeFiles entry "yaml/dist/no-such-file.js" did not match any files',
    );
  });

  it("fails when a configured include pattern has no package subpath", () => {
    const cwd = process.cwd();
    const serverRoot = makeTempDir();

    expect(() => copyIncludedFiles(cwd, serverRoot, ["yaml"])).toThrow(
      'includeFiles entry "yaml" must include a package subpath',
    );
  });

  it("fails when a configured include pattern has a malformed package name", () => {
    const cwd = process.cwd();
    const serverRoot = makeTempDir();

    expect(() => copyIncludedFiles(cwd, serverRoot, ["@/dist/*.js"])).toThrow(
      'includeFiles entry "@/dist/*.js" must include a package subpath',
    );
  });

  it("resolves configured packages from the app root", () => {
    const cwd = makeTempDir();
    const serverRoot = makeTempDir();
    const packageDir = writePackage(cwd, "@acme/local-provider");
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "dist", "provider.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "app" }),
      "utf8",
    );

    copyIncludedFiles(cwd, serverRoot, ["@acme/local-provider/dist/*.js"]);

    expect(
      fs.readFileSync(
        path.join(
          serverRoot,
          "node_modules",
          "@acme",
          "local-provider",
          "dist",
          "provider.js",
        ),
        "utf8",
      ),
    ).toBe("export {};\n");
  });

  it("fails when a matched include pattern copies no existing files", () => {
    const cwd = makeTempDir();
    const serverRoot = makeTempDir();
    const packageDir = writePackage(cwd, "@acme/broken-provider");
    const distDir = path.join(packageDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.symlinkSync(
      path.join(distDir, "missing.js"),
      path.join(distDir, "broken.js"),
    );

    expect(() =>
      copyIncludedFiles(cwd, serverRoot, ["@acme/broken-provider/dist/*.js"]),
    ).toThrow(
      'includeFiles entry "@acme/broken-provider/dist/*.js" matched files',
    );
  });

  it("resolves configured packages from ancestor node_modules without a package entry point", () => {
    const workspaceRoot = makeTempDir();
    const cwd = path.join(workspaceRoot, "apps", "example");
    const serverRoot = makeTempDir();
    const packageDir = writePackage(workspaceRoot, "@acme/content-provider", {
      entryPoint: false,
    });
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "dist", "provider.js"),
      "export {};\n",
      "utf8",
    );
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "example",
        dependencies: {
          "@acme/content-provider": "1.0.0",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "workspace", private: true }),
      "utf8",
    );

    copyIncludedFiles(cwd, serverRoot, ["@acme/content-provider/dist/*.js"]);

    expect(
      fs.readFileSync(
        path.join(
          serverRoot,
          "node_modules",
          "@acme",
          "content-provider",
          "dist",
          "provider.js",
        ),
        "utf8",
      ),
    ).toBe("export {};\n");
  });
});

describe("copyAppAndPluginContent", () => {
  it("copies configured plugin packages resolved from ancestor node_modules", () => {
    const workspaceRoot = makeTempDir();
    const cwd = path.join(workspaceRoot, "apps", "example");
    const serverRoot = makeTempDir();
    const packageDir = writePackage(workspaceRoot, "@acme/ancestor-plugin", {
      entryPoint: false,
    });

    fs.mkdirSync(path.join(packageDir, "skills", "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "plugin.yaml"),
      "name: ancestor\ndescription: Ancestor plugin\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageDir, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
      "utf8",
    );
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "example",
        dependencies: {
          "@acme/ancestor-plugin": "1.0.0",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "workspace", private: true }),
      "utf8",
    );

    copyAppAndPluginContent(cwd, serverRoot, ["@acme/ancestor-plugin"]);

    expect(
      fs.existsSync(
        path.join(
          serverRoot,
          "node_modules",
          "@acme",
          "ancestor-plugin",
          "plugin.yaml",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          serverRoot,
          "node_modules",
          "@acme",
          "ancestor-plugin",
          "skills",
          "demo",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
  });
});
