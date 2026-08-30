import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

const TEST_IP_HEADER = "x-paperpilot-auth-test-ip";
process.env.PAPERPILOT_IP_ADDRESS_HEADERS = TEST_IP_HEADER;

const [{ auth }, { prisma }] = await Promise.all([
  import("@/lib/auth"),
  import("@/lib/prisma"),
]);

after(async () => {
  await prisma.$disconnect();
});

function invalidNameSignupRequest(email: string, testIp: string): Request {
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000").origin;
  return new Request(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: origin,
      [TEST_IP_HEADER]: testIp,
    },
    body: JSON.stringify({
      name: "A",
      email,
      password: "valid-test-password-42",
    }),
  });
}

test("invalid signup names cannot enumerate an existing account", async () => {
  const suffix = randomUUID();
  const existingEmail = `signup-enumeration-existing-${suffix}@example.test`;
  const absentEmail = `signup-enumeration-absent-${suffix}@example.test`;
  const testIp = `198.51.100.${(Number.parseInt(suffix.slice(0, 2), 16) % 250) + 1}`;
  const rateLimitKey = `${testIp}|/sign-up/email`;
  const existing = await prisma.user.create({
    data: {
      id: `signup-enumeration-${suffix}`,
      name: "Existing Signup Fixture",
      email: existingEmail,
      emailVerified: true,
    },
  });

  try {
    const existingResponse = await auth.handler(invalidNameSignupRequest(existingEmail, testIp));
    const absentResponse = await auth.handler(invalidNameSignupRequest(absentEmail, testIp));
    const existingBody = await existingResponse.text();
    const absentBody = await absentResponse.text();

    assert.equal(existingResponse.status, 400);
    assert.equal(absentResponse.status, 400);
    assert.equal(existingBody, absentBody);
    assert.match(existingBody, /INVALID_NAME/);
    assert.equal(await prisma.user.findUnique({ where: { email: absentEmail } }), null);
  } finally {
    await prisma.user.delete({ where: { id: existing.id } }).catch(() => undefined);
    await prisma.rateLimit.deleteMany({ where: { key: rateLimitKey } });
  }
});

