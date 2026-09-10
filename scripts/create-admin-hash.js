import { randomBytes, scryptSync } from 'node:crypto';

const password = process.env.ADMIN_PASSWORD || process.argv[2];
if (!password || password.length < 12) {
  console.error('Provide an admin password of at least 12 characters via ADMIN_PASSWORD or the first argument.');
  process.exitCode = 1;
} else {
  const salt = randomBytes(16).toString('base64url');
  const cost = 16_384;
  const blockSize = 8;
  const parallelization = 1;
  const digest = scryptSync(password, salt, 64, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 32 * 1024 * 1024
  }).toString('base64url');
  console.log(`scrypt$${cost}$${blockSize}$${parallelization}$${salt}$${digest}`);
}
