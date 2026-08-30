import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_UPLOAD_LEASE_TTL_MS,
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_CONCURRENT_PER_USER,
  DEFAULT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE,
  DEFAULT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE,
  DEFAULT_UPLOAD_SESSION_TTL_MS,
  DEFAULT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_UPLOAD_STREAM_IDLE_TIMEOUT_MS,
  uploadConfigurationFromEnvironment,
  uploadPolicyConfigurationFromEnvironment,
} from "./config";

const WORKING_DIRECTORY = path.join(os.tmpdir(), "paperpilot-upload-config-workspace");
const PRIVATE_ROOT = path.join(os.tmpdir(), "paperpilot-upload-config-private");

describe("upload configuration", () => {
  it("loads the serverless control-plane policy in production without a local root", () => {
    const policy = uploadPolicyConfigurationFromEnvironment({
      NODE_ENV: "production",
      PAPERPILOT_UPLOAD_MAX_BYTES: "1048576",
    });

    assert.equal(policy.maxUploadBytes, 1_048_576);
    assert.equal(policy.sessionTtlMs, DEFAULT_UPLOAD_SESSION_TTL_MS);
    assert.equal("quarantineRoot" in policy, false);
    assert.equal("streamIdleTimeoutMs" in policy, false);
  });

  it("uses conservative local defaults under .paperpilot-data", () => {
    const configuration = uploadConfigurationFromEnvironment(
      { NODE_ENV: "development" },
      WORKING_DIRECTORY,
    );

    assert.equal(
      configuration.quarantineRoot,
      path.resolve(WORKING_DIRECTORY, ".paperpilot-data", "quarantine"),
    );
    assert.equal(configuration.maxUploadBytes, DEFAULT_UPLOAD_MAX_BYTES);
    assert.equal(configuration.sessionTtlMs, DEFAULT_UPLOAD_SESSION_TTL_MS);
    assert.equal(configuration.leaseTtlMs, DEFAULT_UPLOAD_LEASE_TTL_MS);
    assert.equal(
      configuration.streamIdleTimeoutMs,
      DEFAULT_UPLOAD_STREAM_IDLE_TIMEOUT_MS,
    );
    assert.equal(
      configuration.streamAbsoluteTimeoutMs,
      DEFAULT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_MS,
    );
    assert.equal(
      configuration.maxConcurrentUploadsPerUser,
      DEFAULT_UPLOAD_MAX_CONCURRENT_PER_USER,
    );
    assert.equal(
      configuration.maxConcurrentUploadsPerWorkspace,
      DEFAULT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE,
    );
    assert.equal(
      configuration.maxRetainedBytesPerWorkspace,
      DEFAULT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE,
    );
  });

  it("fails closed in production without one explicit pre-provisioned private root", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paperpilot-config-production-"));
    const workingDirectory = path.join(parent, "workspace");
    const privateRoot = path.join(parent, "private-quarantine");
    await mkdir(workingDirectory);
    await mkdir(privateRoot);
    try {
      assert.throws(() =>
        uploadConfigurationFromEnvironment({ NODE_ENV: "production" }, workingDirectory),
      );
      assert.throws(() =>
        uploadConfigurationFromEnvironment({
          NODE_ENV: "production",
          PAPERPILOT_UPLOAD_QUARANTINE_ROOT: "relative/quarantine",
        }, workingDirectory),
      );
      assert.throws(() =>
        uploadConfigurationFromEnvironment({
          NODE_ENV: "production",
          PAPERPILOT_UPLOAD_QUARANTINE_ROOT: path.join(workingDirectory, "public", "files"),
        }, workingDirectory),
      );
      assert.throws(() =>
        uploadConfigurationFromEnvironment({
          NODE_ENV: "production",
          PAPERPILOT_UPLOAD_QUARANTINE_ROOT: path.join(parent, "missing"),
        }, workingDirectory),
      );
      assert.throws(() =>
        uploadConfigurationFromEnvironment({
          NODE_ENV: "production",
          PAPERPILOT_UPLOAD_QUARANTINE_ROOT: path.parse(privateRoot).root,
        }, workingDirectory),
      );

      assert.equal(
        uploadConfigurationFromEnvironment({
          NODE_ENV: "production",
          PAPERPILOT_UPLOAD_QUARANTINE_ROOT: privateRoot,
        }, workingDirectory).quarantineRoot,
        path.resolve(privateRoot),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects served build trees and canonical junction or symlink aliases", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paperpilot-config-alias-"));
    const workingDirectory = path.join(parent, "workspace");
    const publicQuarantine = path.join(workingDirectory, "public", "quarantine");
    const nextStaticQuarantine = path.join(
      workingDirectory,
      ".next",
      "static",
      "quarantine",
    );
    const alias = path.join(parent, "served-alias");
    await mkdir(publicQuarantine, { recursive: true });
    await mkdir(nextStaticQuarantine, { recursive: true });
    await symlink(
      path.join(workingDirectory, "public"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      for (const quarantineRoot of [
        nextStaticQuarantine,
        path.join(alias, "quarantine"),
      ]) {
        assert.throws(() => uploadConfigurationFromEnvironment({
          NODE_ENV: "production",
          PAPERPILOT_UPLOAD_QUARANTINE_ROOT: quarantineRoot,
        }, workingDirectory));
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("parses every configured limit as a canonical positive safe integer", () => {
    const configuration = uploadConfigurationFromEnvironment({
      NODE_ENV: "test",
      PAPERPILOT_UPLOAD_QUARANTINE_ROOT: PRIVATE_ROOT,
      PAPERPILOT_UPLOAD_MAX_BYTES: "1024",
      PAPERPILOT_UPLOAD_SESSION_TTL_SECONDS: "120",
      PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS: "60",
      PAPERPILOT_UPLOAD_STREAM_IDLE_TIMEOUT_SECONDS: "10",
      PAPERPILOT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_SECONDS: "30",
      PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_USER: "3",
      PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE: "5",
      PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE: "4096",
    }, WORKING_DIRECTORY);

    assert.deepEqual(configuration, {
      quarantineRoot: path.resolve(PRIVATE_ROOT),
      maxUploadBytes: 1024,
      sessionTtlMs: 120_000,
      leaseTtlMs: 60_000,
      streamIdleTimeoutMs: 10_000,
      streamAbsoluteTimeoutMs: 30_000,
      maxConcurrentUploadsPerUser: 3,
      maxConcurrentUploadsPerWorkspace: 5,
      maxRetainedBytesPerWorkspace: 4096,
    });

    const names = [
      "PAPERPILOT_UPLOAD_MAX_BYTES",
      "PAPERPILOT_UPLOAD_SESSION_TTL_SECONDS",
      "PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS",
      "PAPERPILOT_UPLOAD_STREAM_IDLE_TIMEOUT_SECONDS",
      "PAPERPILOT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_SECONDS",
      "PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_USER",
      "PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE",
      "PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE",
    ];
    for (const name of names) {
      for (const invalid of ["", "0", "-1", "+1", "01", "1.0", "1e3", " 1", "1 ", "9007199254740992"]) {
        assert.throws(() =>
          uploadConfigurationFromEnvironment({
            NODE_ENV: "test",
            PAPERPILOT_UPLOAD_QUARANTINE_ROOT: PRIVATE_ROOT,
            [name]: invalid,
          }, WORKING_DIRECTORY),
          `${name} unexpectedly accepted ${JSON.stringify(invalid)}`,
        );
      }
    }
  });

  it("rejects internally inconsistent leases, concurrency, and retained limits", () => {
    assert.throws(() => uploadConfigurationFromEnvironment({
      NODE_ENV: "test",
      PAPERPILOT_UPLOAD_QUARANTINE_ROOT: PRIVATE_ROOT,
      PAPERPILOT_UPLOAD_SESSION_TTL_SECONDS: "10",
      PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS: "11",
    }, WORKING_DIRECTORY));
    assert.throws(() => uploadConfigurationFromEnvironment({
      NODE_ENV: "test",
      PAPERPILOT_UPLOAD_QUARANTINE_ROOT: PRIVATE_ROOT,
      PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS: "30",
      PAPERPILOT_UPLOAD_STREAM_IDLE_TIMEOUT_SECONDS: "21",
      PAPERPILOT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_SECONDS: "20",
    }, WORKING_DIRECTORY));
    assert.throws(() => uploadConfigurationFromEnvironment({
      NODE_ENV: "test",
      PAPERPILOT_UPLOAD_QUARANTINE_ROOT: PRIVATE_ROOT,
      PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS: "30",
      PAPERPILOT_UPLOAD_STREAM_IDLE_TIMEOUT_SECONDS: "10",
      PAPERPILOT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_SECONDS: "30",
    }, WORKING_DIRECTORY));
    assert.throws(() => uploadConfigurationFromEnvironment({
      NODE_ENV: "test",
      PAPERPILOT_UPLOAD_QUARANTINE_ROOT: PRIVATE_ROOT,
      PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_USER: "11",
      PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE: "10",
    }, WORKING_DIRECTORY));
    assert.throws(() => uploadConfigurationFromEnvironment({
      NODE_ENV: "test",
      PAPERPILOT_UPLOAD_QUARANTINE_ROOT: PRIVATE_ROOT,
      PAPERPILOT_UPLOAD_MAX_BYTES: "100",
      PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE: "99",
    }, WORKING_DIRECTORY));
    assert.throws(() => uploadConfigurationFromEnvironment({
      NODE_ENV: "test",
      PAPERPILOT_UPLOAD_QUARANTINE_ROOT: PRIVATE_ROOT,
      PAPERPILOT_UPLOAD_SESSION_TTL_SECONDS: String(
        Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1,
      ),
    }, WORKING_DIRECTORY));
  });
});
