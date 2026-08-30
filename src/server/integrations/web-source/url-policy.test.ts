import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizePublicWebSourceUrl,
  canonicalizeWebSourcePolicyOrigin,
  canonicalizeWebSourcePolicyPathPrefix,
  isPublicWebSourceAddress,
  requirePublicWebSourceAddresses,
  WebSourceUrlPolicyError,
  webSourceUrlMatchesPolicy,
} from "./url-policy";

function rejectsCode(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof WebSourceUrlPolicyError);
    assert.equal(error.code, code);
    return true;
  });
}

test("canonical source URLs require public credential-free HTTPS origins", () => {
  assert.deepEqual(
    canonicalizePublicWebSourceUrl("https://EXAMPLE.org:443/papers/a.pdf?download=1"),
    {
      url: "https://example.org/papers/a.pdf?download=1",
      origin: "https://example.org",
      hostname: "example.org",
      pathname: "/papers/a.pdf",
      pathAndQuery: "/papers/a.pdf?download=1",
    },
  );

  for (const value of [
    "http://example.org/paper.pdf",
    "ftp://example.org/paper.pdf",
  ]) rejectsCode(() => canonicalizePublicWebSourceUrl(value), "https_required");
  rejectsCode(
    () => canonicalizePublicWebSourceUrl("https://user:secret@example.org/paper.pdf"),
    "credentials_forbidden",
  );
  rejectsCode(
    () => canonicalizePublicWebSourceUrl("https://example.org/paper.pdf#page=2"),
    "fragment_forbidden",
  );
});

test("internal names, IP literals, ambiguous encodings, and noncanonical input fail closed", () => {
  for (const value of [
    "https://localhost/paper.pdf",
    "https://repository.local/paper.pdf",
    "https://service.internal/paper.pdf",
    "https://example.test/paper.pdf",
    "https://127.0.0.1/paper.pdf",
    "https://[::1]/paper.pdf",
    "https://singlelabel/paper.pdf",
  ]) rejectsCode(() => canonicalizePublicWebSourceUrl(value), "public_dns_required");

  for (const value of [
    " https://example.org/paper.pdf",
    "https://example.org\\paper.pdf",
    "https://example.org/a%2fb.pdf",
    "https://example.org/a%5cb.pdf",
    "https://example.org/%2e%2e/private.pdf",
    "https://example.org/a%0db.pdf",
  ]) rejectsCode(
    () => canonicalizePublicWebSourceUrl(value),
    value.startsWith(" ") ? "invalid_url" : "ambiguous_path_forbidden",
  );
});

test("policy origins and path prefixes are canonical and boundary matched", () => {
  assert.equal(
    canonicalizeWebSourcePolicyOrigin("https://REPOSITORY.example.org:443/"),
    "https://repository.example.org",
  );
  assert.equal(canonicalizeWebSourcePolicyPathPrefix("/articles/"), "/articles");
  assert.equal(canonicalizeWebSourcePolicyPathPrefix("/"), "/");
  rejectsCode(
    () => canonicalizeWebSourcePolicyOrigin("https://example.org/articles"),
    "invalid_url",
  );
  for (const value of ["articles", "/a?x=1", "/a#b", "/a%2fb", "/a/../b"]) {
    rejectsCode(() => canonicalizeWebSourcePolicyPathPrefix(value), "invalid_policy_path");
  }

  const allowed = canonicalizePublicWebSourceUrl(
    "https://repository.example.org/articles/2026/paper.pdf",
  );
  const sibling = canonicalizePublicWebSourceUrl(
    "https://repository.example.org/articles-archive/paper.pdf",
  );
  const foreign = canonicalizePublicWebSourceUrl(
    "https://cdn.example.org/articles/2026/paper.pdf",
  );
  const boundary = {
    origin: "https://repository.example.org",
    pathPrefix: "/articles",
  };
  assert.equal(webSourceUrlMatchesPolicy(allowed, boundary), true);
  assert.equal(webSourceUrlMatchesPolicy(sibling, boundary), false);
  assert.equal(webSourceUrlMatchesPolicy(foreign, boundary), false);
});

test("only globally routable IP results are admitted", () => {
  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ]) assert.equal(isPublicWebSourceAddress(address), true, address);

  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:0808:0808::1",
  ]) assert.equal(isPublicWebSourceAddress(address), false, address);

  assert.deepEqual(requirePublicWebSourceAddresses(["8.8.8.8"]), ["8.8.8.8"]);
  rejectsCode(
    () => requirePublicWebSourceAddresses(["8.8.8.8", "127.0.0.1"]),
    "private_address_forbidden",
  );
  rejectsCode(() => requirePublicWebSourceAddresses([]), "private_address_forbidden");
});
